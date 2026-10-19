// Fifth round (in-house audit): one test per finding, each reproduced before it was fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/filestore.js";
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
