// Fourth external report (CLI, install, setup, doctor, sync, runtime lock, importer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileStore } from "../src/filestore.js";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { importReferenceMemory } from "../src/importer.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const SRC = new URL("../src/", import.meta.url).pathname;
const box = async () => {
  const home = await mkdtemp(join(tmpdir(), "r4c-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  return { home, env: { PATH: "/usr/bin:/bin", HOME: home, GITHIPPO_HOME: join(home, "g"), EMBEDDINGS: "none" } };
};
const run = (args, env, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 60_000, ...opts });

test("options: --x=v is understood, --help never runs anything, unknown or invalid options stop before any paid work", async () => {
  const { env } = await box();
  const help = run(["contextualize", "--limit=3", "--help"], env);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /N caps the calls/);
  const typo = run(["contextualize", "--lmit", "3"], env);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown option --lmit \(did you mean --limit\?\)/);
  for (const v of ["abc", "0", "-2", "1.5"]) assert.equal(run(["contextualize", `--limit=${v}`], env).status, 2, `--limit=${v}`);
  const setupHelp = run(["setup", "--help"], env);
  assert.equal(setupHelp.status, 0);
  assert.equal(existsSync(join(env.GITHIPPO_HOME, "vault")), false, "setup --help set nothing up");
  assert.equal(run(["install", "--repo=a/b", "--bogus"], env).status, 2);
});

test("install: --token-env must exist, the shell's GITHUB_TOKEN is never used silently, and install switches to GitHub mode", async () => {
  const { home, env } = await box();
  const typo = run(["install", "--repo", "a/b", "--token-env", "GIHTUB_TOKEN", "--config-only"], { ...env, GITHUB_TOKEN: "ghp_shell_token_that_must_not_be_saved" });
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /GIHTUB_TOKEN: that environment variable isn't set/);
  const none = run(["install", "--repo", "a/b", "--config-only"], { ...env, GITHUB_TOKEN: "ghp_shell_token_that_must_not_be_saved" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Missing token/);
  assert.equal(existsSync(join(env.GITHIPPO_HOME, "config.json")), false, "nothing was saved");
  await mkdir(env.GITHIPPO_HOME, { recursive: true });
  await writeFile(join(env.GITHIPPO_HOME, "config.json"), JSON.stringify({ STORE: "local", EMBEDDINGS: "none" }));
  const ok = run(["install", "--repo", "a/b", "--token-env", "MY_TOKEN", "--config-only"], { ...env, MY_TOKEN: "ghp_explicit_token_value_1234" });
  assert.equal(ok.status, 0, ok.stderr);
  const cfg = JSON.parse(await readFile(join(env.GITHIPPO_HOME, "config.json"), "utf8"));
  assert.equal(cfg.GITHUB_TOKEN, "ghp_explicit_token_value_1234");
  assert.equal(cfg.STORE, "github", "a vault set up earlier by `setup` no longer wins over an explicit install");
  assert.equal(((await stat(join(env.GITHIPPO_HOME, "config.json"))).mode & 0o777).toString(8), "600");
});

test("settings.json: odd shapes are refused untouched, the first backup is kept, hooks are harmless once githippo is gone, and uninstall removes only githippo's entries", async () => {
  const { home, env } = await box();
  const settings = join(home, ".claude", "settings.json");
  const install = () => run(["install", "--repo", "a/b", "--token-env", "T"], { ...env, T: "ghp_explicit_token_value_1234" });
  for (const bad of ['{"hooks": []}', '{"hooks": {"PreCompact": "nope"}}', "[1,2]", '"text"']) {
    await writeFile(settings, bad);
    const r = install();
    assert.equal(r.status, 1, bad);
    assert.equal(await readFile(settings, "utf8"), bad, `${bad} was left exactly as it was`);
  }
  const original = JSON.stringify({ theme: "dark", hooks: { PreCompact: [{ hooks: [{ type: "command", command: "my-own-hook" }] }] } });
  await writeFile(settings, original);
  assert.equal(install().status, 0);
  const after = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(after.theme, "dark");
  assert.ok(after.hooks.PreCompact.some((g) => g.hooks.some((h) => h.command === "my-own-hook")), "your own hook is kept");
  const cmds = Object.values(after.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.filter((c) => c.includes("githippo hook")).every((c) => c.includes("command -v githippo")), "every githippo hook is a no-op when githippo isn't installed");
  assert.equal(await readFile(`${settings}.githippo-backup`, "utf8"), original, "the backup is your original");
  assert.equal(install().status, 0); // a second run must not replace the backup with the already-modified file
  assert.equal(await readFile(`${settings}.githippo-backup`, "utf8"), original);
  assert.equal(Object.values(JSON.parse(await readFile(settings, "utf8")).hooks).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes("githippo hook precompact")).length, 1, "no duplicate hooks");
  // the wrapped command really does nothing (and exits 0) when githippo isn't on PATH
  const cmd = after.hooks.SessionEnd.flatMap((g) => g.hooks).find((h) => h.command.includes("githippo hook")).command;
  const noop = spawnSync("sh", ["-c", cmd], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", input: "{}" });
  assert.equal(noop.status, 0);
  assert.equal(noop.stderr, "");
  const un = run(["uninstall"], env);
  assert.equal(un.status, 0, un.stderr);
  const gone = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(JSON.stringify(gone).includes("githippo"), false, "no githippo entry remains");
  assert.ok(gone.hooks.PreCompact.some((g) => g.hooks.some((h) => h.command === "my-own-hook")), "yours survives");
  assert.equal(gone.statusLine, undefined);
});

test("sync tells the truth (rejected push, no remote), and doctor never prints a token or starts a download", async () => {
  const { home, env } = await box();
  const vaultDir = join(home, "vault");
  const e2 = { ...env, STORE: "local", VAULT_DIR: vaultDir };
  await new FileStore({ dir: vaultDir, autoPush: false }).ensure();
  const none = run(["sync"], e2);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no remote/);
  execFileSync("git", ["-C", vaultDir, "remote", "add", "origin", "https://user:SECRETTOKEN123@example.invalid/x.git"]);
  const bad = run(["sync"], e2);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stderr, /not fully synced/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /SECRETTOKEN123/);
  const doc = run(["doctor"], e2);
  assert.doesNotMatch(doc.stdout + doc.stderr, /SECRETTOKEN123/, "the backup URL is printed without credentials");
  assert.match(doc.stdout, /backup → https:\/\/example\.invalid\/x\.git/);
  const voy = run(["doctor"], { ...e2, EMBEDDINGS: "voyage", VOYAGE_API_KEY: "pa-test" });
  assert.match(voy.stdout, /semantic search ready \(voyage\)/);
  const loc = run(["doctor"], { ...e2, EMBEDDINGS: "local" });
  assert.match(loc.stdout, /semantic search not downloaded yet: run `githippo warm`/);
  assert.equal(existsSync(join(env.GITHIPPO_HOME, "runtime", ".installing")), false, "checking the setup didn't start a download");
});

test("the model runtime installs once: concurrent callers share one npm, and a dead installer's lock is taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r4rt-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  const count = join(dir, "count");
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho x >> "${count}"\nsleep 1\nexit 0\n`);
  await chmod(join(bin, "npm"), 0o755);
  const script = `const m = await import(${JSON.stringify(pathToFileURL(join(SRC, "embed.js")).href)}); const r = await Promise.all([m.ensureRuntime({ wait: true }), m.ensureRuntime({ wait: true }), m.ensureRuntime({ wait: true })]); console.log(JSON.stringify(r));`;
  const env = { PATH: `${bin}:/usr/bin:/bin`, GITHIPPO_HOME: join(dir, "home") };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 3);
  assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 1, "three callers, one install");
  // a lock left behind by a process that no longer exists doesn't block a new install
  await mkdir(join(dir, "home", "runtime"), { recursive: true });
  await writeFile(join(dir, "home", "runtime", ".installing"), `999999 ${Date.now()}`);
  const r2 = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 2, "the stale lock was taken over: exactly one more install");
});

test("import: different non-Latin names stay different notes", async () => {
  const store = new InMemoryStore();
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  const lines = [{ type: "entity", name: "笔记", entityType: "topic", observations: ["关于鹈鹕"] }, { type: "entity", name: "データ", entityType: "topic", observations: ["データの注記"] }, { type: "entity", name: "Дані", entityType: "topic", observations: ["нотатки"] }].map((o) => JSON.stringify(o)).join("\n");
  await importReferenceMemory(brain, lines);
  const paths = (await store.list()).map((f) => f.path).filter((p) => p.startsWith("topics/"));
  assert.equal(new Set(paths).size, 3, paths.join(", "));
});

test("plugin installed: setup and install don't add a second copy of the hooks and the MCP server", async () => {
  const { home, env } = await box();
  const settings = join(home, ".claude", "settings.json");
  await mkdir(join(home, ".claude", "plugins"), { recursive: true });
  await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "githippo@githippo": [{ version: "3.9.0" }] } }));
  await writeFile(settings, JSON.stringify({ theme: "dark" }));
  const r = run(["install", "--repo", "a/b", "--token-env", "T"], { ...env, T: "ghp_explicit_token_value_1234" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hooks and MCP: from the githippo plugin/);
  const after = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(after.hooks, undefined, "no hooks were added next to the plugin's");
  assert.ok(after.statusLine, "the status line is not something a plugin provides, so it is still added");
  const ss = run(["setup"], { ...env, STORE: "local", VAULT_DIR: join(home, "vault") });
  assert.match(ss.stdout, /hooks come from the githippo plugin/);
  assert.equal(JSON.parse(await readFile(settings, "utf8")).hooks, undefined);
});
