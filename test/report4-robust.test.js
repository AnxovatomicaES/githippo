// Fourth external report (performance and robustness).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileStore } from "../src/filestore.js";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { withFileLock } from "../src/lock.js";
import { promptRecall } from "../src/hooks.js";
import { renderCheckpoint, parseTranscript } from "../src/transcript.js";
import { collect } from "../scripts/versions.mjs";
import { parseFile } from "../src/parse.js";
import { KnowledgeGraph, startsSentence } from "../src/graph.js";
import { speedFactor } from "./helpers.js";

const SRC = new URL("../src/", import.meta.url).pathname;
const CLI = join(SRC, "cli.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("PERF: thousands of broken links no longer make every write take seconds", async () => {
  const store = new InMemoryStore();
  for (let i = 0; i < 3000; i++) await store.write(`topics/n${i}.md`, `---\nname: n${i}\n---\n\n- note ${i} mentions [[missing-${i}]] and [[ghost-${i % 50}]]\n`, "new");
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  let t = Date.now();
  await brain.index.sync({ maxAgeMs: 0 });
  assert.ok(Date.now() - t < 6000 * speedFactor(), `cold sync took ${Date.now() - t} ms`);
  t = Date.now();
  for (let i = 0; i < 3; i++) await brain.remember(`Sample fact ${i} about quokkas and pelicans`, { about: "zoology" });
  assert.ok((Date.now() - t) / 3 < 1200 * speedFactor(), `a remember took ${Math.round((Date.now() - t) / 3)} ms (it was ~2800 ms)`);
  // the word index still resolves partial names exactly as before: unique → resolved, ambiguous → not
  await store.write("people/hersh-oberoi.md", "---\nname: hersh-oberoi\ntitle: Hersh Oberoi\n---\n\n- Head of Research\n", "new");
  await store.write("people/hersh-patel.md", "---\nname: hersh-patel\ntitle: Hersh Patel\n---\n\n- Intern\n", "new");
  await brain.index.sync({ maxAgeMs: 0 });
  assert.equal(brain.graph.resolve("Oberoi"), "hersh-oberoi");
  assert.equal(brain.graph.resolve("Hersh"), null, "two people named Hersh: don't guess");
});

test("PERF: the prompt hook stays fast on a 50,000-chunk vault", async (ctx) => {
  const words = "alpha beta gamma delta kappa lambda sigma omega billing deploy cache queue index vector stream parse render shard tenant invoice ledger".split(" ");
  let a = 7;
  const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const mk = (id, path, text, title = "Note") => ({ id, path, line: 1, text, embedText: `${title}\n${text}` });
  const chunks = Array.from({ length: 50000 }, (_, i) => mk(`p${i % 900}.md#${i}`, `topics/p${i % 900}.md`, `- ${Array.from({ length: 40 }, () => words[Math.floor(rnd() * words.length)]).join(" ")} item${i}`));
  chunks.push(mk("projects/johnny.md#0", "projects/johnny.md", "- Johnny wake word detection runs on a 16 kHz sample rate with quokka tuning", "Johnny"));
  const dir = await mkdtemp(join(tmpdir(), "snap-"));
  ctx.after(() => rm(dir, { recursive: true, force: true })); // ~15 MB
  await writeFile(join(dir, "snapshot.json"), JSON.stringify({ at: Date.now(), chunks }));
  const t = Date.now();
  const out = await promptRecall({ prompt: "what sample rate does the Johnny wake word use", session_id: `s${Math.random()}` }, { cacheDir: dir });
  const ms = Date.now() - t;
  assert.ok(ms < 2500 * speedFactor(), `took ${ms} ms (it was ~4000 ms, against a 5000 ms hook timeout)`);
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /projects\/johnny\.md/);
});

test("lock: a slow holder keeps its lock (heartbeat), and a holder never deletes a lock that is no longer its own", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lock-"));
  const events = [];
  const holder = withFileLock(dir, "k", async () => {
    events.push("A in");
    await sleep(1600); // longer than staleMs: without a heartbeat B would steal the lock at ~600 ms
    events.push("A out");
  }, { staleMs: 600, timeoutMs: 10_000 });
  await sleep(100);
  const contender = withFileLock(dir, "k", async () => events.push("B in"), { staleMs: 600, timeoutMs: 10_000 });
  await Promise.all([holder, contender]);
  assert.deepEqual(events, ["A in", "A out", "B in"], "B waited for the slow holder");
  // a lock judged stale and re-taken by someone else must survive the original holder finishing
  let taken;
  await withFileLock(dir, "k3", async () => {
    const { readdirSync, writeFileSync } = await import("node:fs");
    taken = join(dir, readdirSync(dir).filter((f) => f.endsWith(".lock"))[0]);
    writeFileSync(taken, "someone-else.token\n"); // another process re-took it
  });
  assert.ok(existsSync(taken), "the other holder's lock was not deleted by us");
});
test("checkpoints: a malformed todo (null, a string, a number) never loses the checkpoint", () => {
  const L = (o) => JSON.stringify(o);
  const tr = parseTranscript([
    L({ type: "user", cwd: "/x/app", message: { content: "Fix the login bug" } }),
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [null, "just text", 5, { content: "Write the test", status: "pending" }, { status: "completed" }] } }] } }),
  ].join("\n"));
  const { text } = renderCheckpoint(tr, { sessionId: "s1" });
  assert.match(text, /- \[ \] Write the test/);
  assert.match(text, /## Goal/);
  // and when a bad list reaches the renderer directly
  assert.doesNotThrow(() => renderCheckpoint({ prompts: ["x"], files: new Map(), commands: [], todos: [null, 3, "x", { content: "ok" }], errors: [] }, { sessionId: "s" }));
});

test("snapshot: written atomically, so a hook reading while it's rewritten never sees half a file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "snapw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new FileStore({ dir: join(dir, "v"), autoPush: false }).ensure();
  for (let i = 0; i < 200; i++) await store.write(`topics/n${i}.md`, `---\nname: n${i}\n---\n\n- note number ${i} ${"lorem ipsum ".repeat(30)}\n`, "new");
  const cacheDir = join(dir, "cache");
  const index = new MemoryIndex(store, null, { cacheDir });
  await index.sync({ maxAgeMs: 0 });
  await index.writeSnapshot();
  let stop = false;
  const bad = [];
  const reader = (async () => {
    while (!stop) {
      try {
        JSON.parse(await readFile(join(cacheDir, "snapshot.json"), "utf8"));
      } catch (e) {
        bad.push(e.message.slice(0, 60));
      }
      await sleep(1);
    }
  })();
  for (let i = 0; i < 40; i++) await Promise.all([index.writeSnapshot(), index.writeSnapshot()]);
  stop = true;
  await reader;
  assert.deepEqual(bad, []);
});

test("hook input: large accented text arrives intact (multi-byte characters split across chunks)", async () => {
  const unit = "¿Qué hay de nuevo con la reunión de 日本語 ñandú? ";
  const prompt = unit.repeat(8000);
  // (the child rebuilds the expected text itself: 360 KB wouldn't fit on a command line)
  const script = `const { readStdin } = await import(${JSON.stringify(pathToFileURL(join(SRC, "hooks.js")).href)}); const i = await readStdin(); process.stdout.write(JSON.stringify({ same: i.prompt === ${JSON.stringify(unit)}.repeat(8000), bad: i.prompt.includes("\\uFFFD"), n: i.prompt.length }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify({ prompt, session_id: "s", cwd: 5 }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bad, false, "no replacement characters");
  assert.equal(out.same, true);
});

test("sync: running out of file handles aborts the sync instead of emptying the index", async () => {
  class Flaky extends InMemoryStore {
    fail = false;
    async read(p, ref) {
      if (this.fail) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      return super.read(p, ref);
    }
  }
  const store = new Flaky();
  for (let i = 0; i < 5; i++) await store.write(`topics/n${i}.md`, `---\nname: n${i}\n---\n\n- note ${i}\n`, "new");
  const index = new MemoryIndex(store, null, {});
  await index.sync({ maxAgeMs: 0 });
  assert.equal(index.files.size, 5);
  await store.write("topics/n9.md", "---\nname: n9\n---\n\n- new note\n", "new");
  store.fail = true;
  await assert.rejects(index.sync({ maxAgeMs: 0 }), /EMFILE/);
  assert.equal(index.files.size, 5, "the index was left as it was, not emptied");
  store.fail = false;
  await index.sync({ maxAgeMs: 0 });
  assert.equal(index.files.size, 6, "and it recovers on the next sync");
});

test("versions: every pinned tag in a file is checked, and doctor exits non-zero when a check fails", async () => {
  const keys = Object.keys(collect()).filter((k) => k.startsWith("README.md (pinned tag"));
  assert.ok(keys.length >= 2 && keys.every((k) => /#\d+\)$/.test(k)), keys.join(" | "));
  const home = await mkdtemp(join(tmpdir(), "r4d-"));
  const env = { PATH: "/usr/bin:/bin", HOME: home, GITHIPPO_HOME: join(home, "g"), STORE: "local", VAULT_DIR: join(home, "vault"), EMBEDDINGS: "none" };
  const r = spawnSync(process.execPath, [CLI, "doctor"], { env, encoding: "utf8" });
  assert.match(r.stdout, /✗ Claude Code hooks installed/);
  assert.equal(r.status, 1, "a ✗ line means a failing exit code");
});

test("recall: a pack never goes over its token budget", async () => {
  const store = new InMemoryStore();
  for (let i = 0; i < 60; i++) await store.write(`topics/t${i}.md`, `---\nname: t${i}\n---\n\n${Array.from({ length: 6 }, (_, j) => `- Deployment fact ${i}-${j}: the pelican release pipeline uses blue green rollout with canary stage number ${j} and rollback window`).join("\n")}\n`, "new");
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  for (const budget of [100, 150, 200, 333, 500, 1200, 4000]) {
    const r = await brain.recall("pelican release pipeline deployment", { mode: "pack", budget });
    assert.ok(r.tokens <= budget, `budget ${budget}: pack is ${r.tokens} tokens`);
  }
});

test("PERF: two quadratic hot spots are gone (stamp detection on one long line, name matching over repeated names)", () => {
  const N = 64 * 1024;
  const S = speedFactor();
  const t0 = performance.now();
  const stamps = "<!--+2026".repeat(N / 9);
  parseFile("x.md", `---\nname: x\n---\n\n- ${stamps}\n`);
  const parse = performance.now() - t0;
  assert.ok(parse < 150 * S, `parseFile on a long line of stamp openers took ${Math.round(parse)} ms (it was ~430 ms and quadratic)`);
  const g = new KnowledgeGraph([parseFile("people/mark-lee.md", "---\ntitle: Mark Lee\naliases: [Mark]\n---\n- x\n")]);
  const t1 = performance.now();
  g.mentions("Mark Lee ".repeat(N / 9));
  g.autoLink("Mark Lee ".repeat(N / 9));
  const names = performance.now() - t1;
  assert.ok(names < 300 * S, `mentions+autoLink over 7,000 names took ${Math.round(names)} ms (it was ~500 ms and quadratic)`);
  // marking still works after the stamp pattern became fixed-width
  assert.match(parseFile("x.md", "---\nname: x\n---\n\n- Web claim <!--+2026-03-04 src:external-->\n- Own fact <!--+2026-03-04 src:user-->\n").chunks[0].text, /- \[external\] Web claim\n- Own fact/);
});

test("the sentence-start check behaves exactly like the regex it replaced", () => {
  let a = 12345;
  const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const alphabet = [".", "!", "?", " ", "\n", "\t", "\u00a0", "\u2003", "a", "B", "-", ","];
  let compared = 0;
  for (let i = 0; i < 20000; i++) {
    let text = "";
    for (let j = 0, len = Math.floor(rnd() * 14); j < len; j++) text += alphabet[Math.floor(rnd() * alphabet.length)];
    for (let pos = 0; pos <= text.length; pos++, compared++) assert.equal(startsSentence(text, pos), /(^|[.!?]\s+)$/.test(text.slice(0, pos)), JSON.stringify([text, pos]));
  }
  assert.ok(compared > 100000);
});
