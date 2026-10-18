// Regression: with thousands of notes, the cold index opened every file at once and, once the process ran out
// of file descriptors, silently skipped the rest (FileStore.read turned EMFILE into "no such file").
// Found while measuring scale: 30,000 notes on disk, 19,980 indexed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

test("a vault larger than the file-descriptor limit is indexed completely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fd-"));
  await mkdir(join(dir, "memory/notes"), { recursive: true });
  const N = 800;
  for (let i = 0; i < N; i++) await writeFile(join(dir, `memory/notes/n${i}.md`), `---\nname: n${i}\n---\n\n- note ${i} about topic ${i % 50}\n`);
  const script = join(dir, "run.mjs");
  await writeFile(script, `
    import { FileStore } from "${SRC}filestore.js";
    import { MemoryIndex } from "${SRC}search.js";
    const store = new FileStore({ dir: ${JSON.stringify(dir)}, autoPush: false });
    const index = new MemoryIndex(store, null, {});
    await index.sync({ maxAgeMs: 0 });
    console.log(JSON.stringify({ indexed: index.files.size, listed: (await store.list()).length }));
  `);
  // sh's ulimit lowers both the soft and hard limit, so the Node process can't raise it back
  const out = execFileSync("sh", ["-c", `ulimit -n 256 && "${process.execPath}" "${script}"`], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), { indexed: N, listed: N });
});

test("a real read error is thrown, never reported as a missing note", async () => {
  const { FileStore } = await import("../src/filestore.js");
  const dir = await mkdtemp(join(tmpdir(), "fd2-"));
  await mkdir(join(dir, "memory/x.md"), { recursive: true }); // a directory where a note should be → EISDIR → null (not a note)
  const store = new FileStore({ dir, autoPush: false });
  assert.equal(await store.read("x.md"), null);
  assert.equal(await store.read("missing.md"), null);
});
