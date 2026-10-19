// The paraphrase benchmark (eval/paraphrase.js): keep its data honest and its harness running. The numbers themselves are in docs/benchmarks.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SET, violations, merge, runParaphrase } from "../eval/paraphrase.js";

const set = JSON.parse(readFileSync(DEFAULT_SET, "utf8"));

test("the committed set is what it claims: unique notes, and no English query shares a content word with its note", () => {
  assert.ok(set.notes.length >= 100, `${set.notes.length} notes`);
  assert.equal(new Set(set.notes.map((n) => n.path)).size, set.notes.length, "paths are unique");
  let en = 0;
  let es = 0;
  for (const n of set.notes) {
    assert.ok(n.facts.length >= 3, `${n.path} has facts`);
    for (const q of n.queries) {
      if (q.lang === "en") {
        en++;
        assert.deepEqual(violations(q.text, n), [], `"${q.text}" shares words with ${n.path}`);
      } else es++;
    }
  }
  assert.ok(en >= 200 && es >= 100, `${en} English and ${es} Spanish queries`);
});

test("violations(): content words and stems count, the entity's own name and function words don't", () => {
  const note = { title: "Lena Voss", description: "Platform engineer", aliases: ["Lena"], facts: ["Rotates the database credentials every 90 days", "Prefers written RFCs"] };
  assert.deepEqual(violations("Who changes the passwords for the data store?", note), [], "synonyms are fine");
  assert.deepEqual(violations("Does Lena do this before the weekend?", note), [], "her own name and function words are fine");
  assert.deepEqual(violations("How often are credentials rotated?", note), ["credential", "rotat"], "shared words are reported, by stem");
  assert.deepEqual(violations("When does she rotate them?", note), ["rotat"], "an inflected form of a note word counts");
  assert.deepEqual(violations("Who handles a break-in at one of the sites?", note), [], "'a' and 'one' are function words, not clues");
});

test("merge() keeps an English query only if it is clean, and takes every Spanish one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "para-"));
  const file = join(dir, "d.json");
  const note = { path: "people/ada-lund.md", title: "Ada Lund", description: "Sales lead", aliases: [], facts: ["Prefers calls on Thursday mornings", "Approves discounts above 10 percent"] };
  await writeFile(file, JSON.stringify({ domain: "x", notes: [{ ...note, queries: [{ id: "q1", lang: "en", text: "When is Ada reachable by phone?" }, { id: "q2", lang: "en", text: "Who approves discounts?" }, { id: "q3", lang: "es", text: "¿Qué día prefiere que la llamen?" }] }, { ...note, queries: [{ id: "q1", lang: "en", text: "x" }] }] }));
  const { set: out, dropped } = merge([file]);
  assert.equal(out.notes.length, 1, "a duplicate path is dropped");
  assert.deepEqual(out.notes[0].queries.map((q) => q.id), ["q1", "q3"], "q2 shares 'discounts'");
  assert.ok(dropped.some((d) => d.id === "q2" && d.shared.length));
});

test("the benchmark runs on the keyword index, and keyword search stays well below what meaning can reach", async () => {
  const r = await runParaphrase({ embeddings: "none", set });
  assert.equal(r.summary.all.n, set.notes.reduce((s, n) => s + n.queries.length, 0));
  // purely lexical search has little to go on when no content word is shared: a floor against the harness breaking, a ceiling against the set becoming easy
  assert.ok(r.summary["lang:en"].hit5 >= 35, `en hit@5 ${r.summary["lang:en"].hit5}`);
  assert.ok(r.summary["lang:en"].hit1 <= 45, `en hit@1 ${r.summary["lang:en"].hit1}: paraphrases should not be easy for keyword search`);
});
