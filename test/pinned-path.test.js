// Hooks, the status line and the MCP entry must keep working when `githippo` is not on the PATH of whatever launched Claude Code
// (Claude Desktop, an IDE or a GUI-started terminal usually have a shorter PATH than your shell). `setup` pins absolute paths; the
// launcher falls back to `node` and then `githippo` on the PATH, and does nothing, quietly, when neither runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, cp, symlink, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE_DIR = dirname(process.execPath);
const POSIX = process.platform !== "win32";
const GUI_PATH = "/usr/bin:/bin"; // what a GUI-launched app has: no githippo, no node
const opts = { skip: !POSIX && "the pinned launcher is POSIX-only; Windows keeps the bare form" };

const box = async () => {
  const home = await mkdtemp(join(tmpdir(), "pin-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  const base = { HOME: home, GITHIPPO_HOME: join(home, "g"), EMBEDDINGS: "none", STORE: "local", VAULT_DIR: join(home, "vault") };
  return { home, settings: join(home, ".claude", "settings.json"), shell: { ...base, PATH: `${NODE_DIR}:/usr/bin:/bin` }, app: { ...base, PATH: GUI_PATH } };
};
const cli = (args, env, root = ROOT) => spawnSync(process.execPath, [join(root, "src", "cli.js"), ...args], { env, encoding: "utf8", timeout: 60_000 });
const sh = (command, env, input = "") => spawnSync("sh", ["-c", command], { env, encoding: "utf8", input, timeout: 60_000 });
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const commands = (s) => Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
const transcript = async (home) => {
  const file = join(home, "t.jsonl");
  await writeFile(file, ['{"type":"user","message":{"role":"user","content":"Please migrate the billing service to Postgres 16"},"cwd":"/tmp/proj","sessionId":"s9"}', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Started."}]},"sessionId":"s9"}'].join("\n") + "\n");
  return JSON.stringify({ session_id: "s9", cwd: "/tmp/proj", transcript_path: file, trigger: "manual" });
};
const OLD = (args) => `sh -c 'command -v githippo >/dev/null 2>&1 || exit 0; exec githippo ${args}'`; // what 3.9.3 wrote

test("setup pins absolute paths: the hooks and the status line run with a PATH that has no githippo", opts, async () => {
  const b = await box();
  const r = cli(["setup"], b.shell);
  assert.equal(r.status, 0, r.stderr);
  const s = await read(b.settings);
  const input = await transcript(b.home);
  const pre = sh(s.hooks.PreCompact[0].hooks[0].command, b.app, input);
  assert.equal(pre.status, 0, pre.stderr);
  assert.match(pre.stdout, /keep these in the compaction summary/, "the real hook ran (it printed what to keep) although githippo is not on this PATH");
  assert.ok(existsSync(join(b.home, "g", "checkpoints", "s9.md")), "and it saved the checkpoint");
  const status = sh(s.statusLine.command, b.app, '{"session_id":"s9","cwd":"/tmp/proj"}');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /githippo/, "the status line ran too");
  assert.equal(pre.stderr + status.stderr, "", "nothing on stderr");
  assert.equal(spawnSync("sh", ["-c", "command -v githippo"], { env: { PATH: GUI_PATH } }).status, 1, "the control: githippo really is not on that PATH");
});

test("the pinned node is a PATH entry that survives an upgrade, not the versioned folder it points into", opts, async () => {
  const b = await box();
  // a "node" that is a symlink to the real binary, as Homebrew's /opt/homebrew/bin/node is
  const bin = join(b.home, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  assert.equal(cli(["install", "--repo", "a/b", "--token-env", "T"], { ...b.shell, T: "ghp_explicit_token_value_1234", PATH: `${bin}:/usr/bin:/bin` }).status, 0);
  const cmd = (await read(b.settings)).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(cmd.includes(`'${join(bin, "node")}'`), `pinned the PATH entry: ${cmd.slice(-160)}`);
});

test("paths with spaces and quotes survive the shell, and setup run from them still pins correctly", opts, async () => {
  const b = await box();
  const dir = join(b.home, "it's a dir");
  await mkdir(dir);
  await cp(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  await cp(join(ROOT, "package.json"), join(dir, "package.json"));
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
  assert.equal(cli(["setup"], b.shell, dir).status, 0);
  const s = await read(b.settings);
  const cmd = s.hooks.PreCompact[0].hooks[0].command;
  assert.ok(cmd.includes("it'\\''s a dir"), "the single quote is escaped for sh");
  const pre = sh(cmd, b.app, await transcript(b.home));
  assert.equal(pre.status, 0, pre.stderr);
  assert.match(pre.stdout, /keep these in the compaction summary/);
  // the install folder disappears (uninstalled, moved): the hook does nothing and says nothing
  await rm(dir, { recursive: true, force: true });
  const gone = sh(cmd, b.app, await transcript(b.home));
  assert.equal(gone.status, 0);
  assert.equal(gone.stdout + gone.stderr, "", "a missing install never breaks a session");
});

test("a moved node falls back to node on the PATH, then to githippo on the PATH, and otherwise stays silent", opts, async () => {
  const b = await box();
  assert.equal(cli(["setup"], b.shell).status, 0);
  const real = (await read(b.settings)).statusLine.command;
  const pinnedNode = real.split("githippo-launch ")[1].split(" ")[0]; // quoted, as written
  const broken = real.replace(pinnedNode, "'/nonexistent/node'");
  assert.notEqual(broken, real);
  const viaPath = sh(broken, { ...b.app, PATH: `${NODE_DIR}:${GUI_PATH}` });
  assert.match(viaPath.stdout, /githippo/, "pinned node gone: node from the PATH ran the pinned script");
  const none = sh(broken, b.app);
  assert.equal(none.status, 0);
  assert.equal(none.stdout + none.stderr, "", "no node anywhere: silent exit 0");
  // the pinned script gone but githippo on the PATH (a global install elsewhere): that one runs
  const bin = join(b.home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "githippo"), '#!/bin/sh\necho "fallback githippo $*"\n');
  await chmod(join(bin, "githippo"), 0o755);
  const gone = real.replace(/'[^']*[\\/]src[\\/]cli\.js'/, "'/nonexistent/cli.js'");
  assert.notEqual(gone, real);
  assert.match(sh(gone, { ...b.app, PATH: `${bin}:${GUI_PATH}` }).stdout, /fallback githippo statusline/);
});

test("setup is idempotent, and it migrates what 3.9.3 wrote in place without touching your own hooks", opts, async () => {
  const b = await box();
  const oldTimeout = { PreCompact: 99, PostCompact: 99, SessionEnd: 99, SessionStart: 99, UserPromptSubmit: 99 };
  const events = { PreCompact: "hook precompact", PostCompact: "hook postcompact", SessionEnd: "hook session-end", SessionStart: "hook session-start", UserPromptSubmit: "hook prompt" };
  const hooks = Object.fromEntries(Object.entries(events).map(([e, a]) => [e, [{ hooks: [{ type: "command", command: "my-own-hook" }] }, { hooks: [{ type: "command", command: OLD(a), timeout: oldTimeout[e] }] }]]));
  await writeFile(b.settings, JSON.stringify({ theme: "dark", hooks, statusLine: { type: "command", command: OLD("statusline") } }));
  assert.equal(cli(["setup"], b.shell).status, 0);
  const once = await read(b.settings);
  assert.equal(once.theme, "dark");
  for (const e of Object.keys(events)) {
    const mine = once.hooks[e].flatMap((g) => g.hooks).filter((h) => h.command.includes("githippo"));
    assert.equal(mine.length, 1, `${e}: one githippo entry, not two`);
    assert.ok(mine[0].command.includes("githippo-launch"), `${e}: moved to the pinned form`);
    assert.notEqual(mine[0].timeout, 99, `${e}: the old entry got the current timeout`);
    assert.ok(once.hooks[e].some((g) => g.hooks.some((h) => h.command === "my-own-hook")), `${e}: your hook is kept`);
  }
  assert.ok(once.statusLine.command.includes("githippo-launch"), "the status line moved too");
  const text = await readFile(b.settings, "utf8");
  assert.equal(cli(["setup"], b.shell).status, 0);
  assert.equal(await readFile(b.settings, "utf8"), text, "a second run changes nothing");
});

test("a status line or hook that isn't githippo's is never rewritten", opts, async () => {
  const b = await box();
  const own = { type: "command", command: "my-status --fancy" };
  const hooks = { PreCompact: [{ hooks: [{ type: "command", command: "echo githippo is great" }] }] };
  await writeFile(b.settings, JSON.stringify({ statusLine: own, hooks }));
  assert.equal(cli(["setup"], b.shell).status, 0);
  const s = await read(b.settings);
  assert.deepEqual(s.statusLine, own);
  assert.ok(s.hooks.PreCompact.some((g) => g.hooks.some((h) => h.command === "echo githippo is great")), "mentioning githippo isn't enough to be taken for its hook");
  assert.equal(s.hooks.PreCompact.flatMap((g) => g.hooks).filter((h) => h.command.includes("githippo-launch")).length, 1);
});

test("uninstall removes the pinned entries and the old ones, and only those", opts, async () => {
  const b = await box();
  const mine = { PostCompact: [{ hooks: [{ type: "command", command: OLD("hook postcompact") }] }], SessionEnd: [{ hooks: [{ type: "command", command: "githippo hook session-end" }, { type: "command", command: "keep-me" }] }] };
  await writeFile(b.settings, JSON.stringify({ hooks: mine }));
  assert.equal(cli(["setup"], b.shell).status, 0); // pins PreCompact, SessionStart, UserPromptSubmit; moves the other two
  assert.ok(commands(await read(b.settings)).filter((c) => c.includes("githippo-launch")).length >= 5);
  assert.equal(cli(["uninstall"], b.shell).status, 0);
  const left = await read(b.settings);
  assert.deepEqual(commands(left), ["keep-me"], "only your own hook is left");
  assert.equal(left.statusLine, undefined);
});

test("doctor says which form is installed, and fails when the pinned script has moved", opts, async () => {
  const b = await box();
  assert.equal(cli(["setup"], b.shell).status, 0);
  const ok = cli(["doctor"], b.shell);
  assert.match(ok.stdout, /✓ Claude Code hooks installed, pinned to .*src[\\/]cli\.js/);
  const s = await read(b.settings);
  s.hooks.PreCompact[0].hooks[0].command = s.hooks.PreCompact[0].hooks[0].command.replace(/'[^']*[\\/]src[\\/]cli\.js'/, "'/nonexistent/src/cli.js'");
  await writeFile(b.settings, JSON.stringify(s));
  const bad = cli(["doctor"], b.shell);
  assert.match(bad.stdout, /✗ Claude Code hooks point at \/nonexistent\/src\/cli\.js, which no longer exists/);
  assert.equal(bad.status, 1);
  await writeFile(b.settings, JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: OLD("hook precompact") }] }] } }));
  const old = cli(["doctor"], b.shell);
  assert.match(old.stdout, /Claude Code hooks installed \(they call githippo from PATH.*run githippo setup to pin the path\)|Claude Code hooks call githippo, which isn't on PATH here/);
});

// A fake `claude` that records what it is asked and answers `mcp get githippo` from a file.
async function fakeClaude(home, getOutput) {
  const bin = join(home, "fakebin");
  await mkdir(bin, { recursive: true });
  const log = join(home, "claude.log");
  const get = join(home, "get.txt");
  await writeFile(get, getOutput);
  await writeFile(join(bin, "claude"), `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$1 $2" = "mcp get" ]; then [ -s '${get}' ] && cat '${get}' && exit 0; exit 1; fi\nexit 0\n`);
  await chmod(join(bin, "claude"), 0o755);
  return { bin, calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean) };
}
const BARE = "githippo:\n  Scope: User config\n  Status: ✔ Connected\n  Type: stdio\n  Command: githippo\n  Args: serve\n\nTo remove this server, run: claude mcp remove githippo -s user\n";

test("MCP: a new registration is pinned; the bare entry 3.9.3 wrote is moved; a customised or pinned one is left alone", opts, async () => {
  const run = async (getOutput) => {
    const b = await box();
    const fake = await fakeClaude(b.home, getOutput);
    const r = cli(["setup"], { ...b.shell, PATH: `${fake.bin}:${b.shell.PATH}` });
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout, calls: await fake.calls() };
  };
  const added = (calls) => calls.filter((c) => c.startsWith("mcp add-json githippo"));

  const fresh = await run("");
  assert.equal(added(fresh.calls).length, 1);
  const json = JSON.parse(added(fresh.calls)[0].slice("mcp add-json githippo ".length).replace(/ --scope user$/, ""));
  assert.equal(json.command, "/bin/sh", "by absolute path, so it needs nothing from the PATH");
  assert.equal(json.args.at(-1), "serve");
  assert.equal(json.args.includes("githippo-launch"), true);
  assert.equal(json.alwaysLoad, true);
  assert.equal(existsSync(json.args[json.args.indexOf("githippo-launch") + 2]), true, "the pinned script exists");

  const moved = await run(BARE);
  assert.ok(moved.calls.some((c) => c === "mcp remove githippo --scope user"), "the bare entry was removed");
  assert.equal(added(moved.calls).length, 1, "and added again, pinned");
  assert.match(moved.out, /MCP updated/);

  for (const [name, text] of [["customised (has an environment)", `${BARE}  Environment:\n    VAULT_DIR=/x\n`], ["already pinned", BARE.replace("Command: githippo", "Command: sh").replace("Args: serve", "Args: -c n=$1 githippo-launch /n /c serve")], ["someone else's", BARE.replace("Command: githippo", "Command: npx")]]) {
    const left = await run(text);
    assert.deepEqual(left.calls.filter((c) => !c.startsWith("mcp get")), [], `${name}: untouched`);
    assert.match(left.out, /MCP already registered/);
  }
});
