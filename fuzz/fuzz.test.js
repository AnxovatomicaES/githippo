// Seeded fuzzing of every public entry point, checking invariants (not just "didn't crash").
// Not part of `npm test` (each file there gets 60 s; this one takes 25-40 s alone and far longer on a busy CI runner).
// Run it with:          npm run fuzz            (FUZZ_SEED=<n> FUZZ_ITERATIONS=<k> to reproduce or go deeper)
// Reproduce a failure:  FUZZ_SEED=<seed> FUZZ_ITERATIONS=1 node --test fuzz/fuzz.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rng, text, mdish, json, argsFor, withTimeout, SEED, K, NASTY } from "./fuzz-lib.js";
import { FileStore } from "../src/filestore.js";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex, tokenize } from "../src/search.js";
import { Brain, matchLine } from "../src/brain.js";
import { buildServer } from "../src/server.js";
import { parseFile, plain, stripMemoryTags } from "../src/parse.js";
import { scan, redact } from "../src/guard.js";
import { terse } from "../src/terse.js";
import { defang, injectionKinds } from "../src/injection.js";
import { timeWindow } from "../src/when.js";
import { KnowledgeGraph, maskSpans } from "../src/graph.js";
import { createMemoryTool, toRel } from "../src/memorytool.js";
import { applyOnBranch } from "../src/consolidate.js";
import { importReferenceMemory } from "../src/importer.js";
import { createHttpApp } from "../src/http.js";
import { Accounts } from "../src/accounts.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const slow = { timeout: 240_000 };
const silent = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};
const walk = async (dir, skip = [".git"]) => {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, skip)));
    else out.push(p);
  }
  return out;
};
const validNotePath = (p) => p.endsWith(".md") && !p.includes("\0") && !p.startsWith("/") && p.split("/").every((s) => s && s !== ".." && s !== "." && !s.startsWith("."));

// ---------------------------------------------------------------------------------------------
test(`text functions never throw, stay fast and keep their guarantees (seed ${SEED})`, () => {
  const r = rng(SEED);
  const failures = [];
  const g = new KnowledgeGraph([parseFile("people/ada-lovelace.md", "---\ntitle: Ada Lovelace\naliases: [Ada]\n---\n- x\n")]);
  for (let i = 0; i < 700 * K; i++) {
    const x = r.chance(0.5) ? mdish(r) : text(r, 25);
    const bad = (what) => failures.push(`${what} :: ${JSON.stringify(x.slice(0, 160))}`);
    const t0 = performance.now();
    try {
      const rd = redact(x);
      if (scan(rd.text).length) bad("redact leaves something detectable");
      if (!scan(x).length && rd.text !== x) bad("redact changed text although nothing was found");
      if (redact(rd.text).text !== rd.text) bad("redact is not idempotent");
      if (/<private>/i.test(stripMemoryTags(x).text)) bad("stripMemoryTags left a <private> tag");
      if (tokenize(x).some((t) => !t || /\s/.test(t))) bad("tokenize produced an empty or spaced token");
      const w = timeWindow(x, Date.parse("2026-10-17T12:00:00Z"));
      if (w && !(w.from <= w.to)) bad("timeWindow from > to");
      const nl = x.split("\n").length;
      for (const c of parseFile("topics/f.md", x).chunks) if (!(c.line >= 1 && c.line <= Math.max(nl, 1))) bad(`chunk line ${c.line} outside 1..${nl}`);
      defang(x); injectionKinds(x); terse(x); plain(x); maskSpans(x); g.mentions(x);
      if (!/\[\[|<!--/.test(x) && plain(g.autoLink(x).text) !== x) bad("autoLink changes the visible text");
    } catch (e) {
      bad(`threw: ${e.message}`);
    }
    const ms = performance.now() - t0;
    if (ms > 500) bad(`slow: ${Math.round(ms)} ms`);
  }
  assert.deepEqual(failures.slice(0, 6), [], `seed ${SEED}: ${failures.length} failure(s)`);
});

// ---------------------------------------------------------------------------------------------
test(`MCP tools: hostile arguments never crash, hang or corrupt the vault (seed ${SEED})`, slow, async () => {
  const r = rng(SEED + 1);
  const parent = await mkdtemp(join(tmpdir(), "fz-"));
  const dir = join(parent, "vault");
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  const server = buildServer(brain);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "fuzz", version: "1" }, { capabilities: {} });
  await client.connect(b);
  const { tools } = await client.listTools();
  const crashes = [];
  const onCrash = (e) => crashes.push(String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  const tally = { ok: 0, rejected: 0, per: {} };
  const hung = [];
  await silent(async () => {
    for (let i = 0; i < 160 * K; i++) {
      const tool = r.pick(tools);
      const args = argsFor(tool, r);
      try {
        const res = await withTimeout(client.callTool({ name: tool.name, arguments: args }), 20_000, tool.name);
        tally[res.isError ? "rejected" : "ok"]++;
        tally.per[tool.name] = (tally.per[tool.name] || 0) + 1;
      } catch (e) {
        if (/timed out/.test(e.message)) hung.push(`${tool.name} ${JSON.stringify(args).slice(0, 120)}`);
        else tally.rejected++; // a protocol-level rejection (invalid params) is a fine answer
      }
    }
  });
  process.off("uncaughtException", onCrash);
  process.off("unhandledRejection", onCrash);
  await store.queue;
  assert.deepEqual(hung, [], `seed ${SEED}: calls that hung`);
  assert.deepEqual(crashes, [], `seed ${SEED}: uncaught errors`);
  assert.ok(tally.ok > 10, `fuzzing should reach real code paths too (${JSON.stringify(tally)})`);
  // invariants on what's left behind
  assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString().trim(), "", "everything written was committed");
  const files = await walk(dir);
  for (const f of files) {
    const rel = relative(dir, f);
    assert.ok(rel === ".gitignore" || rel.startsWith("memory/"), `file outside the memory folder: ${rel}`);
    assert.ok(!rel.endsWith(".tmp"), `leftover temp file: ${rel}`);
    if (!rel.endsWith(".md")) continue;
    const content = await readFile(f, "utf8");
    assert.ok(Buffer.byteLength(content) <= 64 * 1024 + 4096, `${rel} is ${Buffer.byteLength(content)} bytes`);
    assert.ok(!content.includes("\0"), `${rel} contains a NUL byte`);
    assert.doesNotThrow(() => parseFile(rel.replace(/^memory\//, ""), content), `${rel} no longer parses`);
  }
  assert.deepEqual(await readdir(parent), ["vault"], "nothing was created next to the vault");
  await silent(async () => {
    await brain.recall("johnny", { mode: "brief" });
    await brain.maintain({});
  });
});

// ---------------------------------------------------------------------------------------------
test(`memory-tool backend: hostile paths and random operations stay inside the vault, and a failed operation changes nothing (seed ${SEED})`, slow, async () => {
  const r = rng(SEED + 2);
  const store = new InMemoryStore();
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  const h = createMemoryTool(brain);
  const GOOD = ["/memories/a.txt", "/memories/dir/b.txt", "/memories/dir/sub/c.txt", "/memories/Ω x.txt", "/memories/n.md", "/memories/dir2/d.md", "/memories/笔记.txt"];
  const DIRS = ["/memories/dir", "/memories/dir/sub", "/memories/dir2"];
  const BAD = ["/memories/../x", "/etc/passwd", "/memories/.h", "/memories/a\\b", "/memories/%2e%2e/x", "/memories/a/../../b", "/memories", "/memories/", "memories/a", "", "/memories/a\u0000b", "/memories//a", "/memories/dir/../../x", "/memories/%252e%252e/y", "/memories/" + "a".repeat(300)];
  const snap = async () => {
    const m = new Map();
    for (const f of await store.list()) m.set(f.path, (await store.read(f.path)).content);
    return m;
  };
  const same = (x, y) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
  // expected names come from the real path normaliser ("/memories//a" is "a", as on any filesystem)
  const stored = (p) => {
    const rel = toRel(p);
    return rel.endsWith(".md") ? rel : `${rel}.md`;
  };
  const prefixOf = (p) => `${toRel(p)}/`;
  const problems = [];
  await silent(async () => {
    for (let i = 0; i < 260 * K; i++) {
      const before = await snap();
      const path = r.chance(0.18) ? r.pick(BAD) : r.pick([...GOOD, ...GOOD, ...DIRS]);
      const op = r.pick(["create", "create", "create", "view", "str_replace", "insert", "delete", "rename"]);
      const existing = [...before.values()];
      let input;
      if (op === "create") input = { command: "create", path, file_text: r.chance(0.2) ? mdish(r) : text(r) };
      else if (op === "view") input = { command: "view", path, ...(r.chance(0.3) ? { view_range: [r.int(4) - 1, r.int(6) - 2] } : {}) };
      else if (op === "str_replace") input = { command: "str_replace", path, old_str: existing.length && r.chance(0.6) ? r.pick(existing).slice(0, 8) : text(r, 2), new_str: text(r, 3) };
      else if (op === "insert") input = { command: "insert", path, insert_line: r.int(10) - 2, insert_text: text(r, 3) };
      else if (op === "delete") input = { command: "delete", path };
      else input = { command: "rename", old_path: path, new_path: r.chance(0.15) ? r.pick(BAD) : r.pick([...GOOD, ...DIRS]) };
      let res;
      try {
        res = await h({ id: "t", input });
      } catch (e) {
        problems.push(`threw instead of returning an error: ${op} ${JSON.stringify(input).slice(0, 100)}: ${e.message}`);
        continue;
      }
      const after = await snap();
      const tag = `${op} ${JSON.stringify(input).slice(0, 110)}`;
      for (const p of after.keys()) if (!validNotePath(p)) problems.push(`invalid stored path ${JSON.stringify(p)} after ${tag}`);
      if (res.is_error || op === "view") {
        if (!same(before, after)) problems.push(`${res.is_error ? "failed" : "view"} operation changed the vault: ${tag}`);
        continue;
      }
      // exactly what was sent, except that <private> spans are removed (on every write route, like remember)
      const expectedText = (t) => (/<\/?(?:private|githippo-context|system-reminder)\b/i.test(t) ? stripMemoryTags(t).text + (/\n$/.test(t) ? "\n" : "") : t);
      if (op === "create" && after.get(stored(path)) !== expectedText(input.file_text)) problems.push(`create didn't store the text exactly: ${tag}`);
      if (op === "delete" && [...after.keys()].some((k) => k === stored(path) || k.startsWith(prefixOf(path)))) problems.push(`delete left something behind: ${tag}`);
      if (op === "rename") {
        const was = before.get(stored(input.old_path));
        if (was !== undefined && (after.has(stored(input.old_path)) || after.get(stored(input.new_path)) !== was)) problems.push(`rename of a file didn't move it intact: ${tag}`);
        if (was === undefined) {
          const moved = [...before].filter(([k]) => k.startsWith(prefixOf(input.old_path)));
          for (const [k, v] of moved) {
            const to = prefixOf(input.new_path) + k.slice(prefixOf(input.old_path).length);
            if (after.has(k) || after.get(to) !== v) problems.push(`rename of a folder didn't move ${k} intact: ${tag}`);
          }
        }
      }
    }
  });
  assert.deepEqual(problems.slice(0, 6), [], `seed ${SEED}: ${problems.length} problem(s)`);
});

// ---------------------------------------------------------------------------------------------
test(`hooks: hostile payloads never hang, throw internally or write outside the vault (seed ${SEED})`, slow, async (t) => {
  const r = rng(SEED + 3);
  const parent = await mkdtemp(join(tmpdir(), "fzh-"));
  t.after(() => rm(parent, { recursive: true, force: true })); // holds a 30 MB transcript
  const home = join(parent, "home");
  const env = { PATH: process.env.PATH, HOME: home, GITHIPPO_HOME: home, VAULT_DIR: join(home, "vault"), STORE: "local", EMBEDDINGS: "none" };
  const tdir = join(parent, "transcripts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(tdir, { recursive: true });
  const L = (o) => JSON.stringify(o);
  const files = { valid: join(tdir, "valid.jsonl"), hostile: join(tdir, "hostile.jsonl"), garbage: join(tdir, "garbage.jsonl"), empty: join(tdir, "empty.jsonl"), bigline: join(tdir, "bigline.jsonl") };
  await writeFile(files.valid, [L({ type: "user", cwd: "/x/app", message: { content: "Fix the login bug" } }), L({ type: "assistant", message: { content: [{ type: "text", text: "Looking into it" }] } })].join("\n"));
  await writeFile(files.hostile, Array.from({ length: 40 }, () => L({ type: r.pick(["user", "assistant", "summary", text(r, 2)]), cwd: json(r), message: json(r), sessionId: json(r) })).join("\n"));
  await writeFile(files.garbage, Buffer.from(Array.from({ length: 5000 }, () => r.int(256))));
  await writeFile(files.empty, "");
  await writeFile(files.bigline, L({ type: "user", message: { content: "y".repeat(30_000_000) } })); // one 30 MB line
  const raw = [Buffer.alloc(0), Buffer.from("null"), Buffer.from("[]"), Buffer.from('"x"'), Buffer.from("5"), Buffer.from("{"), Buffer.from([0, 1, 2, 255, 254]), Buffer.from("[".repeat(100_000)), Buffer.alloc(2_500_000, "x")];
  const base = () => ({ session_id: "s1", transcript_path: files.valid, cwd: "/x/app", prompt: "what about the login bug", source: "startup", hook_event_name: "x", trigger: "auto", custom_instructions: "" });
  const hostile = (k) => {
    switch (k) {
      case "transcript_path": return r.pick([...Object.values(files), "/nonexistent/t.jsonl", tdir, "/dev/null", "../../etc/passwd", "", json(r)]);
      case "session_id": return r.pick(["../../x", "a/../../b", "", "é", ".", "..", "a/b/c", "x".repeat(300), json(r)]);
      case "cwd": return r.pick(["../../../etc", "/", "", "/tmp", "C:\\x", "x".repeat(5000), json(r)]);
      case "prompt": return r.pick(["x".repeat(200_000), "", text(r), json(r)]);
      default: return json(r);
    }
  };
  const events = [["hook", "precompact"], ["hook", "postcompact"], ["hook", "session-end"], ["hook", "session-start"], ["hook", "prompt"], ["statusline"]];
  const problems = [];
  const INTERNAL = /TypeError|RangeError|ReferenceError|Cannot read|is not a function|is not iterable|is not defined|Maximum call stack|Invalid string length/;
  for (const ev of events) {
    for (let i = 0; i < Math.max(8, 8 * K); i++) {
      let input;
      if (i < 3) input = raw[(i * 3 + events.indexOf(ev)) % raw.length];
      else {
        const o = base();
        for (let n = 0, m = 1 + r.int(3); n < m; n++) {
          const k = r.pick(Object.keys(o));
          o[k] = hostile(k);
        }
        input = Buffer.from(JSON.stringify(o));
      }
      const t0 = Date.now();
      const res = spawnSync(process.execPath, [CLI, ...ev], { input, env, encoding: "utf8", timeout: 25_000, maxBuffer: 64 * 1024 * 1024 });
      const ms = Date.now() - t0;
      const tag = `${ev.join(" ")} #${i} (${input.length} bytes) ${input.length < 300 ? input.toString().slice(0, 160) : ""}`;
      if (res.error) problems.push(`${tag}: ${res.error.message}`);
      else if (res.status !== 0) problems.push(`${tag}: exit ${res.status}`);
      if (ms > 8000) problems.push(`${tag}: took ${ms} ms`);
      const internal = String(res.stderr).split("\n").find((l) => INTERNAL.test(l));
      if (internal) problems.push(`${tag}: internal error swallowed by the hook: ${internal.slice(0, 140)}`);
      if (["session-start", "prompt"].includes(ev[1]) && res.stdout.trim()) {
        try {
          JSON.parse(res.stdout);
        } catch {
          problems.push(`${tag}: stdout isn't JSON: ${res.stdout.slice(0, 60)}`);
        }
      }
    }
  }
  assert.deepEqual(problems.slice(0, 6), [], `seed ${SEED}: ${problems.length} problem(s)`);
  assert.ok(existsSync(home), "the fuzz never reached the checkpoint code (no state was created)");
  const stray = (await walk(parent, [".git"])).filter((f) => !f.startsWith(home) && !f.startsWith(tdir));
  assert.deepEqual(stray, [], "no files outside home and the transcripts we made");
  assert.deepEqual((await readdir(parent)).filter((n) => !["home", "transcripts"].includes(n)), [], "nothing was created next to the vault");
});

// ---------------------------------------------------------------------------------------------
test(`consolidation: hostile model output never throws, never touches main, never leaves a worktree or branch behind (seed ${SEED})`, slow, async () => {
  const r = rng(SEED + 4);
  const dir = await mkdtemp(join(tmpdir(), "fzc-"));
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  await store.write("projects/johnny.md", "---\nname: johnny\ntitle: Johnny\n---\n\n- Sample rate is 16 kHz\n- Needs a wake word\n", "new");
  await store.write("people/ada.md", "---\nname: ada\ntitle: Ada\n---\n\n- Prefers tea\n", "new");
  await store.queue;
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString().trim();
  const opFor = () => {
    if (r.chance(0.12)) return r.pick([null, 5, "x", [], true, undefined]);
    return {
      op: r.pick(["add", "add", "supersede", "contradiction", "delete", "", null, 5, text(r, 2)]),
      fact: r.chance(0.7) ? text(r) : json(r),
      about: r.pick([null, undefined, text(r, 2), "../../x", "Ada", "Johnny", json(r)]),
      old: r.chance(0.5) ? r.pick(["Sample rate is 16 kHz", "Prefers tea", text(r)]) : json(r),
      new: r.chance(0.7) ? text(r) : json(r),
      a: text(r, 3), b: text(r, 3), note: json(r),
    };
  };
  const problems = [];
  await silent(async () => {
    for (let i = 0; i < 20 * K; i++) {
      const ops = Array.from({ length: r.int(8) }, opFor);
      const main = git("rev-parse", "main");
      let res;
      try {
        res = await applyOnBranch({ vaultDir: dir, ops });
      } catch (e) {
        problems.push(`#${i} threw: ${e.message.split("\n")[0].slice(0, 100)} for ${JSON.stringify(ops).slice(0, 140)}`);
        continue;
      }
      if (!Array.isArray(res.applied) || !Array.isArray(res.rejected) || !Array.isArray(res.contradictions)) problems.push(`#${i} malformed result`);
      if (git("rev-parse", "main") !== main) problems.push(`#${i} main moved`);
      if (git("worktree", "list").split("\n").length !== 1) problems.push(`#${i} worktree left behind`);
      const branches = git("branch", "--list", "githippo/proposals-*").split("\n").map((b) => b.replace(/^[*+ ]+/, "").trim()).filter(Boolean);
      if (!res.applied.length && branches.length) problems.push(`#${i} empty proposal left a branch`);
      for (const b of branches) git("branch", "-D", b);
      if (git("status", "--porcelain")) problems.push(`#${i} working tree dirty`);
    }
  });
  assert.deepEqual(problems.slice(0, 6), [], `seed ${SEED}: ${problems.length} problem(s)`);
});

// ---------------------------------------------------------------------------------------------
test(`importer: hostile JSONL never throws and never writes outside the memory folder (seed ${SEED})`, slow, async () => {
  const r = rng(SEED + 5);
  const problems = [];
  for (let round = 0; round < 12 * K; round++) {
    const store = new InMemoryStore();
    const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
    const lines = Array.from({ length: 5 + r.int(25) }, () => {
      const k = r.int(10);
      if (k === 0) return text(r, 4);
      if (k === 1) return "null";
      if (k === 2) return "[]";
      if (k === 3) return "{" + text(r, 2);
      if (k === 4) return JSON.stringify({ type: "entity", name: r.pick(["../../x", "__proto__", "A/B", "", "x".repeat(300), "é笔记", text(r, 3)]), entityType: json(r), observations: r.chance(0.5) ? [text(r), json(r), text(r)] : json(r) });
      if (k === 5) return JSON.stringify({ type: "relation", from: r.pick(["Ada", "../x", text(r, 2)]), to: r.pick(["Ada", "Bob", text(r, 2), json(r)]), relationType: json(r) });
      return JSON.stringify({ type: r.pick(["entity", "relation", text(r, 1)]), name: text(r, 3), entityType: r.pick(["person", "project", "organization", "decision", text(r, 1)]), observations: Array.from({ length: r.int(4) }, () => text(r, 8)), from: "Ada", to: "Bob" });
    });
    try {
      const res = await silent(() => importReferenceMemory(brain, lines.join("\n")));
      for (const k of ["entities", "facts", "relations", "duplicates", "blocked", "rejected", "skippedLines"]) if (!Number.isFinite(res[k])) problems.push(`round ${round}: ${k} = ${res[k]}`);
    } catch (e) {
      problems.push(`round ${round} threw: ${e.message.split("\n")[0].slice(0, 120)}`);
      continue;
    }
    for (const f of await store.list()) {
      if (!validNotePath(f.path)) problems.push(`round ${round}: invalid path ${JSON.stringify(f.path)}`);
      const c = (await store.read(f.path)).content;
      if (c.includes("\0") || Buffer.byteLength(c) > 70_000) problems.push(`round ${round}: bad content in ${f.path}`);
      try {
        parseFile(f.path, c);
      } catch (e) {
        problems.push(`round ${round}: ${f.path} no longer parses`);
      }
    }
  }
  assert.deepEqual(problems.slice(0, 6), [], `seed ${SEED}: ${problems.length} problem(s)`);
});

// ---------------------------------------------------------------------------------------------
test(`HTTP server: random requests never produce a 5xx or take it down (seed ${SEED})`, slow, async (t) => {
  const r = rng(SEED + 8);
  const SECRET = "s".repeat(32);
  const store = new InMemoryStore();
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  const app = createHttpApp(brain, { secret: SECRET, key: Buffer.from("k".repeat(32)), accounts: new Accounts({ ownerSecret: SECRET }), ratePerMinute: 1_000_000 });
  await new Promise((res) => app.listen(0, res));
  t.after(() => app.close());
  const port = app.address().port;
  const send = (data) => new Promise((res) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(data));
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("close", () => res(buf));
    c.on("error", () => res(buf));
    setTimeout(() => (c.destroy(), res(buf)), 700);
  });
  const PATHS = ["/mcp", "/mcp/", "/health", "/register", "/token", "/authorize", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/", "/mcp/" + SECRET, "//mcp", "/mcp?x=1"];
  const METHODS = ["GET", "POST", "POST", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD", "TRACE", "FOO"];
  const problems = [];
  // an exception thrown outside the request guard would kill a real server: capture it with its stack
  const onCrash = (e) => problems.push(`UNCAUGHT in the server: ${String(e?.stack || e).split("\n").slice(0, 4).join(" | ")}`);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  t.after(() => {
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  });
  const encode = (s) => {
    try {
      if (r.chance(0.4)) return encodeURIComponent(s).slice(0, 60); // throws on a lone surrogate: fall through to the plain form
    } catch {}
    return s.replace(/[\s\r\n\u0000-\u001f]/g, "_").slice(0, 60);
  };
  for (let batch = 0; batch < 12 * K; batch++) {
    for (let i = 0; i < 15; i++) {
      const method = r.pick(METHODS);
      const path = r.chance(0.7) ? r.pick(PATHS) + (r.chance(0.3) ? "?" + encode(text(r, 3)) : "") : "/" + encode(text(r, 3));
      const authed = r.chance(0.5);
      const rpc = { jsonrpc: r.chance(0.9) ? "2.0" : json(r), id: r.chance(0.8) ? r.int(1000) : json(r), method: r.pick(["initialize", "tools/list", "tools/call", "ping", "resources/list", "prompts/list", "notifications/initialized", text(r, 2), json(r)]), params: r.chance(0.5) ? json(r) : { name: r.pick(["recall", "remember", "files", "x"]), arguments: json(r) } };
      const body = r.chance(0.55) ? JSON.stringify(r.chance(0.15) ? [rpc, rpc] : rpc) : r.chance(0.5) ? JSON.stringify(json(r)) : text(r);
      const headers = [`Host: x`, r.chance(0.8) ? `Content-Type: ${r.pick(["application/json", "application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x", ""])}` : null, `Accept: application/json, text/event-stream`, authed ? `Authorization: Bearer ${SECRET}` : r.chance(0.2) ? `Authorization: ${text(r, 2).replace(/[\r\n]/g, "")}` : null, r.chance(0.2) ? `X-Forwarded-For: ${text(r, 2).replace(/[\r\n]/g, "")}` : null, `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close"].filter(Boolean);
      const reply = await send(`${method} ${path} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n${body}`);
      const status = Number((reply.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0);
      if (status >= 500) problems.push(`${status} for ${method} ${path} (${authed ? "authed" : "anon"}) ${body.slice(0, 80).replace(/\s+/g, " ")}`);
    }
    if (!(await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) }).then((x) => x.ok).catch(() => false))) problems.push(`server stopped answering after batch ${batch}`);
  }
  assert.deepEqual(problems.slice(0, 6), [], `seed ${SEED}: ${problems.length} problem(s)`);
});

// ---------------------------------------------------------------------------------------------
test(`brain: random remember / forget / supersede sequences keep their promises (seed ${SEED})`, slow, async () => {
  const r = rng(SEED + 6);
  const store = new InMemoryStore();
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  const SUBJ = ["Sam", "Priya", "Johnny", "Ada"];
  const VERB = ["owns", "prefers", "decided on", "uses"];
  const OBJ = ["the billing rewrite", "tea", "Postgres 16", "weekly RFCs", "a 16 kHz rate", "the Mac mini"];
  const mk = () => `${r.pick(SUBJ)} ${r.pick(VERB)} ${r.pick(OBJ)} ${r.int(4)}`;
  const read = async (p) => (await store.read(p))?.content ?? "";
  const liveOf = (c) => c.split(/^#{1,6}\s+(?:history|archived)\s*$/im)[0];
  const bullets = (c) => liveOf(c).split("\n").filter((l) => /^\s*[-*]\s+/.test(l));
  const saved = [];
  const problems = [];
  await silent(async () => {
    for (let i = 0; i < 160 * K; i++) {
      const op = r.pick(["remember", "remember", "remember", "forget", "supersede"]);
      try {
        if (op === "remember") {
          const fact = mk();
          const res = await brain.remember(fact, r.chance(0.7) ? { about: r.pick(SUBJ) } : {});
          if (res.status === "saved") {
            if (!plain(liveOf(await read(res.path))).includes(fact)) problems.push(`#${i} saved but missing from ${res.path}: ${fact}`);
            saved.push({ path: res.path, fact });
          } else if (res.status === "duplicate" && !plain(await read(res.path)).includes(res.existing)) problems.push(`#${i} duplicate points at text that isn't in ${res.path}`);
        } else if (saved.length) {
          const k = r.int(saved.length);
          const { path, fact } = saved[k];
          const content = await read(path);
          if (!plain(liveOf(content)).includes(fact)) {
            saved.splice(k, 1);
            continue;
          }
          const before = bullets(content).length;
          if (op === "forget") {
            await brain.forget(fact, { path });
            const after = bullets(await read(path)).length;
            if (after !== before - 1) problems.push(`#${i} forget removed ${before - after} lines of "${fact}"`);
            saved.splice(k, 1);
          } else {
            const next = `${fact} revised ${r.int(1000)}`;
            await brain.remember(next, { path, replaces: fact });
            const c2 = await read(path);
            if (!plain(liveOf(c2)).includes(next)) problems.push(`#${i} replacement missing: ${next}`);
            if (plain(liveOf(c2)).includes(`${fact}\n`) && !plain(liveOf(c2)).includes(next)) problems.push(`#${i} old fact still live`);
            if (!plain(c2.slice(liveOf(c2).length)).includes(fact)) problems.push(`#${i} old fact not in History: ${fact}`);
            saved[k] = { path, fact: next };
          }
        }
      } catch (e) {
        if (!/No exact|match that text|appears in|not found|nearly full|Line to replace/.test(e.message)) problems.push(`#${i} ${op} threw: ${e.message.split("\n")[0].slice(0, 100)}`);
      }
    }
  });
  for (const f of await store.list()) {
    const live = bullets((await store.read(f.path)).content).map((l) => plain(l).trim().toLowerCase());
    if (new Set(live).size !== live.length) problems.push(`${f.path} has duplicate live facts`);
  }
  assert.deepEqual(problems.slice(0, 6), [], `seed ${SEED}: ${problems.length} problem(s)`);
});
