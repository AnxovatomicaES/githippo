#!/usr/bin/env node
// githippo CLI: setup | sync | serve | http | hook <event> | statusline | install | init | doctor | demo | warm | bench
import { mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, createBrain, instructions, VERSION } from "./server.js";
import { loadConfig, CONFIG_FILE, HOME_DIR } from "./config.js";
import { preCompact, postCompact, sessionEnd, sessionStart, promptRecall, readStdin, cleanupOld, statusLine } from "./hooks.js";
import { createHttpApp } from "./http.js";

const [cmd = "serve", ...rest] = process.argv.slice(2);
const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

/** B26: a missing or bad config is a one-line instruction, not a stack trace. */
function brainOrExit(source) {
  try {
    return createBrain(process.env, { source });
  } catch (e) {
    console.error(`githippo is not configured: ${e.message}\nRun \`githippo install\` (or set GITHUB_TOKEN and MEMORY_REPO).`);
    process.exit(1);
  }
}

async function serve() {
  const brain = brainOrExit("local");
  if (brain.store.ensure) await brain.store.ensure();
  if (brain.store.pull) {
    await timeout(brain.store.pull().catch(() => {}), 5000); // other devices' changes
    setInterval(() => brain.store.pull().catch(() => {}), 5 * 60_000).unref();
  }
  await timeout(brain.loadCore().catch(() => {}), 4000); // core goes into the instructions
  await buildServer(brain).connect(new StdioServerTransport());
  brain.index.sync().catch((e) => console.error("[githippo] index:", e.message));
}

async function http() {
  const cfg = loadConfig();
  const brain = brainOrExit("remote");
  await timeout(brain.loadCore().catch(() => {}), 5000);
  const port = Number(process.env.PORT || 8787);
  const { Accounts } = await import("./accounts.js");
  const { signingKey } = await import("./oauth.js");
  const accounts = Accounts.load({ file: join(HOME_DIR, "users.json") });
  const legacy = process.env.LEGACY_SECRET_URL === "1";
  if (legacy) console.warn("[githippo] LEGACY_SECRET_URL=1: the secret is accepted in the URL path, where proxies may log it. Prefer OAuth.");
  createHttpApp(brain, { secret: cfg.MCP_SECRET, key: signingKey(process.env), accounts, publicUrl: process.env.PUBLIC_URL || null, legacySecretUrl: legacy }).listen(port, () => {
    console.log(`[githippo] v${VERSION} on :${port} · auth: OAuth 2.1${accounts.multiUser ? ` (${accounts.users.size} users)` : " (owner)"} · embeddings ${brain.index.embedder?.id || "off"}`);
    brain.index.sync().catch((e) => console.error("[githippo] index:", e.message));
  });
}

async function hook(event) {
  // Hooks never fail the session.
  try {
    const input = await readStdin();
    const cfg = loadConfig();
    let out = "";
    const repoBrain = () => {
      try {
        return createBrain(process.env, { source: event });
      } catch {
        return null;
      }
    };
    if (event === "precompact") {
      out = await preCompact(input, { brain: repoBrain() });
      await cleanupOld();
    } else if (event === "postcompact") {
      out = await postCompact(input, { brain: repoBrain() });
    } else if (event === "session-end") {
      out = await sessionEnd(input, { brain: repoBrain() });
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
  SessionEnd: "githippo hook session-end",
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

// Kept for scripted/advanced use (explicit GitHub API mode with a token). Most people want `setup`.
async function install() {
  const configOnly = rest.includes("--config-only");
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const cfg = loadConfig();
  const file = { ...JSON.parse(await readFile(CONFIG_FILE, "utf8").catch(() => "{}")) };
  const interactive = process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def, { secret = false } = {}) => {
    if (!rl) return def;
    if (secret) {
      // B19: don't echo the token to the terminal (or into scrollback)
      const write = rl._writeToOutput?.bind(rl);
      rl._writeToOutput = (str) => (/\n|\r|:\s*$/.test(str) ? write?.(str) : write?.("*".repeat(str.length)));
      const a = (await rl.question(`${q}: `)).trim();
      rl._writeToOutput = write;
      process.stdout.write("\n");
      return a || def;
    }
    return (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
  };
  file.MEMORY_REPO = flag("repo") || (await ask("Memory repo (owner/name, private!)", cfg.MEMORY_REPO));
  // B19: whatever is typed becomes the token; Enter keeps the existing one. Non-interactive: --token-env NAME.
  const fromEnv = flag("token-env") && process.env[flag("token-env")];
  const keep = cfg.GITHUB_TOKEN ? ` (Enter keeps the current one, …${cfg.GITHUB_TOKEN.slice(-4)})` : "";
  file.GITHUB_TOKEN = fromEnv || (await ask(`GitHub fine-grained token${keep}`, cfg.GITHUB_TOKEN, { secret: true }));
  file.EMBEDDINGS = flag("embeddings") || (await ask("Embeddings: local | voyage | none", cfg.EMBEDDINGS || "local"));
  rl?.close();
  if (!/^[\w.-]+\/[\w.-]+$/.test(file.MEMORY_REPO || "") || !file.GITHUB_TOKEN) {
    console.error(`Missing ${!file.GITHUB_TOKEN ? "token" : "repo"}. Non-interactive use: githippo install --repo owner/name --token-env GITHUB_TOKEN`);
    process.exit(1);
  }
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);

  if (configOnly) {
    console.log(`\n✓ config → ${CONFIG_FILE} (chmod 600). Hooks and MCP come from the Claude Code plugin.\n`);
    return;
  }
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  } catch {
    console.error(`✗ ${settingsPath} isn't valid JSON, so hooks weren't added. Fix it and run githippo install again.`);
    process.exit(1);
  }
  await copyFile(settingsPath, `${settingsPath}.githippo-backup`).catch(() => {});
  settings.hooks ??= {};
  for (const [event, command] of Object.entries(HOOKS)) {
    settings.hooks[event] ??= [];
    const has = settings.hooks[event].some((g) => g.hooks?.some((h) => h.command?.startsWith("githippo hook")));
    if (!has) settings.hooks[event].push({ hooks: [{ type: "command", command, timeout: ["PreCompact", "SessionEnd"].includes(event) ? 20 : 10 }] });
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

const SEEDS = {
  "core.md": "---\nname: core\ntitle: Core memory\ntype: core\ndescription: Pinned facts injected into every session. Keep it short.\n---\n\n",
  "index.md": "---\nname: index\ndescription: Table of contents. Rebuild with maintain reindex=true.\n---\n\n",
  "inbox.md": "---\nname: inbox\ntitle: Inbox\ntype: inbox\ndescription: Facts that didn't match an entity yet\n---\n\n",
};

async function seed(store, log = console.log) {
  for (const [p, c] of Object.entries(SEEDS)) {
    if (await store.read(p)) continue;
    await store.write(p, c, "new", "init");
    log(`✓ ${p}`);
  }
}

async function init() {
  const brain = brainOrExit("init");
  if (brain.store.ensure) await brain.store.ensure();
  await seed(brain.store);
}

/**
 * One command, zero questions: local vault + hooks + MCP + status line + background model download.
 *   githippo setup                 local vault in ~/.githippo/vault (no GitHub needed)
 *   githippo setup --github [name] also back it up to a private GitHub repo via your gh login
 */
async function setup() {
  const t0 = Date.now();
  const say = (m) => console.log(m);
  const cfg = loadConfig();
  const file = { ...JSON.parse(await readFile(CONFIG_FILE, "utf8").catch(() => "{}")) };
  if (!file.STORE) file.STORE = cfg.STORE;
  file.EMBEDDINGS ??= "local";
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);

  const brain = createBrain(process.env, { source: "setup" });
  if (brain.store.ensure) await brain.store.ensure();
  await seed(brain.store, () => {});
  say(`✓ memory vault   ${file.STORE === "github" ? `github.com/${cfg.MEMORY_REPO}` : loadConfig().VAULT_DIR}`);

  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(join(homedir(), ".claude")) || commandExists("claude")) {
    const r = await wireClaudeCode(settingsPath);
    say(`✓ Claude Code    hooks${r.statusLine ? " + status line" : ""} · MCP ${r.mcp}`);
  } else {
    say("· Claude Code    not found (add the MCP server to your client: command `githippo serve`)");
  }

  if (rest.includes("--github")) {
    const name = rest[rest.indexOf("--github") + 1];
    say(await syncToGitHub(name && !name.startsWith("--") ? name : "githippo-memory"));
  }

  if ((loadConfig().EMBEDDINGS || "local") === "local") {
    const log = join(HOME_DIR, "warm.log");
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "warm"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    child.unref();
    say(`✓ semantic search downloading in the background (keyword search works now) · log: ${log}`);
  }
  say(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s. Restart Claude Code, then just talk: it remembers.`);
  say("Try it without Claude: githippo demo");
}

function commandExists(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function wireClaudeCode(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  } catch {
    return { mcp: "skipped", statusLine: false, error: `${settingsPath} isn't valid JSON` };
  }
  await copyFile(settingsPath, `${settingsPath}.githippo-backup`).catch(() => {});
  settings.hooks ??= {};
  for (const [event, command] of Object.entries(HOOKS)) {
    settings.hooks[event] ??= [];
    const has = settings.hooks[event].some((g) => g.hooks?.some((h) => h.command?.startsWith("githippo hook")));
    if (!has) settings.hooks[event].push({ ...(event === "SessionStart" ? { matcher: "startup|resume|compact|fork" } : {}), hooks: [{ type: "command", command, timeout: ["PreCompact", "SessionEnd"].includes(event) ? 20 : 10 }] });
  }
  let statusLine = false;
  if (!settings.statusLine) {
    settings.statusLine = { type: "command", command: "githippo statusline" };
    statusLine = true;
  }
  await mkdir(join(homedir(), ".claude"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  return { mcp: commandExists("claude") ? registerMcp() : "not registered (claude CLI not found)", statusLine };
}

/** Backs the local vault up to a private GitHub repo using the user's own gh login. No token is stored. */
async function syncToGitHub(name) {
  const cfg = loadConfig();
  const dir = cfg.VAULT_DIR;
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString().trim();
  try {
    if (git("remote")) {
      git("push", "-q", "-u", "origin", "HEAD");
      return `✓ backup         already linked: ${git("remote", "get-url", "origin")}`;
    }
  } catch {}
  if (!commandExists("gh")) {
    return "· backup         install GitHub CLI (`brew install gh`, then `gh auth login`) and run `githippo sync --github`";
  }
  try {
    execFileSync("gh", ["repo", "create", name, "--private", "--source", dir, "--remote", "origin", "--push", "--description", "githippo memory vault (private)"], { stdio: "pipe" });
    return `✓ backup         private repo ${git("remote", "get-url", "origin")} (pushes after each change)`;
  } catch (e) {
    const msg = String(e.stderr || e.message).split("\n")[0];
    return `✗ backup         ${msg}`;
  }
}

async function sync() {
  if (rest.includes("--github")) {
    const name = rest[rest.indexOf("--github") + 1];
    console.log(await syncToGitHub(name && !name.startsWith("--") ? name : "githippo-memory"));
    return;
  }
  const brain = brainOrExit("sync");
  const pulled = brain.store.pull ? await brain.store.pull() : false;
  if (brain.store.git) await brain.store.git(["push", "-q", "origin", "HEAD"], 30_000);
  console.log(pulled ? "✓ synced with remote" : "· no remote; run githippo sync --github to back up to a private repo");
}

/**
 * Multi-user vaults: githippo users add <id> --acl "shared/:write,people/:read" | list | remove <id> | reset <id>
 * Prints a generated password once. Hosts without a disk: paste the users file into USERS_JSON.
 */
async function users() {
  const { Accounts, parseAcl, Acl } = await import("./accounts.js");
  const file = join(HOME_DIR, "users.json");
  const acc = Accounts.load({ env: {}, file });
  const [sub, id] = rest;
  const flag = (n) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  if (sub === "add" || sub === "reset") {
    const acl = sub === "reset" ? acc.get(id)?.acl : parseAcl(flag("acl") ?? ":write");
    if (!acl) return console.error(`No user "${id}".`), process.exit(1);
    const pw = acc.add(id, acl);
    acc.save();
    console.log(`✓ ${id}  password (shown once): ${pw}\n  access: ${acl.map((r) => `${r.path || "(everything)"} ${r.access}`).join(", ")}, plus their own users/${id}/`);
    console.log(`  users file: ${file}${process.env.RENDER ? "" : "  (on Render: set USERS_JSON to its contents)"}`);
  } else if (sub === "remove") {
    console.log(acc.remove(id) ? (acc.save(), `✓ removed ${id} (their tokens stop working immediately)`) : `No user "${id}".`);
  } else {
    if (!acc.multiUser) return console.log("No users yet: the remote server has one owner who signs in with MCP_SECRET.\nAdd people: githippo users add <id> --acl \"shared/:write,people/:read\"");
    for (const u of acc.users.values()) console.log(`${u.id.padEnd(16)} ${new Acl(u).isAdmin ? "admin  " : "       "} ${(u.acl || []).map((r) => `${r.path || "*"}:${r.access}`).join(" ")}`);
  }
}

/** Import from the MCP reference memory server: githippo import <memory.jsonl> */
async function importCmd() {
  const file = rest[0];
  if (!file) return console.error("usage: githippo import <path/to/memory.jsonl>"), process.exit(1);
  const { importReferenceMemory } = await import("./importer.js");
  const brain = brainOrExit("import");
  if (brain.store.ensure) await brain.store.ensure();
  const r = await importReferenceMemory(brain, await readFile(file, "utf8"));
  console.log(`✓ ${r.entities} entities → ${r.facts} facts, ${r.relations} relations` + (r.duplicates ? ` · ${r.duplicates} already known` : "") + (r.blocked ? ` · ${r.blocked} blocked by the secrets guard` : "") + (r.skippedLines ? ` · ${r.skippedLines} unreadable lines skipped` : ""));
}

/** Retrieval-quality benchmark on a labelled vault: githippo eval [--embeddings none|local|voyage] [--json] */
async function evalCmd() {
  const { runEval, formatEval } = await import("../eval/run.js");
  const flag = (n) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  const r = await runEval({ embeddings: flag("embeddings") || loadConfig().EMBEDDINGS || "local" });
  console.log(rest.includes("--json") ? JSON.stringify(r, null, 2) : formatEval(r));
}

/** Downloads the embedding runtime + model once, so semantic recall is instant afterwards. */
async function warm() {
  const { importTransformers, ensureRuntime, createEmbedder } = await import("./embed.js");
  try {
    await importTransformers();
  } catch {
    const ok = await ensureRuntime({ wait: true });
    if (!ok) {
      console.error("✗ couldn't install the embedding runtime; keyword search still works. See ~/.githippo/runtime/install.log");
      process.exit(1);
    }
  }
  const emb = createEmbedder(loadConfig());
  if (emb) await emb.embed(["warm up"], "document");
  console.log(`✓ semantic search ready (${emb?.id})`);
}

async function doctor() {
  const cfg = loadConfig();
  const ok = (b, m) => console.log(`${b ? "✓" : "✗"} ${m}`);
  if (cfg.STORE === "local") {
    const b = brainOrExit("doctor");
    ok(existsSync(cfg.VAULT_DIR), `local vault ${cfg.VAULT_DIR}`);
    ok(await b.store.hasGit(), "vault is a git repo (history + time travel)");
    const remote = (await b.store.git(["remote", "get-url", "origin"])).out;
    ok(true, remote ? `backup → ${remote}` : "no backup yet (optional: githippo sync --github)");
  } else {
    ok(!!cfg.GITHUB_TOKEN, "GITHUB_TOKEN set");
    ok(/^[\w.-]+\/[\w.-]+$/.test(cfg.MEMORY_REPO || ""), `MEMORY_REPO ${cfg.MEMORY_REPO || "(missing)"}`);
  }
  const { importTransformers } = await import("./embed.js");
  const sem = cfg.EMBEDDINGS === "none" ? "off" : await importTransformers().then(() => "ready", () => "downloading (keyword search meanwhile)");
  ok(sem !== "off", `semantic search ${sem}`);
  if (cfg.STORE === "github") {
  const res = await fetch(`https://api.github.com/repos/${cfg.MEMORY_REPO}`, { headers: { Authorization: `Bearer ${cfg.GITHUB_TOKEN}` } });
  const repo = await res.json().catch(() => ({}));
  ok(res.ok, `repo reachable (${res.status})`);
  if (res.ok) {
    ok(repo.private, repo.private ? "repo is private" : "repo is PUBLIC — make it private before storing memory");
    ok(repo.permissions?.push !== false, "token can write");
  }
  }
  const brain = brainOrExit("doctor");
  const t0 = Date.now();
  await brain.index.sync({ maxAgeMs: 0 }).then(
    () => ok(true, `indexed ${brain.index.files.size} files, ${brain.index.chunks?.length || 0} chunks in ${Date.now() - t0} ms (${brain.index.embedder?.id || "keyword only"})`),
    (e) => ok(false, `index: ${e.message}`),
  );
  await brain.loadCore();
  ok(true, `core memory ~${Math.ceil(brain.core.length / 4)}/${cfg.CORE_BUDGET_TOKENS} tokens`);
  const settings = await readFile(join(homedir(), ".claude", "settings.json"), "utf8").catch(() => "");
  const plugin = await readFile(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8").catch(() => "");
  ok(settings.includes("githippo hook precompact") || plugin.includes("githippo"), "Claude Code hooks installed (settings or plugin)");
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

const commands = { setup, sync, warm, users, eval: evalCmd, import: importCmd, serve, http, hook: () => hook(rest[0]), statusline, install, init, doctor, demo, bench };
if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else if (!commands[cmd]) {
  console.log(`githippo ${VERSION}\nusage: githippo setup [--github [repo-name]]   one command, everything
       githippo sync [--github [repo-name]]    back up / sync the vault
       githippo users add <id> --acl "shared/:write,people/:read" | list | remove <id> | reset <id>
       githippo eval [--embeddings none|local|voyage]   retrieval-quality benchmark
       githippo import <memory.jsonl>                     from the MCP reference memory server
       githippo demo | doctor | warm | bench
       githippo serve | http | statusline | hook <event> | install | init`);
  process.exit(1);
} else await commands[cmd]();
