#!/usr/bin/env node
// githippo CLI: serve | http | hook <event> | statusline | install | init | doctor | demo | bench
import { mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, createBrain, instructions, VERSION } from "./server.js";
import { loadConfig, CONFIG_FILE, HOME_DIR } from "./config.js";
import { preCompact, postCompact, sessionStart, promptRecall, readStdin, cleanupOld, statusLine } from "./hooks.js";
import { createHttpApp } from "./http.js";

const [cmd = "serve", ...rest] = process.argv.slice(2);
const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

async function serve() {
  const brain = createBrain(process.env, { source: "local" });
  await timeout(brain.loadCore().catch(() => {}), 4000); // core goes into the instructions
  await buildServer(brain).connect(new StdioServerTransport());
  brain.index.sync().catch((e) => console.error("[githippo] index:", e.message));
}

async function http() {
  const cfg = loadConfig();
  const brain = createBrain(process.env, { source: "remote" });
  await timeout(brain.loadCore().catch(() => {}), 5000);
  const port = Number(process.env.PORT || 8787);
  createHttpApp(brain, { secret: cfg.MCP_SECRET }).listen(port, () => {
    console.log(`[githippo] v${VERSION} on :${port} · embeddings ${brain.index.embedder?.id || "off"}`);
    brain.index.sync().catch((e) => console.error("[githippo] index:", e.message));
  });
}

async function hook(event) {
  // Hooks never fail the session.
  try {
    const input = await readStdin();
    const cfg = loadConfig();
    let out = "";
    const repoBrain = () => (cfg.GITHUB_TOKEN && cfg.MEMORY_REPO ? createBrain(process.env, { source: event }) : null);
    if (event === "precompact") {
      out = await preCompact(input, { brain: repoBrain() });
      await cleanupOld();
    } else if (event === "postcompact") {
      out = await postCompact(input, { brain: repoBrain() });
    } else if (event === "session-start") {
      out = await sessionStart(input);
    } else if (event === "prompt") {
      out = await promptRecall(input, { cacheDir: cfg.CACHE_DIR });
    }
    if (out) process.stdout.write(out);
  } catch (e) {
    console.error(`[githippo] ${event} hook: ${e.message}`);
  }
  process.exit(0);
}

async function statusline() {
  try {
    const out = await statusLine(await readStdin(), { cacheDir: loadConfig().CACHE_DIR });
    if (out) process.stdout.write(out);
  } catch {}
  process.exit(0);
}

const HOOKS = {
  PreCompact: "githippo hook precompact",
  PostCompact: "githippo hook postcompact",
  SessionStart: "githippo hook session-start",
  UserPromptSubmit: "githippo hook prompt",
};

/**
 * Register the MCP server with alwaysLoad (lesson from token-savior: without it, Claude Code may hide the
 * tools behind ToolSearch and the model never calls them). Falls back cleanly on CLIs that reject the key.
 */
function registerMcp() {
  const run = (json) => execFileSync("claude", ["mcp", "add-json", "githippo", JSON.stringify(json), "--scope", "user"], { stdio: "pipe" });
  try {
    execFileSync("claude", ["mcp", "get", "githippo"], { stdio: "pipe" });
    return "already registered";
  } catch {}
  const base = { type: "stdio", command: "githippo", args: ["serve"] };
  try {
    run({ ...base, alwaysLoad: true });
    return "registered (alwaysLoad)";
  } catch {
    try {
      run(base);
      return "registered (this Claude Code version ignores alwaysLoad)";
    } catch (e) {
      return `not registered (${String(e.message).split("\n")[0]}); run: claude mcp add githippo --scope user -- githippo serve`;
    }
  }
}

async function install() {
  const configOnly = rest.includes("--config-only");
  const cfg = loadConfig();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
  const file = { ...JSON.parse(await readFile(CONFIG_FILE, "utf8").catch(() => "{}")) };
  file.MEMORY_REPO = await ask("Memory repo (owner/name, private!)", cfg.MEMORY_REPO);
  file.GITHUB_TOKEN = (await ask("GitHub fine-grained token (Contents: read/write, this repo only)", cfg.GITHUB_TOKEN ? "keep existing" : "")) === "keep existing" ? cfg.GITHUB_TOKEN : file.GITHUB_TOKEN || (await ask("Token", ""));
  file.EMBEDDINGS = await ask("Embeddings: local | voyage | none", cfg.EMBEDDINGS || "local");
  rl.close();
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(file, null, 2));
  await chmod(CONFIG_FILE, 0o600);

  if (configOnly) {
    console.log(`\n✓ config → ${CONFIG_FILE} (chmod 600). Hooks and MCP come from the Claude Code plugin.\n`);
    return;
  }
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  await copyFile(settingsPath, `${settingsPath}.githippo-backup`).catch(() => {});
  settings.hooks ??= {};
  for (const [event, command] of Object.entries(HOOKS)) {
    settings.hooks[event] ??= [];
    const has = settings.hooks[event].some((g) => g.hooks?.some((h) => h.command?.startsWith("githippo hook")));
    if (!has) settings.hooks[event].push({ hooks: [{ type: "command", command, timeout: event === "PreCompact" ? 15 : 5 }] });
  }
  let status = "kept your existing status line";
  if (!settings.statusLine) {
    settings.statusLine = { type: "command", command: "githippo statusline" };
    status = "added";
  }
  await mkdir(join(homedir(), ".claude"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`\n✓ config → ${CONFIG_FILE} (chmod 600)\n✓ hooks → ${settingsPath} (backup saved)\n✓ status line: ${status}\n✓ MCP: ${registerMcp()}\n\nNext:\n  githippo init     # seed the repo\n  githippo doctor   # verify\n`);
}

async function init() {
  const brain = createBrain(process.env);
  const seeds = {
    "core.md": "---\nname: core\ntitle: Core memory\ntype: core\ndescription: Pinned facts injected into every session. Keep it short.\n---\n\n",
    "index.md": "---\nname: index\ndescription: Table of contents. Rebuild with maintain reindex=true.\n---\n\n",
    "inbox.md": "---\nname: inbox\ntitle: Inbox\ntype: inbox\ndescription: Facts that didn't match an entity yet\n---\n\n",
  };
  for (const [p, c] of Object.entries(seeds)) {
    const r = await brain.store.write(p, c, "new", "init").catch((e) => ({ skipped: e.message }));
    console.log(r.skipped ? `· ${p} exists` : `✓ ${p}`);
  }
}

async function doctor() {
  const cfg = loadConfig();
  const ok = (b, m) => console.log(`${b ? "✓" : "✗"} ${m}`);
  ok(!!cfg.GITHUB_TOKEN, "GITHUB_TOKEN set");
  ok(/^[\w.-]+\/[\w.-]+$/.test(cfg.MEMORY_REPO || ""), `MEMORY_REPO ${cfg.MEMORY_REPO || "(missing)"}`);
  if (!cfg.GITHUB_TOKEN || !cfg.MEMORY_REPO) return;
  const res = await fetch(`https://api.github.com/repos/${cfg.MEMORY_REPO}`, { headers: { Authorization: `Bearer ${cfg.GITHUB_TOKEN}` } });
  const repo = await res.json().catch(() => ({}));
  ok(res.ok, `repo reachable (${res.status})`);
  if (res.ok) {
    ok(repo.private, repo.private ? "repo is private" : "repo is PUBLIC — make it private before storing memory");
    ok(repo.permissions?.push !== false, "token can write");
  }
  const brain = createBrain(process.env);
  const t0 = Date.now();
  await brain.index.sync({ maxAgeMs: 0 }).then(
    () => ok(true, `indexed ${brain.index.files.size} files, ${brain.index.chunks?.length || 0} chunks in ${Date.now() - t0} ms (${brain.index.embedder?.id || "keyword only"})`),
    (e) => ok(false, `index: ${e.message}`),
  );
  await brain.loadCore();
  ok(true, `core memory ~${Math.ceil(brain.core.length / 4)}/${cfg.CORE_BUDGET_TOKENS} tokens`);
  const settings = await readFile(join(homedir(), ".claude", "settings.json"), "utf8").catch(() => "");
  ok(settings.includes("githippo hook precompact"), "Claude Code compaction hooks installed");
}

/** Try githippo in 30 seconds: no repo, no token (idea from agentmemory's demo). */
async function demo() {
  const { InMemoryStore } = await import("./memstore.js");
  const { MemoryIndex } = await import("./search.js");
  const { createEmbedder } = await import("./embed.js");
  const { Brain } = await import("./brain.js");
  const { fmt } = await import("./format.js");
  const store = new InMemoryStore();
  const seed = {
    "people/sam-okafor.md": "---\nname: sam-okafor\ntitle: Sam Okafor\ndescription: Tech lead, payments\naliases: [Sam]\n---\n\n- Tech lead for the payments team\n",
    "projects/billing-v2.md": "---\nname: billing-v2\ntitle: Billing v2\ndescription: Billing rewrite\n---\n\n- owner:: [[sam-okafor]]\n- Launch target is end of Q1\n",
    "projects/johnny.md": "---\nname: johnny\ntitle: Johnny\ndescription: Voice assistant for the Mac\n---\n\n- Needs a wake word and runs locally on the Mac mini\n",
  };
  for (const [p, c] of Object.entries(seed)) await store.write(p, c, "new", "seed");
  const emb = createEmbedder(loadConfig());
  const brain = new Brain({ store, index: new MemoryIndex(store, emb, {}) });
  const show = (label, text) => console.log(`\n\x1b[35m${label}\x1b[0m\n${text}`);
  console.log(`githippo demo · in-memory vault · embeddings: ${emb?.id || "keyword only"}${emb?.id?.startsWith("local") ? " (first run downloads the model)" : ""}`);
  show('› remember "Launch target is end of Q2"', fmt.remember(await brain.remember("Launch target is end of Q2")));
  show('› remember "The launch target is the end of Q2"   (same fact, reworded)', fmt.remember(await brain.remember("The launch target is the end of Q2")));
  show('› remember "Sam prefers written RFCs over meetings"', fmt.remember(await brain.remember("Sam prefers written RFCs over meetings")));
  show('› recall "¿Qué necesita el asistente de voz?"   (Spanish question, English notes)', fmt.recall(await brain.recall("¿Qué necesita el asistente de voz?", { mode: "brief" })));
  show("› graph sam", fmt.graph(await brain.neighbors("sam")));
  show("› maintain", fmt.maintain(await brain.maintain({})));
  console.log(`\nThat's githippo. Your real memory lives in your own private repo: githippo install\n`);
}

async function bench() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const brain = { core: "", index: {}, store: {}, loadCore: async () => "" };
  const server = buildServer(brain);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "bench", version: "1" });
  await client.connect(b);
  const { tools } = await client.listTools();
  // What the model actually sees: name, description, input schema.
  const visible = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }))).length;
  const instr = instructions("").length;
  console.log(`tools: ${tools.length}\nmodel-visible schema: ~${Math.round(visible / 3.6)} tokens per turn\ninstructions: ~${Math.round(instr / 3.8)} tokens + core`);
  await client.close();
}

const commands = { serve, http, hook: () => hook(rest[0]), statusline, install, init, doctor, demo, bench };
if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else if (!commands[cmd]) {
  console.log(`githippo ${VERSION}\nusage: githippo [serve|http|hook <precompact|postcompact|session-start|prompt>|statusline|install [--config-only]|init|doctor|demo|bench]`);
  process.exit(1);
} else await commands[cmd]();
