import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { fmt } from "../src/format.js";

test("recall: entity pack, plain links, budget, brief mode", async () => {
  const { brain } = setup();
  const r = await brain.recall("John");
  assert.match(r.context, /^§ people\/john-grecu\.md — Chief Operating Officer/);
  assert.doesNotMatch(r.context, /\[\[/);
  const tiny = await brain.recall("wake word", { budget: 30 });
  assert.ok(tiny.tokens <= 32, `tokens ${tiny.tokens}`);
  const brief = await brain.recall("wake word", { mode: "brief" });
  assert.match(brief.hits[0].ref, /^projects\/johnny\.md:\d+$/);
});

test("graph expansion respects scope (index/core never leak into recall)", async () => {
  const { brain } = setup();
  const r = await brain.recall("Johnny wake word");
  assert.doesNotMatch(r.context, /index\.md|core\.md/);
});

test("new files have a blank line after frontmatter", async () => {
  const { brain, gh } = setup();
  await brain.remember("Runs the APAC desk", { about: "Vik Rao", kind: "person" });
  assert.match(gh.text("memory/people/vik-rao.md"), /\n---\n\n- Runs the APAC desk\n$/);
});

test("compact output is much smaller than JSON", async () => {
  const { brain } = setup();
  const r = await brain.recall("wake word assistant");
  const text = fmt.recall(r);
  const json = JSON.stringify(await brain.index.search("wake word assistant"), null, 2);
  assert.ok(text.length < json.length * 0.6, `${text.length} vs ${json.length}`);
});

test("remember: routes by mention, auto-links others", async () => {
  const { brain, gh } = setup();
  const r = await brain.remember("Johnny should use Whisper; John Grecu wants a demo by December");
  assert.equal(r.path, "projects/johnny.md");
  assert.deepEqual(r.linked, ["john-grecu"]);
  assert.match(gh.text("memory/projects/johnny.md"), /\[\[john-grecu\|John Grecu\]\] wants a demo/);
});

test("remember: dedupes, refuses regulated data, inbox fallback", async () => {
  const { brain, gh } = setup();
  const n = gh.commits.length;
  assert.equal((await brain.remember("Needs a wake word and runs locally on the Mac mini")).status, "duplicate");
  await assert.rejects(brain.remember("Client IBAN is ES9121000418450200051332"), /iban/);
  assert.equal(gh.commits.length, n);
  assert.equal((await brain.remember("Prefers dark mode in every editor")).path, "inbox.md");
});

test("remember: new entity → file + index + first-name alias", async () => {
  const { brain, gh } = setup();
  const r = await brain.remember("Head of Research", { about: "Hersh Oberoi", kind: "person" });
  assert.equal(r.path, "people/hersh-oberoi.md");
  assert.match(gh.text("memory/index.md"), /\[\[hersh-oberoi\]\]/);
  assert.equal((await brain.remember("Reviews all commentary", { about: "Hersh" })).path, "people/hersh-oberoi.md");
});

test("supersede keeps the old fact in a dated History section, excluded from recall", async () => {
  const { brain, gh } = setup();
  const r = await brain.remember("Primary colour is teal", { path: "topics/brand.md", replaces: "Primary colour is navy" });
  assert.equal(r.status, "superseded");
  const txt = gh.text("memory/topics/brand.md");
  assert.match(txt, /- Primary colour is teal\n\n## History\n- ~~Primary colour is navy~~ \(until \d{4}-\d{2}-\d{2}\)/);
  const rc = await brain.recall("primary colour");
  assert.doesNotMatch(rc.context, /navy/);
  // later facts go above History
  await brain.remember("Logo is a lighthouse", { path: "topics/brand.md" });
  assert.match(gh.text("memory/topics/brand.md"), /lighthouse\n\n## History/);
});

test("pin: core memory, budget enforced, loaded for instructions", async () => {
  const { brain } = setup();
  assert.equal((await brain.remember("Always answer in British English", { pin: true })).status, "pinned");
  assert.match(brain.core, /British English/);
  await assert.rejects(brain.remember("x ".repeat(200), { pin: true }), /Core memory would exceed/);
});

test("forget removes an exact line, including from core", async () => {
  const { brain, gh } = setup();
  const r = await brain.forget("Approves budget for infrastructure projects");
  assert.equal(r.path, "people/john-grecu.md");
  assert.doesNotMatch(gh.text("memory/people/john-grecu.md"), /Approves budget/);
  await brain.forget("User is Marcel, CTO, based in Spain");
  assert.equal(brain.core, "");
  await assert.rejects(brain.forget("nonexistent fact here"), /No exact matching line/);
});

test("checkpoint: save and resume (any client)", async () => {
  const { brain } = setup();
  assert.equal((await brain.checkpoint({ session: "deck" })).status, "none");
  await brain.checkpoint({ session: "deck", task: "Build Q4 deck", state: "slides 1-6 done\n- chart pending", next: "Slide 7 chart" });
  const r = await brain.checkpoint({ session: "deck" });
  assert.equal(r.status, "resume");
  assert.match(r.checkpoint, /## Task\n- Build Q4 deck[\s\S]*- chart pending[\s\S]*## Next\n- Slide 7 chart/);
});

test("maintain: report + reindex + guarded LLM rewrite", async () => {
  const { brain, gh } = setup();
  gh.seed("memory/topics/dupes.md", "---\nname: dupes\n---\n\n- Board meets every Monday\n- Board meets every Monday\n- see [[nowhere]]\n");
  const r = await brain.maintain({ reindex: true });
  assert.equal(r.duplicates.length, 1);
  assert.ok(r.orphans.includes("topics/brand.md"));
  assert.deepEqual(r.broken_links.map((b) => b.target), ["nowhere"]);
  assert.match(gh.text("memory/index.md"), /## topics\n- \[\[brand\]\] — Brand rules/);

  const lossy = setup({ llm: { consolidate: async () => "---\nname: johnny\n---\n- short\n" } });
  await assert.rejects(lossy.brain.maintain({ rewrite: "projects/johnny.md" }), /dropped links/);
});

test("history: timeline and time travel", async () => {
  const { brain, store } = setup();
  const v = (await store.read("topics/brand.md")).version;
  await store.write("topics/brand.md", "---\nname: brand\n---\n\n- Primary colour is teal\n", v);
  const tl = await brain.history("brand");
  assert.equal(tl.commits.length, 2);
  assert.match((await brain.history("brand", { at: tl.commits[1].date })).content, /navy/);
  assert.equal((await brain.history("brand", { at: "2025-01-01" })).existed, false);
});
