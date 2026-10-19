// Fuzzing every public entry point with seeded, reproducible inputs, checking invariants rather than just "no crash":
// nothing hangs, nothing is written outside the vault, git stays clean, every note stays parseable, and the secrets guard's
// output never still contains a secret. Reproduce: FUZZ_SEED=<seed> node --test test/fuzz.test.js · scale: FUZZ_ITERATIONS=20
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileStore } from "../src/filestore.js";
import { MemoryIndex, tokenize } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { buildServer } from "../src/server.js";
import { parseFile, plain, stripMemoryTags } from "../src/parse.js";
import { scan, redact } from "../src/guard.js";
import { injectionKinds, defang } from "../src/injection.js";
import { terse } from "../src/terse.js";
import { timeWindow } from "../src/when.js";
import { KnowledgeGraph } from "../src/graph.js";
import { createMemoryTool, toRel } from "../src/memorytool.js";
import { applyOnBranch } from "../src/consolidate.js";
import { importReferenceMemory } from "../src/importer.js";
import { SEED, MULT, rng, pick, text, sentence, pathLike, jsonValue, argsFor, markdownish, NASTY } from "./fuzz-lib.js";

const ctxMsg = (extra) => `(reproduce with FUZZ_SEED=${SEED}) ${extra}`;
const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error(`fuzz-timeout: ${label}`)), ms));
const g = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString();

async function vault() {
  const base = await mkdtemp(join(tmpdir(), "fz-"));
  const dir = join(base, "vault");
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  return { base, dir, store, brain };
}
async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    e.isDirectory() ? await walk(p, out) : out.push(p);
  }
  return out;
}
/** What must be true of a vault no matter what was thrown at it. */
async function assertVaultSound({ base, dir, store }, label) {
  await store.queue;
  assert.deepEqual(await readdir(base), ["vault"], ctxMsg(`${label}: something was written outside the vault`));
  const tracked = g(dir, "ls-files").split("\n").filter(Boolean);
  for (const f of tracked) assert.ok(f.startsWith("memory/") || f === ".gitignore", ctxMsg(`${label}: tracked file outside memory/: ${f}`));
  assert.equal(g(dir, "status", "--porcelain").trim(), "", ctxMsg(`${label}: git left dirty`));
  const files = await walk(dir);
  for (const f of files) {
    const rel = relative(dir, f).split(sep).join("/");
    assert.ok(!rel.endsWith(".tmp"), ctxMsg(`${label}: temp file left behind: ${rel}`));
    if (!rel.startsWith("memory/") || !rel.endsWith(".md")) continue;
    const c = await readFile(f, "utf8");
    assert.ok(Buffer.byteLength(c) <= 64 * 1024 + 4096, ctxMsg(`${label}: oversized note ${rel}`));
    assert.ok(!c.includes("\u0000"), ctxMsg(`${label}: NUL byte stored in ${rel}`));
    assert.doesNotThrow(() => parseFile(rel.slice("memory/".length), c), ctxMsg(`${label}: unparseable note ${rel}`));
  }
}

test("fuzz: every MCP tool survives hostile arguments and the vault stays sound", async (t) => {
  const r = rng(SEED);
  const v = await vault();
  const caught = [];
  const onUncaught = (e) => caught.push(e);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.off("uncaughtException", onUncaught));
  await v.brain.remember("Johnny is a voice assistant running on the Mac mini", { about: "Johnny", kind: "project" });
  await v.brain.remember("Sam Okafor is the tech lead", { about: "Sam Okafor", kind: "person" });
  const server = buildServer(v.brain);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "fuzz", version: "1" }, { capabilities: {} });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.length >= 8);
  const N = 110 * MULT;
  const seen = new Map();
  for (let i = 0; i < N; i++) {
    const tool = pick(r, tools);
    const args = argsFor(tool.inputSchema, r);
    try {
      const res = await Promise.race([client.callTool({ name: tool.name, arguments: args }), timeout(15_000, `${tool.name} ${JSON.stringify(args).slice(0, 120)}`)]);
      seen.set(tool.name, (seen.get(tool.name) || 0) + 1);
      assert.ok(Array.isArray(res.content), ctxMsg(`${tool.name} returned no content`));
    } catch (e) {
      assert.ok(!/fuzz-timeout/.test(e.message), ctxMsg(e.message)); // a protocol-level rejection of bad arguments is fine; a hang is not
    }
  }
  assert.deepEqual(caught.map((e) => e.message), [], ctxMsg("uncaught exceptions"));
  assert.ok(tools.every((x) => seen.has(x.name)), ctxMsg(`every tool was exercised: ${[...seen.keys()]}`));
  const ok = await client.callTool({ name: "recall", arguments: { q: "Johnny" } });
  assert.ok(!ok.isError, ctxMsg("recall still works afterwards"));
  await assertVaultSound(v, "mcp tools");
});

test("fuzz: text functions never throw; the guard's output is clean and idempotent; chunk line references are real", () => {
  const r = rng(SEED + 1);
  const N = 1500 * MULT;
  for (let i = 0; i < N; i++) {
    const s = markdownish(r);
    const ctx = (what) => ctxMsg(`${what} on ${JSON.stringify(s.slice(0, 160))}`);
    for (const [name, fn] of Object.entries({ tokenize, plain, stripMemoryTags, scan, terse, injectionKinds, defang, timeWindow: (x) => timeWindow(x, 1_800_000_000_000) })) {
      assert.doesNotThrow(() => fn(s), ctx(name));
    }
    const red = redact(s);
    assert.deepEqual(scan(red.text).map((f) => f.kind), [], ctx("redacted text still contains a secret"));
    assert.equal(redact(red.text).text, red.text, ctx("redact is not idempotent"));
    if (!scan(s).length) assert.equal(red.text, s, ctx("redact changed text that had nothing to redact"));
    const content = `---\nname: x\n---\n\n${s}\n`;
    let parsed;
    assert.doesNotThrow(() => (parsed = parseFile("fuzz/x.md", content)), ctx("parseFile"));
    const lines = content.split("\n");
    const ids = new Set();
    for (const c of parsed.chunks) {
      assert.ok(c.line >= 1 && c.line <= lines.length, ctx(`chunk line ${c.line} outside 1..${lines.length}`));
      assert.ok(typeof c.text === "string" && c.text.length > 0 && typeof c.hash === "string", ctx("malformed chunk"));
      assert.ok(!ids.has(c.id), ctx(`duplicate chunk id ${c.id}`));
      ids.add(c.id);
    }
    assert.doesNotThrow(() => {
      const gr = new KnowledgeGraph([parsed, parseFile("people/sam-okafor.md", "---\ntitle: Sam Okafor\naliases: [Sam]\n---\n- x\n")]);
      gr.mentions(s);
      gr.autoLink(s);
    }, ctx("graph"));
  }
});

test("fuzz: STORE-level path validation: whatever normalizePath accepts stays inside the vault", async () => {
  const r = rng(SEED + 2);
  const { normalizePath } = await import("../src/store.js");
  const root = "/vault/memory";
  for (let i = 0; i < 4000 * MULT; i++) {
    const s = r() < 0.6 ? pathLike(r) : text(r, 40) + pick(r, ["", ".md", "/../x.md", "/./a.md", "%2e%2e/a.md", "\u202e.md"]);
    let p;
    try {
      p = normalizePath(s);
    } catch {
      continue;
    }
    const segs = p.split("/");
    assert.ok(segs.every((x) => x && x !== "." && x !== ".." && !x.startsWith(".")), ctxMsg(`accepted a traversal-ish path ${JSON.stringify(s)} → ${p}`));
    assert.ok(!/[\u0000-\u001f\\]/.test(p) && p.endsWith(".md"), ctxMsg(`accepted ${JSON.stringify(p)}`));
    assert.ok(join(root, p).startsWith(root + "/"), ctxMsg(`escapes the root: ${p}`));
  }
});

test("fuzz: the memory-tool backend: paths can't escape, random command sequences keep the vault sound", async () => {
  const r = rng(SEED + 3);
  for (let i = 0; i < 3000 * MULT; i++) {
    const s = r() < 0.5 ? "/memories/" + pathLike(r) : "/memories" + pick(r, ["", "/", "/..", "/../x", "/%2e%2e/x", "/a/../../x"]) + (r() < 0.5 ? text(r, 20) : "");
    try {
      const rel = toRel(s);
      assert.ok(!rel.split("/").some((x) => x === ".." || x === "." || x.startsWith(".")) && !/[\\\u0000]/.test(rel), ctxMsg(`toRel accepted ${JSON.stringify(s)} → ${rel}`));
    } catch (e) {
      assert.ok(/Error|must start/.test(e.message), ctxMsg(`toRel threw something odd: ${e.message}`));
    }
  }
  const v = await vault();
  const h = createMemoryTool(v.brain);
  const cmds = ["view", "create", "str_replace", "insert", "delete", "rename", "bogus", 5, null];
  for (let i = 0; i < 90 * MULT; i++) {
    const input = {
      command: pick(r, cmds), path: "/memories/" + pathLike(r), file_text: text(r, 80), old_str: pick(r, ["a", "the", text(r, 6)]), new_str: text(r, 30), insert_line: pick(r, [0, 1, 2, -1, 999, "x"]),
      insert_text: text(r, 30), old_path: "/memories/" + pathLike(r), new_path: "/memories/" + pathLike(r), view_range: pick(r, [[1, 2], [0, 0], [5, 1], [1, -1], "x"]),
    };
    const res = await Promise.race([h({ id: "t", input }), timeout(15_000, JSON.stringify(input).slice(0, 100))]);
    assert.equal(typeof res.content, "string", ctxMsg(`memory tool returned ${typeof res.content} for ${JSON.stringify(input).slice(0, 100)}`));
  }
  await assertVaultSound(v, "memory tool");
});

test("fuzz: untrusted model output (consolidation ops) never breaks the vault or leaves worktrees behind", async () => {
  const r = rng(SEED + 4);
  const v = await vault();
  await v.brain.remember("Sample rate is 16 kHz", { about: "Johnny", kind: "project" });
  await v.store.queue;
  const head = g(v.dir, "rev-parse", "HEAD").trim();
  for (let i = 0; i < 18 * MULT; i++) {
    const ops = [...Array(1 + Math.floor(r() * 5))].map(() => (r() < 0.2 ? jsonValue(r) : { op: pick(r, ["add", "supersede", "contradiction", "bogus", text(r, 5)]), fact: r() < 0.15 ? jsonValue(r) : sentence(r), about: r() < 0.3 ? text(r, 20) : "Johnny", old: pick(r, ["Sample rate is 16 kHz", text(r, 20), jsonValue(r)]), new: r() < 0.15 ? jsonValue(r) : sentence(r), a: text(r, 10), b: text(r, 10) }));
    let res;
    await assert.doesNotReject(async () => (res = await applyOnBranch({ vaultDir: v.dir, ops })), ctxMsg(`applyOnBranch threw for ${JSON.stringify(ops).slice(0, 200)}`));
    assert.equal(g(v.dir, "worktree", "list").trim().split("\n").length, 1, ctxMsg("worktree left behind"));
    assert.equal(g(v.dir, "rev-parse", "HEAD").trim(), head, ctxMsg("proposals touched main"));
    if (res.applied.length) g(v.dir, "branch", "-D", res.branch);
    else assert.equal(g(v.dir, "branch", "--list", "githippo/proposals-*").trim(), "", ctxMsg("empty proposal branch left behind"));
  }
  await assertVaultSound(v, "consolidation");
});

test("fuzz: the importer survives hostile memory.jsonl", async () => {
  const r = rng(SEED + 5);
  const v = await vault();
  for (let i = 0; i < 40 * MULT; i++) {
    const lines = [...Array(1 + Math.floor(r() * 8))].map(() => {
      const roll = r();
      if (roll < 0.15) return text(r, 40);
      if (roll < 0.25) return JSON.stringify(jsonValue(r));
      if (roll < 0.65) return JSON.stringify({ type: "entity", name: r() < 0.2 ? jsonValue(r) : pick(r, ["Ada", "Sam_Okafor", text(r, 12)]), entityType: r() < 0.2 ? jsonValue(r) : pick(r, ["person", "project", "organization", text(r, 8)]), observations: r() < 0.2 ? jsonValue(r) : [...Array(Math.floor(r() * 4))].map(() => (r() < 0.2 ? jsonValue(r) : r() < 0.1 ? "z ".repeat(5000) : sentence(r))) });
      return JSON.stringify({ type: "relation", from: pick(r, ["Ada", "Sam_Okafor", text(r, 8)]), to: r() < 0.2 ? jsonValue(r) : pick(r, ["Ada", text(r, 8)]), relationType: r() < 0.2 ? jsonValue(r) : pick(r, ["works_on", text(r, 10)]) });
    });
    await assert.doesNotReject(importReferenceMemory(v.brain, lines.join("\n")), ctxMsg(`importer threw on ${JSON.stringify(lines).slice(0, 200)}`));
  }
  await assertVaultSound(v, "importer");
});

test("fuzz: hooks given garbage on stdin always exit 0, quickly, with valid output", async () => {
  const CLI = new URL("../src/cli.js", import.meta.url).pathname;
  const home = await mkdtemp(join(tmpdir(), "fzh-"));
  const inputs = ["", "not json", "null", "[]", "5", '"x"', "{}", '{"transcript_path": 5, "cwd": {"a": 1}, "session_id": []}', "{".repeat(20_000), "[".repeat(200_000), JSON.stringify({ transcript_path: "/etc/passwd", cwd: "/tmp", session_id: "s", prompt: "hello there" }), JSON.stringify({ transcript_path: "/nonexistent/x.jsonl", cwd: "/tmp", source: "compact", prompt: "x".repeat(50_000) }), "\u0000\u0001\u0002\ud800", "x".repeat(2_000_000)];
  const events = ["precompact", "postcompact", "session-end", "session-start", "prompt", "statusline"];
  const jobs = events.flatMap((ev) => inputs.map((input) => ({ ev, input })));
  const runOne = ({ ev, input }) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const args = ev === "statusline" ? [CLI, "statusline"] : [CLI, "hook", ev];
      const p = spawn(process.execPath, args, { env: { PATH: process.env.PATH, GITHIPPO_HOME: home, VAULT_DIR: join(home, "v"), EMBEDDINGS: "none", STORE: "local" }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", () => {});
      p.stdin.on("error", () => {});
      p.stdin.end(input);
      const killer = setTimeout(() => p.kill("SIGKILL"), 15_000);
      p.on("close", (code) => (clearTimeout(killer), resolve({ ev, code, out, ms: Date.now() - t0, input })));
    });
  const results = [];
  for (let i = 0; i < jobs.length; i += 8) results.push(...(await Promise.all(jobs.slice(i, i + 8).map(runOne))));
  for (const x of results) {
    const label = `${x.ev} with ${JSON.stringify(x.input.slice(0, 40))}`;
    assert.equal(x.code, 0, `${label}: exit ${x.code}`);
    assert.ok(x.ms < 10_000, `${label}: took ${x.ms} ms`);
    if (x.ev !== "statusline" && x.out.trim()) assert.doesNotThrow(() => JSON.parse(x.out), `${label}: stdout isn't JSON: ${x.out.slice(0, 80)}`);
  }
});
