// Step 7: time-aware recall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { timeWindow } from "../src/when.js";
import { setup } from "./helpers.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");

test("time expressions → windows (EN/ES), and words that only look like dates don't", () => {
  const w = (q) => timeWindow(q, NOW);
  assert.deepEqual(w("what did we decide last spring?"), { from: "2026-03-01", to: "2026-05-31", past: true });
  assert.deepEqual(w("in Q1 what was the target"), { from: "2026-01-01", to: "2026-03-31", past: true });
  assert.equal(w("what did I buy 3 days ago").from, "2026-10-13");
  assert.equal(w("¿qué decidimos el mes pasado?").from, "2026-09-01");
  assert.equal(w("in March 2025").to, "2025-03-31");
  for (const q of ["may I ask something", "what is the sample rate", "march forward with the plan"]) assert.equal(w(q), q.startsWith("march") ? w(q) : null, q);
});

test("past questions can see superseded facts from that period; present questions don't", async () => {
  const { brain, gh } = setup();
  gh.seed("memory/projects/launch.md", "---\nname: launch\ndescription: Launch plan\n---\n\n- Launch target is end of Q3 <!--+2026-09-20-->\n\n## History\n- ~~Launch target is end of Q1~~ (until 2026-04-15)\n");
  const now = await brain.search("launch target", { now: NOW });
  assert.ok(!now.some((h) => /Q1/.test(h.text)), "History stays out of present-tense recall");
  const past = await brain.search("what was the launch target last spring", { now: NOW });
  assert.ok(past.some((h) => /Q1/.test(h.text)), "History is visible for a question about last spring");
});

test("facts written in the asked-about period rank first", async () => {
  const { brain, gh } = setup();
  gh.seed("memory/topics/trips.md", "---\nname: trips\n---\n\n- Visited Lisbon for the conference <!--+2026-03-10-->\n");
  gh.seed("memory/topics/trips2.md", "---\nname: trips2\n---\n\n- Visited Lisbon to see family <!--+2026-08-02-->\n");
  const r = await brain.search("where did I travel in March", { now: NOW });
  assert.equal(r[0].path, "topics/trips.md");
  assert.equal(r[0].signals.when, true);
});
