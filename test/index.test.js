// Incremental index, top-K search, binary vector cache, live context reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bm25, MemoryIndex } from "../src/search.js";
import { InMemoryStore } from "../src/memstore.js";
import { FileStore } from "../src/filestore.js";
import { Brain } from "../src/brain.js";
import { hashEmbedder } from "../src/embed.js";
import { encodeVectors, decodeVectors } from "../src/vecstore.js";
import { contextualize } from "../src/contextualize.js";

const chunk = (id, text) => ({ id, path: id.split("#")[0], embedText: text });
const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon".split(" ");
const rnd = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test("Bm25: any sequence of add/remove equals a fresh build (same scores, same order)", () => {
  const r = rnd(42);
  const text = () => [...Array(4 + Math.floor(r() * 8))].map(() => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
  const live = new Map();
  const inc = new Bm25();
  for (let step = 0; step < 300; step++) {
    const id = `p${Math.floor(r() * 40)}#0`;
    if (r() < 0.25 && live.has(id)) {
      live.delete(id);
      inc.remove(id);
    } else {
      const c = chunk(id, text());
      live.set(id, c);
      inc.add(c);
    }
  }
  const fresh = new Bm25([...live.values()]);
  assert.equal(inc.size, fresh.size);
  assert.ok(Math.abs(inc.avgLen - fresh.avgLen) < 1e-9);
  for (const q of ["alpha beta", "omicron", "pi rho sigma tau", "zzz nothing", WORDS.slice(0, 6).join(" ")]) {
    const a = inc.search(q).map((x) => [x.c.id, +x.s.toFixed(9)]);
    const b = fresh.search(q).map((x) => [x.c.id, +x.s.toFixed(9)]);
    assert.deepEqual(a, b, q);
  }
  for (const t of inc.postings.keys()) assert.ok(inc.postings.get(t).size > 0, "no empty postings left behind");
});

test("Bm25: top-K equals the prefix of the full ranking, ties ordered by id", () => {
  const r = rnd(7);
  const docs = [...Array(400)].map((_, i) => chunk(`d${String(i).padStart(3, "0")}#0`, [...Array(3)].map(() => WORDS[Math.floor(r() * 6)]).join(" ")));
  const full = new Bm25(docs).search("alpha beta gamma", 10_000).map((x) => x.c.id);
  const top = new Bm25(docs).search("alpha beta gamma", 25).map((x) => x.c.id);
  assert.deepEqual(top, full.slice(0, 25));
});

test("a write touches only that note; an idle sync rebuilds nothing", async () => {
  const store = new InMemoryStore();
  for (let i = 0; i < 200; i++) await store.write(`notes/n${i}.md`, `---\nname: n${i}\n---\n\n- note ${i} about topic${i % 7}\n`, "new");
  const index = new MemoryIndex(store, null, {});
  await index.sync({ maxAgeMs: 0 });
  const adds = [];
  const orig = index.lexical.add.bind(index.lexical);
  index.lexical.add = (c) => (adds.push(c.id), orig(c));
  let refreshes = 0;
  const refresh = index.refresh.bind(index);
  index.refresh = () => (refreshes++, refresh());
  const brain = new Brain({ store, index });
  await brain.remember("topic3 has a new owner", { path: "notes/n3.md" });
  assert.deepEqual(adds, ["notes/n3.md#0"], "only the written note was re-tokenised");
  assert.ok(refreshes >= 1);
  const before = refreshes;
  await index.sync({ maxAgeMs: 0 });
  assert.equal(refreshes, before, "nothing changed → no rebuild");
  await store.write("notes/new.md", "---\nname: new\n---\n\n- fresh note\n", "new");
  adds.length = 0;
  await index.sync({ maxAgeMs: 0 });
  assert.deepEqual(adds, ["notes/new.md#0"], "sync indexes only the new note");
  assert.ok((await brain.recall("fresh note", { mode: "brief" })).hits.length);
  await store.delete("notes/new.md", (await store.read("notes/new.md")).version);
  await index.sync({ maxAgeMs: 0 });
  assert.equal((await brain.recall("fresh note", { mode: "brief" })).hits.filter((h) => h.ref.startsWith("notes/new.md")).length, 0, "deleted note is gone from the index");
});

test("binary vector cache: round trip, tamper detection, JSON migration", async () => {
  const m = new Map([["h1", Float32Array.from([0.1, -0.2, 0.3])], ["line:abc", Float32Array.from([1, 2, 3])], ["h→ünï", Float32Array.from([4, 5, 6])]]);
  const back = decodeVectors(encodeVectors(m));
  assert.deepEqual([...back.keys()], [...m.keys()]);
  for (const [k, v] of m) assert.deepEqual(Array.from(back.get(k)), Array.from(v));
  assert.equal(decodeVectors(encodeVectors(new Map())).size, 0);
  const buf = encodeVectors(m);
  assert.throws(() => decodeVectors(buf.subarray(0, buf.length - 3)), /corrupt/);
  assert.throws(() => decodeVectors(Buffer.concat([Buffer.from("XXXX"), buf.subarray(4)])), /corrupt/);
  assert.throws(() => decodeVectors(Buffer.from("garbage")), /corrupt/);

  const dir = await mkdtemp(join(tmpdir(), "vc-"));
  const store = new InMemoryStore();
  const mk = () => new MemoryIndex(store, hashEmbedder(), { cacheDir: dir });
  const old = mk();
  await writeFile(old.cacheFile.replace(/\.bin$/, ".json"), JSON.stringify({ k1: [0.5, 0.25], k2: [1, 0] }));
  await old.loadCache();
  assert.deepEqual(Array.from(old.vectors.get("k1")), [0.5, 0.25], "old JSON cache is migrated");
  await old.flushCache();
  assert.equal(decodeVectors(await readFile(old.cacheFile)).size, 2, "before the first sync has finished nothing is pruned (a slow first sync used to wipe the cache)");
  old.synced = true;
  await old.flushCache();
  assert.equal(decodeVectors(await readFile(old.cacheFile)).size, 0, "after a sync, flush keeps only vectors still in use");
  await writeFile(old.cacheFile, "this is not a cache");
  const fresh = mk();
  await fresh.loadCache();
  assert.equal(fresh.vectors.size, 0, "a corrupt cache is ignored, not fatal");
});

test("stored contexts added while running are picked up on the next sync (live reload)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx2-"));
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  await store.write("projects/q.md", "---\nname: q\ntitle: Q\ndescription: Quarterly numbers\n---\n\n- Revenue grew 3% over the previous quarter\n", "new");
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  assert.equal((await brain.recall("ACME earnings", { mode: "brief" })).hits.length, 0);
  await contextualize({ brain, llm: { complete: async () => "This chunk is from ACME Corp's Q2 earnings review." }, vaultDir: dir });
  await brain.index.sync({ maxAgeMs: 0 });
  assert.ok((await brain.recall("ACME earnings", { mode: "brief" })).hits.some((h) => h.ref.startsWith("projects/q.md")), "same running index, no restart");
  const { execFileSync } = await import("node:child_process");
  assert.match(execFileSync("git", ["-C", dir, "ls-files"]).toString(), /memory\/\.githippo\/context\.json/, "the paid-for contexts are committed");
  assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString().trim(), "", "nothing left uncommitted");
});
