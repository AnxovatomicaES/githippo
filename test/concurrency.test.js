// Regression: parallel remember calls on the same entity lost ~95% of facts (ENOENT on temp-file rename and
// unsynchronised read-check-write). Reported by an external MCP test suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile, utimes, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/filestore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { speedFactor } from "./helpers.js";

const SRC = new URL("../src/", import.meta.url).pathname;

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "conc-"));
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  await brain.remember("Johnny is a voice assistant", { about: "Johnny", kind: "project" });
  return { dir, store, brain };
}

test("40 parallel remember calls on one entity in one process: every fact kept, no errors, no temp files", async () => {
  const { dir, store, brain } = await vault();
  const res = await Promise.allSettled([...Array(40)].map((_, i) => brain.remember(`Johnny requirement ${i} is item${i}x`, { about: "johnny" })));
  assert.deepEqual(res.filter((r) => r.status === "rejected").map((r) => r.reason.message), []);
  const text = (await store.read("projects/johnny.md")).content;
  assert.equal([...Array(40).keys()].filter((i) => text.includes(`item${i}x`)).length, 40);
  assert.deepEqual((await readdir(join(dir, "memory/projects"))).filter((f) => f.endsWith(".tmp")), []);
});

test("two processes writing the same entity at once: every fact kept (cross-process lock)", async () => {
  const { dir, store } = await vault();
  await store.queue;
  const worker = (tag) =>
    new Promise((resolve, reject) => {
      const code = `
        import { FileStore } from "${SRC}filestore.js";
        import { MemoryIndex } from "${SRC}search.js";
        import { Brain } from "${SRC}brain.js";
        const store = new FileStore({ dir: ${JSON.stringify(dir)}, autoPush: false });
        const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
        const r = await Promise.allSettled([...Array(15)].map((_, i) => brain.remember("Johnny ${tag} requirement " + i + " is ${tag}" + i + "x", { about: "johnny" })));
        console.log(JSON.stringify(r.filter((x) => x.status === "rejected").map((x) => x.reason.message)));`;
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", (c) => (c === 0 ? resolve(JSON.parse(out.trim() || "[]")) : reject(new Error(`worker ${tag} exited ${c}`))));
    });
  const [ea, eb] = await Promise.all([worker("a"), worker("b")]);
  assert.deepEqual([...ea, ...eb], []);
  const text = (await store.read("projects/johnny.md")).content;
  for (const tag of ["a", "b"]) assert.equal([...Array(15).keys()].filter((i) => text.includes(`${tag}${i}x`)).length, 15, `all ${tag} facts kept`);
});

test("a lock left behind by a crashed process is taken over", async () => {
  const { dir, store } = await vault();
  const { createHash } = await import("node:crypto");
  const lockDir = join(dir, ".git", "githippo-locks");
  await mkdir(lockDir, { recursive: true });
  const lock = join(lockDir, `${createHash("sha1").update("projects/johnny.md").digest("hex").slice(0, 16)}.lock`);
  await writeFile(lock, "99999\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const cur = await store.read("projects/johnny.md");
  const t0 = Date.now();
  await store.write("projects/johnny.md", `${cur.content}- after a crash\n`, cur.version);
  assert.ok(Date.now() - t0 < 5000 * speedFactor(), "didn't wait for the stale lock to time out");
  assert.match((await store.read("projects/johnny.md")).content, /after a crash/);
});

test("GitHub store: two writers on the same entity, all facts kept (409 + retries)", async () => {
  const { fakeGitHub } = await import("./fake-github.js");
  const { GitHubMemoryStore } = await import("../src/store.js");
  const gh = fakeGitHub();
  gh.seed("memory/projects/johnny.md", "---\nname: johnny\ntitle: Johnny\n---\n\n- Johnny is a voice assistant\n");
  const mk = () => { const store = new GitHubMemoryStore({ token: "t", repo: "a/b", fetchImpl: gh.fetchImpl }); return new Brain({ store, index: new MemoryIndex(store, null, {}) }); };
  const a = mk(), b = mk();
  const res = await Promise.allSettled([
    ...[...Array(20)].map((_, i) => a.remember(`Johnny requirement ${i} is a${i}x`, { about: "johnny" })),
    ...[...Array(10)].map((_, i) => b.remember(`Johnny requirement ${i} is b${i}x`, { about: "johnny" })),
  ]);
  assert.deepEqual(res.filter((r) => r.status === "rejected").map((r) => r.reason.message), []);
  const text = gh.text("memory/projects/johnny.md");
  assert.equal([...Array(20).keys()].filter((i) => text.includes(`a${i}x`)).length + [...Array(10).keys()].filter((i) => text.includes(`b${i}x`)).length, 30);
});
