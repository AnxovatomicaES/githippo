// Scaling: API-call budget of the GitHub store, and local vault speed, on large vaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub } from "./fake-github.js";
import { GitHubMemoryStore } from "../src/store.js";
import { FileStore } from "../src/filestore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";

test("GitHub store, 2,000 files: cold start in 2 calls, idle sync is a free 304, a write is 1 call", async () => {
  const gh = fakeGitHub();
  for (let i = 0; i < 2000; i++) gh.seed(`memory/notes/n${i}.md`, `---\nname: n${i}\n---\n\n- note ${i} about topic ${i % 50}\n`);
  const log = [];
  const store = new GitHubMemoryStore({ token: "t", repo: "a/b", fetchImpl: async (u, o) => { const r = await gh.fetchImpl(u, o); log.push(r.status); return r; } });
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  await brain.index.sync({ maxAgeMs: 0 });
  assert.equal(log.length, 2, `cold start used ${log.length} calls`);
  assert.equal(brain.index.files.size, 2000);
  log.length = 0;
  await brain.index.sync({ maxAgeMs: 0 });
  assert.deepEqual(log, [304], "unchanged tree → 304 Not Modified (free under GitHub's rate limit)");
  log.length = 0;
  await brain.remember("topic 7 has a new owner", { path: "notes/n7.md" });
  assert.equal(log.filter((s) => s !== 304).length, 1, "one write call");
});

test("local vault, 5,000 files: cold index and re-sync times", async () => {
  const dir = await mkdtemp(join(tmpdir(), "big-"));
  await mkdir(join(dir, "memory/notes"), { recursive: true });
  for (let i = 0; i < 5000; i++) await writeFile(join(dir, `memory/notes/n${i}.md`), `---\nname: n${i}\n---\n\n- note ${i} about topic ${i % 50}\n`);
  const store = new FileStore({ dir, autoPush: false });
  const index = new MemoryIndex(store, null, {});
  let t = Date.now();
  await index.sync({ maxAgeMs: 0 });
  const cold = Date.now() - t;
  t = Date.now();
  await index.sync({ maxAgeMs: 0 });
  const warm = Date.now() - t;
  t = Date.now();
  const hits = await index.search("topic 42 note");
  const q = Date.now() - t;
  const brain = new Brain({ store, index });
  t = Date.now();
  await brain.remember("alpha7 has a new owner named Ada", { path: "notes/n7.md" });
  const write = Date.now() - t;
  console.log(`# local 5k: cold ${cold} ms, re-sync ${warm} ms, query ${q} ms, remember ${write} ms`);
  assert.ok(write < 3000, `remember took ${write} ms (entity mentions must not scale with vault size)`);
  assert.equal(index.files.size, 5000);
  assert.ok(hits.length > 0);
  assert.ok(warm < 2000, `re-sync took ${warm} ms`);
  assert.ok(q < 1000, `query took ${q} ms`);
});
