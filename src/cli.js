#!/usr/bin/env node
// githippo CLI: setup | sync | serve | http | hook <event> | statusline | install | init | doctor | demo | warm | bench
import { mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { existsSync, openSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { join, resolve, delimiter, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { VERSION } from "./version.js";
// Start-up cost matters here: Claude Code runs `githippo hook prompt` before every prompt and `githippo statusline` constantly, and
// importing the MCP SDK and zod (via server.js) was ~85 ms of a ~125 ms start. So the server, the HTTP app and the SDK are imported by the
// commands that use them (see `server()` below), never at the top. test/report6.test.js keeps it that way.
import { loadConfig, applyFileConfig, CONFIG_FILE, HOME_DIR, claudeDir, expandHome } from "./config.js";
import { fileURLToPath } from "node:url";
import { preCompact, postCompact, sessionEnd, sessionStart, promptRecall, readStdin, cleanupOld, statusLine } from "./hooks.js";
import { remoteVisibility, publicBackupMessage } from "./remote.js";

const [cmd = "serve", ...restRaw] = process.argv.slice(2);
// "--limit=3" means "--limit 3". Every command reads flags as "--name value", so the "=" form is expanded once, here
// (it used to be silently ignored: `contextualize --limit=3` made 31 paid calls).
const rest = restRaw.flatMap((a) => (/^--[\w-]+=/.test(a) ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));
applyFileConfig();
const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

const server = () => import("./server.js");

/** B26: a missing or bad config is a one-line instruction, not a stack trace. */
async function brainOrExit(source, env = process.env) {
  try {
    return (await server()).createBrain(env, { source });
  } catch (e) {
    console.error(`githippo is not configured: ${e.message}\nRun \`githippo install\` (or set GITHUB_TOKEN and MEMORY_REPO).`);
    process.exit(1);
  }
}

async function serve() {
  const brain = await brainOrExit("local");
  if (brain.store.ensure) await brain.store.ensure();
  if (brain.store.pull) {
    await timeout(brain.store.pull().catch(() => {}), 5000); // other devices' changes
    setInterval(() => brain.store.pull().catch(() => {}), 5 * 60_000).unref();
  }
  await timeout(brain.loadCore().catch(() => {}), 4000); // core goes into the instructions
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await (await server()).buildServer(brain).connect(new StdioServerTransport());
  brain.index.sync().catch((e) => console.error("[githippo] index:", e.message));
}

async function http() {
  const cfg = loadConfig();
  const brain = await brainOrExit("remote");
  const { createHttpApp } = await import("./http.js");
  await timeout(brain.loadCore().catch(() => {}), 5000);
  const port = Number(process.env.PORT || 8787);
  // Last line of defence for a long-running server: log and keep serving, but a crash loop still exits so the
  // host (Render, systemd, Docker) restarts a clean process.
  const faults = [];
  const survive = (kind) => (err) => {
    console.error(`[githippo] ${kind}:`, err?.stack || err);
    const now = Date.now();
    faults.push(now);
    while (faults.length && now - faults[0] > 60_000) faults.shift();
    if (faults.length > 20) process.exit(1);
  };
  process.on("uncaughtException", survive("uncaught exception"));
  process.on("unhandledRejection", survive("unhandled rejection"));
  const { Accounts } = await import("./accounts.js");
  const { signingKey } = await import("./oauth.js");
  const accounts = Accounts.load({ file: join(HOME_DIR, "users.json") });
  const legacy = process.env.LEGACY_SECRET_URL === "1";
  if (legacy) console.warn("[githippo] LEGACY_SECRET_URL=1: the secret is accepted in the URL path, where proxies may log it. Prefer OAuth.");
  createHttpApp(brain, { secret: cfg.MCP_SECRET, key: signingKey(process.env), accounts, publicUrl: process.env.PUBLIC_URL || null, legacySecretUrl: legacy, stateFile: process.env.OAUTH_STATE_FILE || join(HOME_DIR, "oauth-state.json") }).listen(port, () => {
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
    const repoBrain = async () => {
      try {
        return (await server()).createBrain(process.env, { source: event });
      } catch {
        return null;
      }
    };
    if (event === "precompact") {
      out = await preCompact(input, { brain: await repoBrain() });
      await cleanupOld();
    } else if (event === "postcompact") {
      out = await postCompact(input, { brain: await repoBrain() });
    } else if (event === "session-end") {
      out = await sessionEnd(input, { brain: await repoBrain() });
      // CONSOLIDATE=1: review the finished session in the background (needs ANTHROPIC_API_KEY)
      if (process.env.CONSOLIDATE === "1" && input.transcript_path && process.env.ANTHROPIC_API_KEY) {
        spawn(process.execPath, [fileURLToPath(import.meta.url), "consolidate", "--transcript", input.transcript_path], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
      }
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

// seconds; the same values as hooks/hooks.json, so installing by plugin or by `githippo setup` behaves the same.
// UserPromptSubmit runs before every prompt, so it gets the shortest leash.
const HOOK_TIMEOUTS = { PreCompact: 20, PostCompact: 15, SessionEnd: 20, SessionStart: 10, UserPromptSubmit: 5 };

const HOOKS = {
  PreCompact: "hook precompact",
  PostCompact: "hook postcompact",
  SessionEnd: "hook session-end",
  SessionStart: "hook session-start",
  UserPromptSubmit: "hook prompt",
};

// What Claude Code runs. The paths are absolute so a hook or the MCP server still starts when `githippo` isn't on the PATH of whatever
// launched Claude Code (Claude Desktop, an IDE and a GUI-started terminal usually have a shorter PATH than your shell). The launcher tries
// the pinned node and script, then `node` on the PATH (a version manager moved node), then `githippo` on the PATH, and exits 0 without a
// word when none runs (githippo was uninstalled): a hook must never break a session. Paths are arguments, so they need no quoting inside.
const LAUNCHER = "githippo-launch";
const LAUNCH_SH = 'n=$1; c=$2; shift 2; if [ -f "$c" ]; then if [ -x "$n" ]; then exec "$n" "$c" "$@"; fi; if command -v node >/dev/null 2>&1; then exec node "$c" "$@"; fi; fi; if command -v githippo >/dev/null 2>&1; then exec githippo "$@"; fi; exit 0';
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The CLI this process runs from, as an absolute real path; null for a throw-away copy (the npx cache) or when it can't be resolved. */
function selfPath() {
  try {
    const p = realpathSync(fileURLToPath(import.meta.url));
    return /[\\/]_npx[\\/]/.test(p) ? null : p;
  } catch {
    return null;
  }
}

/**
 * The node to pin. process.execPath is the real binary, which a package manager puts in a versioned folder (Homebrew's
 * Cellar/node/25.8.1_1/bin/node) that an upgrade deletes; the same binary reached through a PATH entry (/opt/homebrew/bin/node) survives it.
 */
function stableNode() {
  try {
    const real = realpathSync(process.execPath);
    for (const dir of String(process.env.PATH || "").split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      const p = join(dir, "node");
      try {
        if (realpathSync(p) === real) return p;
      } catch {}
    }
  } catch {}
  return process.execPath;
}

/** argv for `githippo <args>` through the launcher; null on Windows or without a stable path (then the bare PATH form is used). */
function launchArgv(args) {
  const cli = selfPath();
  return cli && process.platform !== "win32" ? ["sh", "-c", LAUNCH_SH, LAUNCHER, stableNode(), cli, ...args.split(" ")] : null;
}

/** The shell command line to put in settings.json for `githippo <args>`. */
function hookCommand(args) {
  const a = launchArgv(args);
  if (a) return `sh -c ${shq(LAUNCH_SH)} ${LAUNCHER} ${shq(a[4])} ${shq(a[5])} ${args}`;
  // no pinned path: the old form, which still works wherever githippo is on the PATH
  return process.platform === "win32" ? `githippo ${args}` : `sh -c 'command -v githippo >/dev/null 2>&1 || exit 0; exec githippo ${args}'`;
}

/** True for a hook or status-line command githippo wrote, in this form or any earlier one. */
const ours = (cmd) => typeof cmd === "string" && /githippo/.test(cmd) && /(?:\bhook (?:precompact|postcompact|session-end|session-start|prompt)|\bstatusline)['"]?\s*$/.test(cmd);

/** Splits a command line the way sh does for the quoting hookCommand writes ('…' with '\'' for a quote). */
function shellWords(s) {
  const out = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur), (cur = ""), (has = false);
      i++;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** The pinned { node, cli } inside a launcher command, or null for the bare form. */
function launchTarget(cmd) {
  const w = typeof cmd === "string" ? shellWords(cmd) : null;
  const i = w ? w.indexOf(LAUNCHER) : -1;
  return i >= 0 && w.length >= i + 3 ? { node: w[i + 1], cli: w[i + 2] } : null;
}

/** The MCP server entry as `claude mcp add-json` takes it, pinned like the hooks; null when there is no pinned form. */
function mcpEntry() {
  const a = launchArgv("serve");
  return a ? { type: "stdio", command: "/bin/sh", args: a.slice(1) } : null; // /bin/sh by path: the point is not to depend on the PATH
}

/**
 * Register the MCP server with alwaysLoad (lesson from token-savior: without it, Claude Code may hide the
 * tools behind ToolSearch and the model never calls them). Falls back cleanly on CLIs that reject the key.
 * An entry an earlier setup wrote (command `githippo`, nothing else configured) is moved to the pinned form;
 * one you customised, or already pinned, is left alone.
 */
function registerMcp() {
  const run = (json) => execFileSync("claude", ["mcp", "add-json", "githippo", JSON.stringify(json), "--scope", "user"], { stdio: "pipe" });
  const bare = { type: "stdio", command: "githippo", args: ["serve"] };
  let had = null;
  try {
    had = execFileSync("claude", ["mcp", "get", "githippo"], { stdio: "pipe" }).toString();
  } catch {}
  let moved = false;
  if (had !== null) {
    const isBare = /^\s*Command:\s*githippo\s*$/m.test(had) && /^\s*Args:\s*serve\s*$/m.test(had) && !/^\s*Environment:/m.test(had);
    if (!isBare || !mcpEntry()) return "already registered";
    try {
      execFileSync("claude", ["mcp", "remove", "githippo", "--scope", "user"], { stdio: "pipe" });
    } catch {
      return "already registered";
    }
    moved = true;
  }
  const base = mcpEntry() || bare;
  const pinned = base !== bare ? ", pinned path" : "";
  try {
    run({ ...base, alwaysLoad: true });
    return `${moved ? "updated" : "registered"} (alwaysLoad${pinned})`;
  } catch {
    try {
      run(base);
      return `${moved ? "updated" : "registered"} (this Claude Code version ignores alwaysLoad${pinned})`;
    } catch (e) {
      if (moved) {
        try {
          run(bare); // never leave an install without its MCP server because the move failed
        } catch {}
      }
      return `not registered (${String(e.message).split("\n")[0]}); run: claude mcp add githippo --scope user -- githippo serve`;
    }
  }
}

// Kept for scripted/advanced use (explicit GitHub API mode with a token). Most people want `setup`.
/** Reads one line from the terminal without echoing it (stars instead), for tokens. */
async function promptSecret(q) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) return "";
  process.stdout.write(`${q}: `);
  return new Promise((resolve) => {
    let s = "";
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.off("data", onData);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(s.trim());
    };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === "\r" || c === "\n" || c === "\u0004") return done();
        if (c === "\u0003") {
          done();
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") {
          if (s.length) {
            s = s.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (c >= " ") {
          s += c;
          process.stdout.write("*");
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

const scrubText = (t) => String(t).replace(/(https?:\/\/)[^@\s/]+@/g, "$1"); // never print credentials embedded in a URL
const firstLine = (t) => String(t).split("\n").find((l) => l.trim())?.trim().slice(0, 160) || "unknown error";

async function install() {
  const configOnly = rest.includes("--config-only");
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const cfg = loadConfig();
  const file = { ...JSON.parse(await readFile(CONFIG_FILE, "utf8").catch(() => "{}")) };
  const interactive = process.stdin.isTTY;
  const ask = async (q, def) => {
    if (!interactive) return def;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
    } finally {
      rl.close();
    }
  };
  file.MEMORY_REPO = flag("repo") || (await ask("Memory repo (owner/name, private!)", file.MEMORY_REPO || cfg.MEMORY_REPO));
  // The token comes from --token-env NAME (that variable must exist), what you type (hidden), or the one already saved.
  // It is never silently taken from whatever GITHUB_TOKEN your shell happens to hold.
  const tokenEnv = flag("token-env");
  if (tokenEnv && !process.env[tokenEnv]) {
    console.error(`--token-env ${tokenEnv}: that environment variable isn't set in this shell.`);
    process.exit(1);
  }
  const keep = file.GITHUB_TOKEN ? ` (Enter keeps the saved one, …${file.GITHUB_TOKEN.slice(-4)})` : "";
  file.GITHUB_TOKEN = (tokenEnv && process.env[tokenEnv]) || (interactive ? (await promptSecret(`GitHub fine-grained token${keep}`)) || file.GITHUB_TOKEN : file.GITHUB_TOKEN);
  file.EMBEDDINGS = flag("embeddings") || (await ask("Embeddings: local | static | voyage | none", file.EMBEDDINGS || cfg.EMBEDDINGS || "local"));
  if (!["none", "local", "static", "voyage", "hash"].includes(String(file.EMBEDDINGS).toLowerCase())) {
    console.error(`Embeddings must be none, local, static or voyage (got "${file.EMBEDDINGS}").`);
    process.exit(1);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(file.MEMORY_REPO || "") || !file.GITHUB_TOKEN) {
    console.error(`Missing ${!file.GITHUB_TOKEN ? "token" : "repo"}. Non-interactive use: githippo install --repo owner/name --token-env GITHUB_TOKEN`);
    process.exit(1);
  }
  file.STORE = "github"; // install IS the explicit GitHub-API mode; a vault set up earlier by `setup` stays on disk but is no longer the active store
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);

  if (configOnly) {
    console.log(`\n✓ config → ${CONFIG_FILE} (chmod 600). Hooks and MCP come from the Claude Code plugin.\n`);
    return;
  }
  const settingsPath = join(claudeDir(), "settings.json");
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  } catch {
    console.error(`✗ ${settingsPath} isn't valid JSON, so hooks weren't added. Fix it and run githippo install again.`);
    process.exit(1);
  }
  const viaPlugin = await pluginInstalled();
  const applied = applyHooks(settings, { hooks: !viaPlugin });
  if (applied.error) {
    console.error(`✗ ${settingsPath}: ${applied.error}, so hooks weren't added. Fix it and run githippo install again.`);
    process.exit(1);
  }
  await backupOnce(settingsPath);
  await mkdir(claudeDir(), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`\n✓ config → ${CONFIG_FILE} (chmod 600)\n${viaPlugin ? "✓ hooks and MCP: from the githippo plugin (not added a second time)" : `✓ hooks → ${settingsPath} (original backed up once)`}\n✓ status line: ${applied.statusLine ? "added" : "kept your existing status line"}\n${viaPlugin ? "" : `✓ MCP: ${registerMcp()}\n`}\n\nNext:\n  githippo init     # seed the repo\n  githippo doctor   # verify\n`);
}

/**
 * Adds githippo's hooks and status line to a parsed settings.json, and brings an entry an earlier setup wrote (the bare `githippo` form,
 * or a pinned path that has since moved) up to date: running setup again converges, it never duplicates. `migrated` counts those.
 * Refuses shapes it doesn't understand instead of mangling them.
 */
function applyHooks(settings, { hooks = true } = {}) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(settings)) return { error: "it must contain a JSON object" };
  if (settings.hooks !== undefined && !isObj(settings.hooks)) return { error: '"hooks" isn\'t an object' };
  for (const event of Object.keys(HOOKS)) if (settings.hooks?.[event] !== undefined && !Array.isArray(settings.hooks[event])) return { error: `hooks.${event} isn't a list` };
  if (hooks) settings.hooks ??= {};
  let migrated = 0;
  const pinnable = !!launchArgv("serve"); // without a stable path (npx, Windows) the bare form is all there is, and an existing pinned entry is better than it
  const refresh = (h, want, timeout) => {
    if (h.command === want || (!pinnable && h.command.includes(LAUNCHER))) return;
    if (timeout && !h.command.includes(LAUNCHER)) h.timeout = timeout; // an entry from before pinning also gets the current timeout
    h.command = want;
    migrated++;
  };
  for (const [event, args] of hooks ? Object.entries(HOOKS) : []) {
    settings.hooks[event] ??= [];
    const want = hookCommand(args);
    const mine = settings.hooks[event].flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter((h) => ours(h?.command));
    if (!mine.length) settings.hooks[event].push({ ...(event === "SessionStart" ? { matcher: "startup|resume|compact|fork" } : {}), hooks: [{ type: "command", command: want, timeout: HOOK_TIMEOUTS[event] }] });
    else for (const h of mine) refresh(h, want, HOOK_TIMEOUTS[event]);
  }
  let statusLine = false;
  if (!settings.statusLine) {
    settings.statusLine = { type: "command", command: hookCommand("statusline") };
    statusLine = true;
  } else if (isObj(settings.statusLine) && ours(settings.statusLine.command)) refresh(settings.statusLine, hookCommand("statusline"));
  return { statusLine, migrated };
}

/** True when the githippo Claude Code plugin is installed: it already provides the hooks and the MCP server. */
async function pluginInstalled() {
  return /githippo/i.test(await readFile(join(claudeDir(), "plugins", "installed_plugins.json"), "utf8").catch(() => ""));
}

/** Keeps the FIRST backup only: later runs would otherwise overwrite your original with an already-modified file. */
async function backupOnce(path) {
  const b = `${path}.githippo-backup`;
  if (existsSync(path) && !existsSync(b)) await copyFile(path, b).catch(() => {});
}

/** Removes githippo's hooks, status line and MCP registration; the memory itself is left alone. */
async function uninstall() {
  const settingsPath = join(claudeDir(), "settings.json");
  let removed = 0;
  let settings = null;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") return console.error(`✗ ${settingsPath} isn't valid JSON; fix it first (nothing was changed).`), process.exit(1);
  }
  const mine = (h) => ours(h?.command);
  if (settings && typeof settings.hooks === "object" && settings.hooks && !Array.isArray(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const g of groups) {
        if (!Array.isArray(g?.hooks)) {
          kept.push(g);
          continue;
        }
        const rest2 = g.hooks.filter((h) => !mine(h));
        removed += g.hooks.length - rest2.length;
        if (rest2.length) kept.push({ ...g, hooks: rest2 });
      }
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  if (settings?.statusLine && mine(settings.statusLine)) {
    delete settings.statusLine;
    removed++;
  }
  if (settings && removed) {
    await backupOnce(settingsPath);
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }
  let mcp = "claude CLI not found";
  if (commandExists("claude")) {
    try {
      execFileSync("claude", ["mcp", "remove", "githippo", "--scope", "user"], { stdio: "pipe" });
      mcp = "removed";
    } catch {
      mcp = "wasn't registered";
    }
  }
  console.log(`✓ removed ${removed} hook/status-line entr${removed === 1 ? "y" : "ies"} · MCP ${mcp}\n  Your memory is untouched (${loadConfig().VAULT_DIR}); delete that folder yourself if you want it gone.`);
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
  const brain = await brainOrExit("init");
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
  // keep what the user chose in the environment: hooks run without the MCP server's env, so anything not saved here is lost
  file.EMBEDDINGS ??= cfg.EMBEDDINGS || "local";
  if (process.env.VAULT_DIR && !file.VAULT_DIR) file.VAULT_DIR = resolve(expandHome(process.env.VAULT_DIR));
  await mkdir(HOME_DIR, { recursive: true, mode: 0o700 });
  await chmod(HOME_DIR, 0o700).catch(() => {}); // the vault and checkpoints are personal: not readable by other local users
  await writeFile(CONFIG_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);

  const brain = (await server()).createBrain(process.env, { source: "setup" });
  if (brain.store.ensure) await brain.store.ensure();
  await seed(brain.store, () => {});
  say(`✓ memory vault   ${file.STORE === "github" ? `github.com/${cfg.MEMORY_REPO}` : loadConfig().VAULT_DIR}`);

  const settingsPath = join(claudeDir(), "settings.json");
  if (existsSync(claudeDir()) || commandExists("claude")) {
    const r = await wireClaudeCode(settingsPath);
    if (r.error) {
      say(`✗ Claude Code    not set up: ${r.error}. Fix that file, then run githippo setup again.`);
      process.exitCode = 1;
    } else say(`✓ Claude Code    ${r.viaPlugin ? "hooks come from the githippo plugin" : "hooks"}${r.migrated ? ` (${r.migrated} existing entr${r.migrated === 1 ? "y" : "ies"} updated)` : ""}${r.statusLine ? " + status line" : ""} · MCP ${r.mcp}`);
  } else {
    say("· Claude Code    not found (add the MCP server to your client: command `githippo serve`)");
  }

  if (rest.includes("--github")) {
    const name = rest[rest.indexOf("--github") + 1];
    say(await syncToGitHub(name && !name.startsWith("--") ? name : "githippo-memory"));
  }

  if ((loadConfig().EMBEDDINGS || "local") === "local") {
    const log = join(HOME_DIR, "warm.log");
    const logFd = openSync(log, "a");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "warm"], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.on("error", () => {}); // a missing runtime must never crash setup
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
  // With the plugin installed, hooks and MCP come from it: adding ours too would run every hook and register the server twice.
  const viaPlugin = await pluginInstalled();
  const applied = applyHooks(settings, { hooks: !viaPlugin });
  if (applied.error) return { mcp: "skipped", statusLine: false, error: `${settingsPath}: ${applied.error}` };
  await backupOnce(settingsPath);
  await mkdir(claudeDir(), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  return { mcp: viaPlugin ? "from the githippo plugin (not added twice)" : commandExists("claude") ? registerMcp() : "not registered (claude CLI not found)", statusLine: applied.statusLine, viaPlugin, migrated: applied.migrated };
}

/** Backs the local vault up to a private GitHub repo using the user's own gh login. No token is stored. */
async function syncToGitHub(name) {
  const { gitEnv } = await import("./filestore.js");
  const cfg = loadConfig();
  const dir = cfg.VAULT_DIR;
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: gitEnv() }).toString().trim();
  // `git -C dir` finds an enclosing repository when the vault has none of its own, and would push THAT one
  if (!existsSync(join(dir, ".git"))) {
    process.exitCode = 1;
    return `✗ backup         ${dir} isn't a git repository yet: run githippo setup (or githippo init) first`;
  }
  let linked = "";
  try {
    linked = git("remote");
  } catch {}
  if (linked) {
    // already linked: push, and say so honestly if that fails (never fall through to creating a second repo)
    let url = "";
    try {
      url = scrubText(git("remote", "get-url", "origin"));
      if (process.env.GITHIPPO_ALLOW_PUBLIC_BACKUP !== "1" && (await remoteVisibility(url)) === "public") {
        process.exitCode = 1;
        return `✗ backup         not pushed: ${publicBackupMessage(url)}`;
      }
      git("push", "-q", "-u", "origin", "HEAD");
      return `✓ backup         already linked: ${url}`;
    } catch (e) {
      process.exitCode = 1;
      return `✗ backup         push to ${url || "the remote"} failed: ${scrubText(firstLine(e.stderr || e.message))}`;
    }
  }
  if (!commandExists("gh")) {
    return "· backup         install GitHub CLI (`brew install gh`, then `gh auth login`) and run `githippo sync --github`";
  }
  try {
    execFileSync("gh", ["repo", "create", name, "--private", "--source", dir, "--remote", "origin", "--push", "--description", "githippo memory vault (private)"], { stdio: "pipe" });
    return `✓ backup         private repo ${scrubText(git("remote", "get-url", "origin"))} (pushes after each change)`;
  } catch (e) {
    process.exitCode = 1;
    return `✗ backup         ${scrubText(firstLine(e.stderr || e.message))}`;
  }
}
async function sync() {
  if (rest.includes("--github")) {
    const name = rest[rest.indexOf("--github") + 1];
    console.log(await syncToGitHub(name && !name.startsWith("--") ? name : "githippo-memory"));
    return;
  }
  const brain = await brainOrExit("sync");
  const hasRemote = brain.store.git ? !!(await brain.store.git(["remote"])).out : false;
  if (!hasRemote) return console.log("· no remote; run githippo sync --github to back up to a private repo");
  const pulled = brain.store.pull ? await brain.store.pull() : true;
  // the same rule as the background push: memory never goes to a repository anyone can read
  const url = (await brain.store.git(["remote", "get-url", "origin"])).out;
  if (process.env.GITHIPPO_ALLOW_PUBLIC_BACKUP !== "1" && (await remoteVisibility(url)) === "public") {
    process.exitCode = 1;
    return console.error(`✗ not pushed: ${publicBackupMessage(url)}`);
  }
  const pushed = await brain.store.git(["push", "-q", "origin", "HEAD"], 30_000);
  if (!pulled || !pushed.ok) {
    process.exitCode = 1;
    return console.error(`✗ not fully synced${pulled ? "" : " (pull failed or was skipped, see the message above)"}${pushed.ok ? "" : `; push failed: ${scrubText(firstLine(pushed.err))}`}`);
  }
  console.log("✓ synced with remote");
}

async function users() {
  const { Accounts, parseAcl, Acl } = await import("./accounts.js");
  const file = join(HOME_DIR, "users.json");
  const acc = Accounts.load({ env: {}, file });
  const [sub, id] = rest;
  const flag = (n) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  if (sub === "add" || sub === "reset") {
    if (!id || id.startsWith("--")) return console.error(`usage: githippo users ${sub} <id>${sub === "add" ? ' --acl "shared/:write,people/:read"' : ""}`), process.exit(1);
    if (sub === "add" && !flag("acl")) {
      return console.error('Say what they can access, e.g. --acl "shared/:write,people/:read" (use --acl ":write" for full access).'), process.exit(1);
    }
    const acl = sub === "reset" ? acc.get(id)?.acl : parseAcl(flag("acl"));
    if (!acl) return console.error(`No user "${id}".`), process.exit(1);
    const pw = acc.add(id, acl);
    acc.save();
    console.log(`✓ ${id}  password (shown once): ${pw}\n  access: ${acl.map((r) => `${r.path || "(everything)"} ${r.access}`).join(", ")}, plus their own users/${id}/`);
    console.log(`  users file: ${file}${process.env.RENDER ? "" : "  (on Render: set USERS_JSON to its contents)"}`);
  } else if (sub === "remove") {
    console.log(acc.remove(id) ? (acc.save(), `✓ removed ${id}: running githippo servers that read this users file reject their tokens on the next request (USERS_JSON deployments need a restart)`) : `No user "${id}".`);
  } else {
    if (!acc.multiUser) return console.log("No users yet: the remote server has one owner who signs in with MCP_SECRET.\nAdd people: githippo users add <id> --acl \"shared/:write,people/:read\"");
    for (const u of acc.users.values()) console.log(`${u.id.padEnd(16)} ${new Acl(u).isAdmin ? "admin  " : "       "} ${(u.acl || []).map((r) => `${r.path || "*"}:${r.access}`).join(" ")}`);
  }
}

/** Plain text of a Claude Code session for the consolidation model: what the user asked and what happened. */
async function sessionText(path) {
  const { transcriptParser } = await import("./transcript.js");
  const { stripMemoryTags } = await import("./parse.js");
  const { createReadStream } = await import("node:fs");
  const { createInterface: lines } = await import("node:readline");
  const turns = [];
  for await (const l of lines({ input: createReadStream(path), crlfDelay: Infinity })) {
    try {
      const e = JSON.parse(l);
      const c = e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
      const clean = stripMemoryTags(text).text.trim();
      if (clean && (e.type === "user" || e.type === "assistant") && !/^<(command|local-command)/.test(clean)) turns.push(`${e.type}: ${clean.slice(0, 2000)}`);
    } catch {}
  }
  void transcriptParser;
  return turns.join("\n");
}

/**
 * Sleep-time consolidation: githippo consolidate [--transcript <path>] [--no-pr]
 * Proposes memory updates from a session and puts them on a branch (a PR if the vault has a GitHub remote).
 */
async function consolidateCmd() {
  const { createLLM } = await import("./llm.js");
  const { openPullRequest, proposalSummary } = await import("./consolidate.js");
  const cfg = loadConfig();
  const llm = createLLM(process.env);
  if (!llm) return console.error("consolidate needs ANTHROPIC_API_KEY (it uses a small model to review the session)."), process.exit(1);
  if (cfg.STORE !== "local") return console.error("consolidate works on a local vault (proposals are git branches)."), process.exit(1);
  let file = rest.includes("--transcript") ? rest[rest.indexOf("--transcript") + 1] : null;
  if (!file) {
    const { readdirSync, statSync } = await import("node:fs");
    const root = join(claudeDir(), "projects");
    const all = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, d.name, f)));
    file = all.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  }
  if (!file) return console.error("No Claude Code transcript found; pass --transcript <path>."), process.exit(1);
  const brain = await brainOrExit("consolidate");
  const { runConsolidation } = await import("./consolidate.js");
  const results = await runConsolidation({ llm, sessionText: await sessionText(file), brain, vaultDir: cfg.VAULT_DIR, root: cfg.MEMORY_ROOT ?? "memory", pendingDir: join(HOME_DIR, "pending") });
  if (!results.length) return console.log("No changes proposed.");
  for (const r of results) {
    const summary = proposalSummary(r, llm.model);
    if (!r.applied.length) {
      console.log(`No changes proposed.${r.rejected.length ? `\n${summary}` : ""}`);
      continue;
    }
    const pr = rest.includes("--no-pr") ? null : openPullRequest(cfg.VAULT_DIR, r.branch, summary);
    console.log(`${summary}\n\n${pr ? `Pull request: ${pr}` : `Branch ${r.branch}: githippo proposals accept ${r.branch}  (or reject)`}`);
  }
}

/** Contextual retrieval: githippo contextualize [--limit N]  (needs ANTHROPIC_API_KEY; local vault) */
async function contextualizeCmd() {
  let limit = Infinity;
  if (rest.includes("--limit")) {
    limit = Number(rest[rest.indexOf("--limit") + 1]);
    if (!Number.isInteger(limit) || limit < 1) return console.error("--limit needs a whole number of at least 1: it caps the paid model calls."), process.exit(2);
  }
  const { createLLM } = await import("./llm.js");
  const { contextualize } = await import("./contextualize.js");
  const cfg = loadConfig();
  const llm = createLLM(process.env);
  if (!llm) return console.error("contextualize needs ANTHROPIC_API_KEY."), process.exit(1);
  if (cfg.STORE !== "local") return console.error("contextualize works on a local vault."), process.exit(1);

  const r = await contextualize({ brain: await brainOrExit("contextualize"), llm, vaultDir: cfg.VAULT_DIR, limit, log: (m) => console.error(m) });
  console.log(`✓ ${r.added} chunks contextualized (${r.total} total) · ${llm.model} · stored in memory/.githippo/context.json (committed)`);
}

/** githippo proposals [list] | accept <branch> | reject <branch> */
async function proposalsCmd() {
  const { listProposals, acceptProposals, rejectProposals } = await import("./consolidate.js");
  const dir = loadConfig().VAULT_DIR;
  const [sub, branch] = rest;
  if (sub === "accept" && branch) return acceptProposals(dir, branch), console.log(`✓ merged ${branch}`);
  if (sub === "reject" && branch) return rejectProposals(dir, branch), console.log(`✓ discarded ${branch}`);
  const list = listProposals(dir);
  if (!list.length) return console.log("No pending proposals.");
  for (const b of list) console.log(`${b}\n${execFileSync("git", ["-C", dir, "diff", "--stat", `HEAD...${b}`]).toString()}`);
}

/** Import from the MCP reference memory server: githippo import <memory.jsonl> */
async function importCmd() {
  const file = rest[0];
  if (!file) return console.error("usage: githippo import <path/to/memory.jsonl>"), process.exit(1);
  const { importReferenceMemory } = await import("./importer.js");
  const brain = await brainOrExit("import");
  if (brain.store.ensure) await brain.store.ensure();
  const r = await importReferenceMemory(brain, await readFile(file, "utf8"));
  console.log(`✓ ${r.entities} entities → ${r.facts} facts, ${r.relations} relations` + (r.duplicates ? ` · ${r.duplicates} already known` : "") + (r.blocked ? ` · ${r.blocked} blocked by the secrets guard` : "") + (r.rejected ? ` · ${r.rejected} refused (${r.reasons.slice(0, 2).join("; ")})` : "") + (r.skippedLines ? ` · ${r.skippedLines} unreadable lines skipped` : ""));
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
  const mode = String(loadConfig().EMBEDDINGS || "local").toLowerCase();
  if (!["local", "static"].includes(mode)) return console.log(`nothing to download: EMBEDDINGS=${mode} doesn't use a local model`);
  const { importTransformers, ensureRuntime, createEmbedder } = await import("./embed.js");
  try {
    await importTransformers();
  } catch {
    const ok = await ensureRuntime({ wait: true, force: true });
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
  const ok = (b, m) => {
    console.log(`${b ? "✓" : "✗"} ${m}`);
    if (!b) process.exitCode = 1; // a failed check is a failing exit code, so scripts and CI can rely on it
  };
  if (cfg.STORE === "local") {
    const b = await brainOrExit("doctor");
    ok(existsSync(cfg.VAULT_DIR), `local vault ${cfg.VAULT_DIR}`);
    ok(await b.store.hasGit(), "vault is a git repo (history + time travel)");
    const remote = (await b.store.git(["remote", "get-url", "origin"])).out;
    if (!remote) ok(true, "no backup yet (optional: githippo sync --github)");
    else {
      // memory is personal: the one thing worth failing the check for is a backup anyone can read
      const vis = await remoteVisibility(remote);
      if (vis === "public") ok(false, `backup → ${publicBackupMessage(remote)}`);
      else ok(true, `backup → ${scrubText(remote)} (${vis === "private" ? "not publicly readable" : "couldn't check that it is private"})`);
    }
  } else {
    ok(!!cfg.GITHUB_TOKEN, "GITHUB_TOKEN set");
    ok(/^[\w.-]+\/[\w.-]+$/.test(cfg.MEMORY_REPO || ""), `MEMORY_REPO ${cfg.MEMORY_REPO || "(missing)"}`);
  }
  const { RUNTIME_DIR } = await import("./embed.js");
  const mode = String(cfg.EMBEDDINGS || "local").toLowerCase();
  // checking must not start a ~500 MB download as a side effect (importTransformers() does exactly that when it's missing)
  const sem = mode === "none" ? "off" : mode === "voyage" ? (cfg.VOYAGE_API_KEY ? "ready (voyage)" : "VOYAGE_API_KEY is missing") : mode === "hash" ? "ready (test embedder)" : existsSync(join(RUNTIME_DIR, "node_modules", "@huggingface")) ? "ready" : "not downloaded yet: run `githippo warm` (keyword search works meanwhile)";
  ok(mode === "none" || sem.startsWith("ready"), `semantic search ${sem}`);
  if (cfg.STORE === "github") {
  const res = await fetch(`https://api.github.com/repos/${cfg.MEMORY_REPO}`, { headers: { Authorization: `Bearer ${cfg.GITHUB_TOKEN}` } });
  const repo = await res.json().catch(() => ({}));
  ok(res.ok, `repo reachable (${res.status})`);
  if (res.ok) {
    ok(repo.private, repo.private ? "repo is private" : "repo is PUBLIC — make it private before storing memory");
    ok(repo.permissions?.push !== false, "token can write");
  }
  }
  // the index check below would start the embedding install by itself when the runtime is missing; doctor only looks
  const brain = await brainOrExit("doctor", sem.startsWith("ready") || mode === "none" ? process.env : { ...process.env, EMBEDDINGS: "none" });
  const t0 = Date.now();
  await brain.index.sync({ maxAgeMs: 0 }).then(
    () => ok(true, `indexed ${brain.index.files.size} files, ${brain.index.chunks?.length || 0} chunks in ${Date.now() - t0} ms (${brain.index.embedder?.id || "keyword only"})`),
    (e) => ok(false, `index: ${e.message}`),
  );
  await brain.loadCore();
  ok(true, `core memory ~${Math.ceil(brain.core.length / 4)}/${cfg.CORE_BUDGET_TOKENS} tokens`);
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(join(claudeDir(), "settings.json"), "utf8"));
  } catch {}
  const plugin = await readFile(join(claudeDir(), "plugins", "installed_plugins.json"), "utf8").catch(() => "");
  const entries = [...Object.values(parsed?.hooks && typeof parsed.hooks === "object" ? parsed.hooks : {}).flat().flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).map((h) => h?.command), parsed?.statusLine?.command].filter(ours);
  const pinned = entries.map(launchTarget).filter(Boolean);
  const bareCount = entries.length - pinned.length;
  const gone = pinned.find((t) => !existsSync(t.cli));
  if (!entries.length) ok(plugin.includes("githippo"), "Claude Code hooks installed (settings or plugin)");
  else if (gone) ok(false, `Claude Code hooks point at ${gone.cli}, which no longer exists (moved or reinstalled): run githippo setup`);
  else if (!pinned.length) ok(commandExists("githippo"), commandExists("githippo") ? "Claude Code hooks installed (they call githippo from PATH, which Claude Desktop or an IDE may not have: run githippo setup to pin the path)" : "Claude Code hooks call githippo, which isn't on PATH here: run githippo setup");
  else ok(true, `Claude Code hooks installed, pinned to ${pinned[0].cli}${bareCount ? ` (${bareCount} entr${bareCount === 1 ? "y" : "ies"} still call githippo from PATH: run githippo setup)` : ""}`);
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
  show('› recall "¿Qué necesita el asistente de voz?"   (Spanish question, English notes)', fmt.recall(await brain.recall("¿Qué necesita el asistente de voz?", { mode: "brief" })) + (emb ? "" : "\n(keyword search can't bridge languages: run `githippo warm` for the multilingual model, then try again)"));
  show("› graph sam", fmt.graph(await brain.neighbors("sam")));
  show("› maintain", fmt.maintain(await brain.maintain({})));
  console.log(`\nThat's githippo. To keep your own memory (a local git vault, hooks and MCP for Claude Code): githippo setup\n`);
}

async function bench() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const brain = { core: "", index: {}, store: {}, loadCore: async () => "" };
  const { buildServer, instructions } = await server();
  const mcp = buildServer(brain);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "bench", version: "1" });
  await client.connect(b);
  const { tools } = await client.listTools();
  // What the model actually sees: name, description, input schema.
  const visible = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }))).length;
  const instr = instructions("").length;
  console.log(`tools: ${tools.length}\nmodel-visible schema: ~${Math.round(visible / 3.6)} tokens per turn\ninstructions: ~${Math.round(instr / 3.8)} tokens + core`);
  await client.close();
  // The other cost of memory: time. Hooks run before every prompt and the status line runs constantly, so their start-up is measured too,
  // next to what `node` alone needs (nothing can start faster than that).
  const median = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  const time = (args, input) => {
    const runs = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      spawnSync(process.execPath, args, { input, stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, EMBEDDINGS: "none" } });
      runs.push(performance.now() - t);
    }
    return Math.round(median(runs));
  };
  const cli = fileURLToPath(import.meta.url);
  console.log(`hook start-up: ~${time([cli, "hook", "prompt"], JSON.stringify({ session_id: "bench", prompt: "hi" }))} ms, status line: ~${time([cli, "statusline"], "{}")} ms (node alone: ~${time(["-e", "0"], "")} ms)`);
}

/** Every command: readable one-line errors instead of stack traces (DEBUG=1 shows the trace). */
async function runCommand(fn) {
  try {
    await fn();
  } catch (e) {
    if (process.env.DEBUG) throw e;
    const msg = e?.code === "ENOENT" ? `file not found: ${e.path}` : e?.message || String(e);
    console.error(`githippo ${cmd}: ${msg}`);
    process.exit(1);
  }
}

const commands = { setup, sync, uninstall, warm, users, eval: evalCmd, import: importCmd, consolidate: consolidateCmd, proposals: proposalsCmd, contextualize: contextualizeCmd, serve, http, hook: () => hook(rest[0]), statusline, install, init, doctor, demo, bench };
const USAGE = {
  setup: "githippo setup [--github [repo-name]]   set everything up: vault, Claude Code hooks and MCP, background model download",
  install: "githippo install --repo owner/name --token-env GITHUB_TOKEN [--embeddings local|static|voyage|none] [--config-only]   GitHub-API mode",
  uninstall: "githippo uninstall   remove the Claude Code hooks, status line and MCP registration (your memory is kept)",
  sync: "githippo sync [--github [repo-name]]   pull and push the vault, or back it up to a private GitHub repo",
  users: 'githippo users add <id> --acl "shared/:write,people/:read" | list | remove <id> | reset <id>',
  eval: "githippo eval [--embeddings none|local|static|voyage|hash] [--json]   retrieval-quality benchmark",
  import: "githippo import <memory.jsonl>   import from the MCP reference memory server",
  consolidate: "githippo consolidate [--transcript <file>] [--no-pr]   needs ANTHROPIC_API_KEY: review a session and propose memory updates on a branch",
  contextualize: "githippo contextualize [--limit N]   needs ANTHROPIC_API_KEY: one paid model call per chunk; N caps the calls",
  proposals: "githippo proposals [accept|reject <branch>]   review proposed memory updates",
  warm: "githippo warm   download the local embedding model now",
  doctor: "githippo doctor   check the setup",
  demo: "githippo demo   try githippo without a repo or token",
  bench: "githippo bench   measure the tool-schema token cost",
  init: "githippo init   seed the vault",
  serve: "githippo serve   MCP server over stdio",
  http: "githippo http   MCP server over HTTP (remote mode)",
  hook: "githippo hook precompact|postcompact|session-end|session-start|prompt   (called by Claude Code)",
  statusline: "githippo statusline   (called by Claude Code)",
};
const FLAGS = { setup: ["--github"], install: ["--repo", "--token-env", "--embeddings", "--config-only"], sync: ["--github"], users: ["--acl"], eval: ["--embeddings", "--json"], consolidate: ["--transcript", "--no-pr"], contextualize: ["--limit"] };
function unknownOption(name, args) {
  const known = FLAGS[name] || [];
  const bad = args.find((a) => a.startsWith("--") && !known.includes(a));
  if (!bad) return null;
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const near = known.filter((k) => dist(bad, k) <= 3).sort((x, y) => dist(bad, x) - dist(bad, y))[0];
  return { flag: bad, hint: near };
}
const HELP = ["--help", "-h", "help"].includes(cmd);
if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else if (HELP || !commands[cmd]) {
  console.log(`githippo ${VERSION}\nusage: githippo setup [--github [repo-name]]   one command, everything
       githippo sync [--github [repo-name]]    back up / sync the vault
       githippo users add <id> --acl "shared/:write,people/:read" | list | remove <id> | reset <id>
       githippo eval [--embeddings none|local|voyage]   retrieval-quality benchmark
       githippo import <memory.jsonl>                     from the MCP reference memory server
       githippo consolidate [--transcript f] [--no-pr]    review a session with a small model → proposals branch/PR
       githippo proposals [accept|reject <branch>]        review proposed memory updates
       githippo contextualize [--limit N]                 situating context per chunk (contextual retrieval)
       githippo demo | doctor | warm | bench
       githippo serve | http | statusline | hook <event> | install | init`);
  process.exit(HELP ? 0 : 1);
} else {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE[cmd] || `usage: githippo ${cmd}`);
    process.exit(0); // asking for help is never an error, and never runs the command
  }
  const bad = unknownOption(cmd, rest);
  if (bad) {
    console.error(`githippo ${cmd}: unknown option ${bad.flag}${bad.hint ? ` (did you mean ${bad.hint}?)` : ""}\n${USAGE[cmd] || ""}`);
    process.exit(2);
  }
  await runCommand(commands[cmd]);
}
