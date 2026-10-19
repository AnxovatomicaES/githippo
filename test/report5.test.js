// Fifth round (in-house audit): one test per finding, each reproduced before it was fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink, chmod, stat } from "node:fs/promises";
import { existsSync, mkdirSync, cpSync, readdirSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, gitEnv } from "../src/filestore.js";
import { GitHubMemoryStore } from "../src/store.js";
import { cleanEnv } from "../src/embed.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { Acl } from "../src/accounts.js";
import { execFileSync } from "node:child_process";
import { githubRepoOf, remoteVisibility, makePushGuard, scrubUrl } from "../src/remote.js";

const vault = async () => {
  const dir = await mkdtemp(join(tmpdir(), "r5-"));
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  return { dir, store, brain: new Brain({ store, index: new MemoryIndex(store, null, {}) }) };
};
const catchAll = (id) => new Acl({ id, acl: [{ path: "", access: "write" }] });
const restricted = (id) => new Acl({ id, acl: [{ path: "shared/", access: "write" }] });

test("HIGH A1: maintain by a catch-all user never quotes or names another user's private folder", async () => {
  const { brain } = await vault();
  const bob = brain.forUser(restricted("bob"));
  const alice = brain.forUser(catchAll("alice"));
  assert.equal(alice.acl.isAdmin, true, "a catch-all rule makes a user an admin for maintain");
  assert.equal(alice.acl.canRead("users/bob/inbox.md"), false, "precondition: the catch-all rule does not open bob's folder");

  await bob.remember("Bob private salary target is 95000 euros next year");
  // alice probes with a near-identical fact; the old report paired it with bob's line and printed both
  await alice.remember("Bob private salary target is 90000 euros next year");

  const report = await alice.maintain();
  const text = JSON.stringify(report);
  assert.ok(!text.includes("users/bob"), `bob's path leaked: ${text}`);
  assert.ok(!text.includes("95000"), `bob's fact leaked: ${text}`);
  assert.equal(report.files, 1, "only alice's own note is in her report");
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.duplicates, []);
});

test("HIGH A1: maintain reindex keeps every user's private notes out of the shared index.md", async () => {
  const { brain, store } = await vault();
  await store.write("topics/shared-topic.md", "---\nname: shared-topic\ntitle: Shared topic\ndescription: visible to all\n---\n\n- a shared fact\n", "new");
  const bob = brain.forUser(restricted("bob"));
  await bob.remember("Bob private note about layoffs planned for spring");
  const alice = brain.forUser(catchAll("alice"));
  await alice.remember("Alice private note about her own plans");

  await alice.maintain({ reindex: true });
  const index = (await store.read("index.md")).content;
  assert.ok(index.includes("shared-topic"), "shared notes are indexed");
  assert.ok(!/users\/|inbox|layoffs|bob/i.test(index), `private notes leaked into index.md:\n${index}`);
});

test("A1: the owner (no ACL view) still sees the whole vault in maintain", async () => {
  const { brain, store } = await vault();
  await store.write("topics/a.md", "---\nname: a\n---\n\n- first fact about widgets\n", "new");
  await store.write("topics/b.md", "---\nname: b\n---\n\n- second fact about gadgets\n", "new");
  const report = await brain.maintain();
  assert.equal(report.files, 2);
  assert.equal(report.facts, 2);
});

const reply = (status) => async () => ({ status });

test("HIGH A2: github.com remotes are recognised in every URL form, other hosts are not", () => {
  for (const u of ["https://github.com/me/mem.git", "https://github.com/me/mem", "https://tok:x@github.com/me/mem.git", "git@github.com:me/mem.git", "ssh://git@github.com/me/mem.git", "https://github.com/me/mem/"]) {
    assert.equal(githubRepoOf(u), "me/mem", u);
  }
  for (const u of ["", null, "/tmp/bare.git", "https://gitlab.com/me/mem.git", "https://github.com.evil.example/me/mem", "https://github.com/me"]) assert.equal(githubRepoOf(u), null, String(u));
  assert.equal(scrubUrl("https://user:tok@github.com/me/mem.git"), "https://github.com/me/mem.git");
});

test("HIGH A2: an anonymous 200 means public, 404 means not publicly readable, anything else is unknown (never a guess)", async () => {
  const u = "https://github.com/me/mem.git";
  assert.equal(await remoteVisibility(u, { fetchImpl: reply(200) }), "public");
  assert.equal(await remoteVisibility(u, { fetchImpl: reply(404) }), "private");
  assert.equal(await remoteVisibility(u, { fetchImpl: reply(403) }), "unknown", "rate limited");
  assert.equal(await remoteVisibility(u, { fetchImpl: reply(500) }), "unknown");
  assert.equal(await remoteVisibility(u, { fetchImpl: async () => { throw new Error("offline"); } }), "unknown");
  assert.equal(await remoteVisibility("/tmp/bare.git", { fetchImpl: reply(200) }), "unknown", "not a GitHub remote: no request, no verdict");
});

test("HIGH A2: the visibility check sends no credentials and is cached, public only briefly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r5-vis-"));
  const cacheFile = join(dir, "vis.json");
  let calls = 0;
  let sent;
  const fetchImpl = async (url, init) => ((calls++, (sent = init)), { status: 404 });
  const u = "https://tok:secret@github.com/me/mem.git";
  assert.equal(await remoteVisibility(u, { fetchImpl, cacheFile, now: 1_000 }), "private");
  assert.equal(await remoteVisibility(u, { fetchImpl, cacheFile, now: 2_000 }), "private");
  assert.equal(calls, 1, "second answer comes from the cache");
  assert.ok(!JSON.stringify(sent).toLowerCase().includes("authorization"), "anonymous request: no Authorization header");
  assert.equal(await remoteVisibility(u, { fetchImpl, cacheFile, now: 1_000 + 61 * 60_000 }), "private");
  assert.equal(calls, 2, "private answers expire after an hour");
  // a public answer is only trusted for minutes, so fixing the repository resumes pushes quickly
  const pub = join(dir, "pub.json");
  assert.equal(await remoteVisibility(u, { fetchImpl: reply(200), cacheFile: pub, now: 0 }), "public");
  assert.equal(await remoteVisibility(u, { fetchImpl: reply(404), cacheFile: pub, now: 6 * 60_000 }), "private");
  assert.ok(!(await readFile(pub, "utf8")).includes("secret"), "the cache never holds the URL's credentials");
});

test("HIGH A2: the push guard vetoes a public backup, says why once, and can be overridden on purpose", async () => {
  const store = { git: async () => ({ out: "https://github.com/me/mem.git" }) };
  const logs = [];
  const guard = makePushGuard({ fetchImpl: reply(200), env: {}, log: (m) => logs.push(m) });
  assert.equal(await guard(store), false);
  assert.equal(await guard(store), false);
  assert.equal(logs.length, 1, "warns once per process");
  assert.match(logs[0], /PUBLIC repository/);
  assert.equal(await makePushGuard({ fetchImpl: reply(200), env: { GITHIPPO_ALLOW_PUBLIC_BACKUP: "1" } })(store), true, "explicit override");
  assert.equal(await makePushGuard({ fetchImpl: reply(404), env: {} })(store), true, "private repo pushes");
  assert.equal(await makePushGuard({ fetchImpl: async () => { throw new Error("offline"); }, env: {} })(store), true, "offline never blocks a backup");
});

test("HIGH A2: a vault whose origin is public does not push; the same vault with a private origin does", { timeout: 30_000 }, async () => {
  const mk = async (guard) => {
    const bare = await mkdtemp(join(tmpdir(), "r5-bare-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const dir = await mkdtemp(join(tmpdir(), "r5-vault-"));
    const store = await new FileStore({ dir, autoPush: true, pushGuard: guard }).ensure();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", bare]);
    await store.write("topics/t.md", "---\nname: t\n---\n\n- a private fact\n", "new");
    return { bare, dir };
  };
  const blocked = await mk(async () => false);
  const allowed = await mk(async () => true);
  await new Promise((r) => setTimeout(r, 5500)); // the push is debounced by 4 s
  const heads = (bare) => { try { return execFileSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "main"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
  assert.equal(heads(blocked.bare), "", "nothing was pushed to the vetoed remote");
  assert.match(heads(allowed.bare), /^[0-9a-f]{40}$/, "control: the allowed vault did push");
});

// ---------------------------------------------------------------------------------------------------------------------
// Auditor C: what githippo does to a machine and a vault
const SRC = join(fileURLToPath(new URL("../src", import.meta.url)));
const CLI = join(SRC, "cli.js");
const git = (...a) => execFileSync("git", a, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
const tmp = (p) => mkdtemp(join(tmpdir(), p));
const box = async () => {
  const home = await tmp("r5-home-");
  return { home, env: { PATH: process.env.PATH, HOME: home, GITHIPPO_HOME: join(home, "g"), EMBEDDINGS: "none" } };
};
const cli = (args, env, opts = {}) => spawnSync(process.execPath, [...(opts.nodeArgs || []), CLI, ...args], { env, encoding: "utf8", timeout: 60_000 });

test("HIGH C1: a symlink pushed into the vault is not a note: not listed, not read, not written through, not recalled", async () => {
  const { dir, store, brain } = await vault();
  const outside = join(await tmp("r5-out-"), "id_rsa");
  await writeFile(outside, "wombat-quartz-7731 deploy credentials live here\n");
  await mkdir(join(dir, "memory", "people"), { recursive: true });
  await writeFile(join(dir, "memory", "people", "ann.md"), "---\nname: ann\n---\n\n- ordinary note\n");
  await symlink(outside, join(dir, "memory", "people", "ops-notes.md"));
  const outDir = await tmp("r5-outdir-");
  await symlink(outDir, join(dir, "memory", "linked"));
  assert.deepEqual((await store.list()).map((f) => f.path), ["people/ann.md"], "only the regular file is listed");
  assert.equal(await store.read("people/ops-notes.md"), null, "a symlink to a file reads as 'no such note'");
  assert.equal(await store.read("linked/x.md"), null);
  await assert.rejects(store.write("linked/new.md", "---\nname: new\n---\n\n- planted\n", "new"), /symbolic link/);
  assert.equal(existsSync(join(outDir, "new.md")), false, "nothing was written outside the vault");
  const hits = JSON.stringify(await brain.recall("wombat-quartz deploy credentials"));
  assert.ok(!hits.includes("wombat-quartz-7731"), "recall never returns the target's text");
});

test("HIGH C2: a glob in a path can't reach a note the ACL denies (history and as-of use literal pathspecs)", async () => {
  const { store, brain } = await vault();
  await store.write("people/ada.md", "---\nname: ada\n---\n\n- public colleague\n", "new");
  await store.write("people/secret/layoffs-q3.md", "---\nname: layoffs-q3\n---\n\n- 40 people, announced in October\n", "new");
  const bob = brain.forUser(new Acl({ id: "bob", acl: [{ path: "people/", access: "read" }, { path: "people/secret/", access: "none" }] }));
  await assert.rejects(bob.history("people/secret/layoffs-q3"), /no read access|No entity|denied/i).catch(async () => {
    const r = await bob.history("people/secret/layoffs-q3");
    assert.deepEqual(r.commits, [], "the literal path is not readable");
  });
  for (const glob of ["people/[s]ecret/layoffs-q3", "people/secret/layoffs-[q]3", "people/*/layoffs-q3"]) {
    const r = await bob.history(glob).catch(() => ({ commits: [] }));
    assert.deepEqual(r.commits, [], `${glob} must not match the denied note`);
    const at = await bob.history(glob, { at: "2100-01-01" }).catch(() => ({ existed: false }));
    assert.ok(!at.existed && !at.commit, `${glob} (as of a date) must not match either`);
  }
});

test("HIGH C3: a vault folder inside another repository never pulls or pushes the outer one", async () => {
  const bare = await tmp("r5-bare-");
  git("init", "-q", "--bare", "-b", "main", bare);
  const outer = await tmp("r5-outer-");
  git("-C", outer, "init", "-q", "-b", "main");
  git("-C", outer, "remote", "add", "origin", bare);
  await writeFile(join(outer, "README"), "unpublished work\n");
  git("-C", outer, "add", "-A");
  git("-C", outer, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "wip: unpublished");
  const nested = join(outer, "notes");
  await mkdir(nested);
  const store = new FileStore({ dir: nested, autoPush: false }); // no ensure(): the vault has no repository of its own yet
  assert.equal(await store.pull(), false, "pull refuses");
  const { env } = await box();
  const r = cli(["sync", "--github", "x"], { ...env, STORE: "local", VAULT_DIR: nested });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /isn't a git repository yet/);
  assert.equal(git("-C", bare, "branch", "--list").trim(), "", "the outer repository's commit was not pushed");
});

test("MEDIUM C4: global signing or hook config can't silently stop memory from being committed", async () => {
  const cfg = join(await tmp("r5-gitcfg-"), "gitconfig");
  await writeFile(cfg, "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n[user]\n\tuseConfigOnly = true\n");
  await withEnv({ GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" }, async () => {
    const dir = await tmp("r5-sign-");
    mkdirSync(join(dir, ".git-hooks"));
    const store = await new FileStore({ dir, autoPush: false }).ensure();
    await store.write("topics/t.md", "---\nname: t\n---\n\n- a fact\n", "new");
    assert.equal(git("-C", dir, "log", "--format=%s").split("\n").length, 2, "the initial commit and the note's commit both exist");
    assert.equal((await store.history("topics/t.md")).length, 1);
  });
});

test("MEDIUM C5: git never prompts and never globs; the environment says so", () => {
  const e = gitEnv({ PATH: "/bin" });
  assert.equal(e.GIT_TERMINAL_PROMPT, "0");
  assert.equal(e.GIT_LITERAL_PATHSPECS, "1");
  assert.match(e.GIT_SSH_COMMAND, /BatchMode=yes/);
  assert.equal(gitEnv({ GIT_SSH_COMMAND: "ssh -i mykey" }).GIT_SSH_COMMAND, "ssh -i mykey", "a user's own ssh command is kept");
});

test("MEDIUM C6: a note too big for the GitHub contents API is refused, never read as empty and overwritten", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ type: "file", encoding: "none", size: 1_548_913, content: "", sha: "a".repeat(40) }) };
  };
  const store = new GitHubMemoryStore({ token: "t", repo: "me/mem", fetchImpl });
  await assert.rejects(store.read("topics/big.md"), /too large to read through the GitHub API/);
  await assert.rejects(store.append("topics/big.md", "- one more line", "a".repeat(40)), /too large/);
  assert.ok(!calls.some((c) => c.startsWith("PUT")), `nothing was written: ${calls.join(" | ")}`);
});

test("MEDIUM C7: setup keeps the user's embeddings and vault choices, and locks the folder to the user", async () => {
  const { home, env } = await box();
  const vaultDir = join(home, "mynotes");
  const r = cli(["setup"], { ...env, VAULT_DIR: vaultDir });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(await readFile(join(env.GITHIPPO_HOME, "config.json"), "utf8"));
  assert.equal(cfg.EMBEDDINGS, "none", "the environment's choice is saved, not overwritten with 'local'");
  assert.equal(cfg.VAULT_DIR, vaultDir, "hooks and the server must find the same vault later");
  assert.equal(((await stat(env.GITHIPPO_HOME)).mode & 0o777).toString(8), "700");
  assert.ok(existsSync(join(vaultDir, ".git")));
});

/** A copy of the program as a user has it installed: dependencies, but not the model runtime this checkout carries as a devDependency. */
const installedCopy = async () => {
  const app = await tmp("r5-app-");
  cpSync(SRC, join(app, "src"), { recursive: true });
  cpSync(join(SRC, "..", "package.json"), join(app, "package.json"));
  mkdirSync(join(app, "node_modules"));
  const nm = join(SRC, "..", "node_modules");
  for (const name of readdirSync(nm)) if (name !== "@huggingface") symlinkSync(join(nm, name), join(app, "node_modules", name));
  return join(app, "src", "cli.js");
};

test("MEDIUM C7: doctor only looks: with the model missing it starts no install", async () => {
  const { home, env } = await box();
  const bin = join(home, "bin");
  await mkdir(bin);
  const log = join(home, "npm.log");
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  await chmod(join(bin, "npm"), 0o755);
  const e = { ...env, PATH: `${bin}:${process.env.PATH}`, STORE: "local", VAULT_DIR: join(home, "vault"), EMBEDDINGS: "local" };
  const appCli = await installedCopy();
  assert.equal(spawnSync(process.execPath, [appCli, "init"], { env: e, encoding: "utf8" }).status, 0);
  const r = spawnSync(process.execPath, [appCli, "doctor"], { env: e, encoding: "utf8", timeout: 60_000 });
  assert.match(r.stdout, /not downloaded yet/);
  await new Promise((res) => setTimeout(res, 1500)); // an install would start in the background
  assert.equal(existsSync(log), false, `npm was run by doctor: ${existsSync(log) ? await readFile(log, "utf8") : ""}`);
});

test("MEDIUM C8: the embedding install and worker don't inherit tokens that config.json put in the environment", () => {
  const clean = cleanEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "sk-ant-x", MCP_SECRET: "s", VOYAGE_API_KEY: "v", MY_PASSWORD: "p", GITHIPPO_HOME: "/g" });
  assert.deepEqual(Object.keys(clean).sort(), ["GITHIPPO_HOME", "HOME", "PATH"]);
});

test("MEDIUM C9: hooks and settings go where Claude Code reads them (CLAUDE_CONFIG_DIR)", async () => {
  const { home, env } = await box();
  const cc = join(home, "cc");
  await mkdir(cc);
  const r = cli(["setup"], { ...env, CLAUDE_CONFIG_DIR: cc, STORE: "local", VAULT_DIR: join(home, "vault") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(await readFile(join(cc, "settings.json"), "utf8"), /githippo hook precompact/);
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "nothing was written to ~/.claude");
  assert.equal(JSON.parse(await readFile(join(cc, "settings.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0].timeout, 5, "the per-prompt hook gets a short timeout");
});

test("MEDIUM C10: a rebasing pull works on a machine with no git identity", async () => {
  const cfg = join(await tmp("r5-gitcfg-"), "gitconfig");
  await writeFile(cfg, "[user]\n\tuseConfigOnly = true\n");
  await withEnv({ GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" }, async () => {
    const bare = await tmp("r5-bare-");
    git("init", "-q", "--bare", "-b", "main", bare);
    const dir = await tmp("r5-a-");
    const a = await new FileStore({ dir, autoPush: false }).ensure();
    git("-C", dir, "remote", "add", "origin", bare);
    await a.write("topics/a.md", "---\nname: a\n---\n\n- from machine A\n", "new");
    git("-C", dir, "push", "-q", "origin", "HEAD:main");
    const other = await tmp("r5-b-");
    git("clone", "-q", bare, other);
    await mkdir(join(other, "memory", "topics"), { recursive: true });
    await writeFile(join(other, "memory", "topics", "b.md"), "---\nname: b\n---\n\n- from machine B\n");
    git("-C", other, "add", "-A");
    git("-C", other, "-c", "user.name=b", "-c", "user.email=b@x", "commit", "-q", "-m", "b");
    git("-C", other, "push", "-q", "origin", "HEAD:main");
    await a.write("topics/c.md", "---\nname: c\n---\n\n- local, not pushed\n", "new");
    assert.equal(await a.pull(), true, "the rebase needed a committer identity");
    assert.ok(await a.read("topics/b.md"), "machine B's note arrived");
    assert.ok(await a.read("topics/c.md"), "local work is kept");
  });
});

test("LOW C11: a failed model install is not retried on every recall, but `warm` can force one", async () => {
  const dir = await tmp("r5rt-");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const count = join(dir, "count");
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho x >> "${count}"\nexit 1\n`);
  await chmod(join(bin, "npm"), 0o755);
  const script = `const m = await import(${JSON.stringify(pathToFileURL(join(SRC, "embed.js")).href)});
    const a = await m.ensureRuntime({ wait: true }); const b = await m.ensureRuntime({ wait: true }); const c = await m.ensureRuntime({ wait: true });
    const d = await m.ensureRuntime({ wait: true, force: true });
    console.log(JSON.stringify([a, b, c, d]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: `${bin}:/usr/bin:/bin`, GITHIPPO_HOME: join(dir, "home") }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [false, false, false, false]);
  assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 2, "one install, two refused for the next hour, then one forced");
});

test("LOW C12: adopting an existing folder keeps its .gitignore", async () => {
  const dir = await tmp("r5-adopt-");
  await writeFile(join(dir, ".gitignore"), "private-drafts/\n*.secret\n");
  await new FileStore({ dir, autoPush: false }).ensure();
  const ignore = await readFile(join(dir, ".gitignore"), "utf8");
  assert.match(ignore, /private-drafts\//);
  assert.match(ignore, /\*\.secret/);
  assert.match(ignore, /\.DS_Store/);
});

test("HIGH A2: plain `githippo sync` and `doctor` refuse a public backup (no anonymous network in the test: fetch is stubbed)", async () => {
  const { home, env } = await box();
  const vaultDir = join(home, "vault");
  const e = { ...env, STORE: "local", VAULT_DIR: vaultDir };
  assert.equal(cli(["init"], e).status, 0);
  git("-C", vaultDir, "remote", "add", "origin", "https://tok:SECRET123@github.com/me/mem.git");
  const stub = join(home, "stub.mjs");
  await writeFile(stub, 'globalThis.fetch = async (u) => ({ status: String(u).includes("/repos/me/mem") ? 200 : 404 });\n');
  const nodeArgs = ["--import", pathToFileURL(stub).href];
  const sync = cli(["sync"], e, { nodeArgs });
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.match(sync.stderr, /not pushed: https:\/\/github\.com\/me\/mem\.git is a PUBLIC repository/);
  assert.doesNotMatch(sync.stdout + sync.stderr, /SECRET123/, "credentials are never printed");
  const doc = cli(["doctor"], e, { nodeArgs });
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /✗ backup → .*PUBLIC repository/);
  const ok = cli(["doctor"], { ...e, GITHIPPO_ALLOW_PUBLIC_BACKUP: "1" }, { nodeArgs });
  assert.match(ok.stdout, /backup → /);
});
