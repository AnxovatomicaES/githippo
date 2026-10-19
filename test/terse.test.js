// MEMORY_STYLE=terse: only padding is removed; meaning-carrying tokens always survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { terse } from "../src/terse.js";
import { setup } from "./helpers.js";

test("terse keeps negations, numbers, code, URLs, paths, links and accented names", () => {
  const cases = [
    ["- Lucía only wants drafts on Thursdays before 12:00 and never on weekends", "- Lucía only wants drafts on Thursdays before 12:00 and never on weekends"],
    ["- It is important to note that client data must never be pasted into consumer AI tools", "- Client data must never be pasted into consumer AI tools"],
    ["- The deploy uses `npm run the-deploy` and the docs at https://example.com/the/a/path", "- Deploy uses `npm run the-deploy` and docs at https://example.com/the/a/path"],
    ["- Logs live in ./var/the/logs and the owner is [[sam-okafor|the Sam]]", "- Logs live in ./var/the/logs and owner is [[sam-okafor|the Sam]]"],
    ["- The team moved to Grafana Cloud in order to cut costs by about 40 percent", "- Team moved to Grafana Cloud to cut costs by about 40 percent"],
    ["- Do not deploy on Fridays without a rollback plan", "- Do not deploy on Fridays without a rollback plan"], // "a" is kept: it's also a letter and a Spanish preposition
    ["- Class A shares vote de lunes a martes", "- Class A shares vote de lunes a martes"],
    ["- An A/B test runs for four weeks", "- A/B test runs for four weeks"],
  ];
  for (const [input, want] of cases) assert.equal(terse(input), want);
  // invariant: every negation/limiter, number and name in the input is still there
  for (const [input] of cases) {
    const out = terse(input);
    for (const w of input.match(/\b(not|no|never|only|without|except)\b|\d+|[A-ZÁÉÍÓÚ][\p{L}]+/gu) || []) {
      if (!["The", "It", "An", "A"].includes(w)) assert.ok(out.includes(w), `"${w}" lost from: ${input}`);
    }
  }
});

test("off by default; when on, recall and core are terse but the files on disk are untouched", async () => {
  const plain = setup();
  const before = (await plain.brain.recall("wake word Mac mini")).context;
  const t = setup();
  t.brain.style = "terse";
  const r = await t.brain.recall("wake word Mac mini");
  assert.ok(r.context.length < before.length, "terse pack is shorter");
  assert.doesNotMatch(r.context, /(?<![\p{L}])the(?![\p{L}])/iu);
  assert.match(t.gh.text("memory/projects/johnny.md"), /runs locally on the Mac mini/, "file unchanged");
  assert.match(before, /the Mac mini/, "default output unchanged");
});
