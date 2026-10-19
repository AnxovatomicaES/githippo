// remember() must never drop a fact that changes the meaning of one it already has. Keyword overlap (and embeddings) can't tell a synonym from an
// alternative or an opposite, so a pair where each side has a content word the other lacks is saved, flagged as a possible update, never "duplicate".
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain, substitutes } from "../src/brain.js";

const brain = () => {
  const store = new InMemoryStore();
  return new Brain({ store, index: new MemoryIndex(store, null, {}) });
};
const changed = [
  ["The team prefers dark mode in the editor and the terminal during evening work", "The team prefers light mode in the editor and the terminal during evening work"],
  ["Standup happens on Tuesday morning in the main office with the whole team present", "Standup happens on Thursday morning in the main office with the whole team present"],
  ["The staging environment is deployed automatically after every merge to the main branch", "The staging environment is deployed manually after every merge to the main branch"],
  ["Backups of the production database are encrypted and stored in the european region", "Backups of the production database are unencrypted and stored in the european region"],
  ["The customer wants weekly status reports delivered by email on Friday afternoon", "The customer wants monthly status reports delivered by email on Friday afternoon"],
  ["We use trunk based development with short lived feature branches for all services", "We avoid trunk based development with short lived feature branches for all services"],
  ["The payments service retries failed requests three times before alerting the on call engineer", "The payments service retries failed requests twice before alerting the on call engineer"],
  ["Marcel does not want meetings scheduled before ten in the morning on any weekday", "Marcel does want meetings scheduled before ten in the morning on any weekday"],
  ["The analytics dashboard refreshes every hour and shows data for the previous full day", "The analytics dashboard refreshes every day and shows data for the previous full day"],
  ["All new services must be written in Go and deployed through the shared pipeline", "All new services must be written in Rust and deployed through the shared pipeline"],
  ["The legacy billing system will be shut down after the migration is fully completed", "The legacy billing system will be kept running after the migration is fully completed"],
  ["Contractors have read access to the design documents but cannot edit the shared files", "Contractors have write access to the design documents but cannot edit the shared files"],
];

test("a fact that changes the meaning of a known one is saved and flagged, never dropped as a duplicate (6 of these 12 were dropped before)", async () => {
  for (const [a, b] of changed) {
    const m = brain();
    await m.remember(a, { path: "topics/t.md" });
    const r = await m.remember(b, { path: "topics/t.md" });
    assert.equal(r.status, "saved", `dropped as a duplicate: "${b.slice(0, 70)}…"`);
    assert.ok(r.maybe_supersedes.length > 0, `saved but not flagged as a possible update: "${b.slice(0, 70)}…"`);
  }
});

test("rewordings, restatements and additions are still caught as duplicates", async () => {
  const same = [
    ["Launch target is end of Q2", "The launch target is the end of Q2"],
    ["Marcel prefers written RFCs over meetings", "Marcel prefers written RFCs over meetings."],
    ["The staging environment is deployed automatically after every merge", "After every merge the staging environment is deployed automatically"],
    ["Invoices are archived as PDF for 10 years", "Invoices are generated as PDF and archived for 10 years"],
    ["Sample rate for Johnny is 16 kHz", "Sample rate is 16 kHz"],
  ];
  for (const [a, b] of same) {
    const m = brain();
    await m.remember(a, { path: "topics/johnny.md" });
    assert.equal((await m.remember(b, { path: "topics/johnny.md" })).status, "duplicate", `"${b}" should be a duplicate of "${a}"`);
  }
});

test("substitutes(): both sides need a content word the other lacks, counted (a repeated word counts)", () => {
  assert.equal(substitutes("prefers dark mode in the editor", "prefers light mode in the editor"), true);
  assert.equal(substitutes("refreshes every hour for the full day", "refreshes every day for the full day"), true, "same set of words, different counts");
  assert.equal(substitutes("prefers dark mode", "prefers dark mode in the editor"), false, "an addition is not a substitution");
  assert.equal(substitutes("The launch is the end of Q2", "Launch is end of Q2"), false, "function words don't count");
  assert.equal(substitutes("Sample rate for Johnny is 16 kHz", "Sample rate is 16 kHz", new Set(["johnny"])), false, "the entity's own name is ignored");
});

test("maintain reports a pair like that as a possible contradiction, not as a duplicate to merge", async () => {
  const m = brain();
  await m.remember("The team prefers dark mode in the editor and the terminal during evening work", { path: "topics/a.md" });
  await m.remember("The team prefers light mode in the editor and the terminal during evening work", { path: "topics/b.md" });
  const r = await m.maintain();
  assert.equal(r.duplicates.length, 0, JSON.stringify(r.duplicates));
  assert.equal(r.conflicts.length, 1, JSON.stringify(r.conflicts));
});
