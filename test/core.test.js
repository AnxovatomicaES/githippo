import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { scan } from "../src/guard.js";
import { parseFile, plain } from "../src/parse.js";
import { KnowledgeGraph } from "../src/graph.js";
import { normalizePath } from "../src/store.js";

test("guard blocks secrets and regulated identifiers", () => {
  const kinds = (t) => scan(t).map((f) => f.kind);
  assert.deepEqual(kinds("IBAN ES91 2100 0418 4502 0005 1332"), ["iban"]);
  assert.deepEqual(kinds("card 4111 1111 1111 1111"), ["payment_card"]);
  assert.deepEqual(kinds("DNI 12345678Z"), ["spanish_dni_nie"]);
  assert.ok(kinds("ghp_" + "a".repeat(36)).includes("github_token"));
  assert.ok(kinds("sk-ant-api03-" + "x".repeat(30)).includes("anthropic_key"));
  assert.ok(kinds("password: hunter2hunter").includes("password_assignment"));
});

test("guard allows ordinary business text", () => {
  for (const t of ["Q4 2026 revenue up 12% to 4.5M", "Call +34 612 345 678 Monday", "Ref 12345678A", "Order 1234567890123"]) {
    assert.deepEqual(scan(t), [], t);
  }
});

test("parse: frontmatter, chunks, history flag, tags, plain links", () => {
  const f = parseFile("projects/x.md", "---\nname: x\naliases: [X1]\n---\n\n## Req\n- a #infra\n\n## History\n- ~~old~~\n");
  assert.deepEqual(f.aliases, ["X1"]);
  assert.equal(f.chunks[0].heading, "Req");
  assert.equal(f.chunks[1].history, true);
  assert.deepEqual(f.tags, ["infra"]);
  assert.equal(plain("ask [[john-grecu|John]] and [[johnny]]"), "ask John and johnny");
});

test("graph: aliases, typed relations, fuzzy resolve, safe auto-linking", () => {
  const files = [
    parseFile("people/john-grecu.md", "---\nname: john-grecu\ntitle: John Grecu\naliases: [John]\n---\n- COO\n"),
    parseFile("projects/johnny.md", "---\nname: johnny\n---\n- sponsor [[john-grecu]]\n- uses [[whisper]]\n"),
  ];
  const g = new KnowledgeGraph(files);
  assert.equal(g.resolve("Grecu"), "john-grecu");
  const nb = g.neighbors("John");
  assert.equal(nb.relations[0].type, "sponsor");
  assert.deepEqual(g.health().broken_links.map((b) => b.target), ["whisper"]);
  assert.deepEqual(g.mentions("Johnny is ready").map((m) => m.id), ["johnny"]);
  assert.equal(g.autoLink("John Grecu approved johnny").text, "[[john-grecu|John Grecu]] approved [[johnny|johnny]]");
});

test("store: traversal, short versions, conflicts", async () => {
  const { store } = setup();
  assert.throws(() => normalizePath("../x.md"));
  const v1 = await store.write("x.md", "one", "new");
  await store.write("x.md", "two", v1.version.slice(0, 8));
  await assert.rejects(store.write("x.md", "three", v1.version), (e) => e.current.content === "two");
  await assert.rejects(store.write("x.md", "dup", "new"), /already exists/);
  await assert.rejects(store.write("x.md", "short", "b"), /Version conflict/);
});

test("search: hybrid ranking + graph expansion, history/core/sessions out of scope", async () => {
  const { index, gh } = setup();
  gh.seed("memory/sessions/s1.md", "---\nname: s1\n---\n- wake word work in progress\n");
  const hits = await index.search("wake word assistant");
  assert.equal(hits[0].path, "projects/johnny.md");
  assert.ok(hits.some((h) => h.signals.graph === "johnny"));
  assert.ok(!hits.some((h) => h.path.startsWith("sessions/")));
  assert.ok((await index.search("wake word", { prefix: "sessions/" })).some((h) => h.path === "sessions/s1.md"));
  assert.ok(!(await index.search("Marcel CTO Spain")).some((h) => h.path === "core.md"));
});

test("incremental sync re-reads only changed files", async () => {
  const { index, gh, store } = setup();
  await index.sync();
  let reads = 0;
  const orig = store.read.bind(store);
  store.read = (...a) => (reads++, orig(...a));
  gh.seed("memory/topics/brand.md", "---\nname: brand\n---\n\n- Primary colour is navy and gold\n");
  index.lastSync = 0;
  await index.sync();
  assert.equal(reads, 1);
});
