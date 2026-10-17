// The LongMemEval harness itself, on a tiny synthetic sample in the dataset's exact format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLongMemEval, formatLongMemEval } from "../eval/longmemeval.js";

const session = (text) => [{ role: "user", content: text }, { role: "assistant", content: "Noted." }];
const entry = (q, type, sessions, gold) => ({
  question_id: q, question_type: type, question: q,
  haystack_session_ids: sessions.map((_, i) => `sess_${i}`), haystack_dates: [], haystack_sessions: sessions.map(session),
  answer_session_ids: gold,
});

test("LongMemEval harness: recall@K, MRR, NDCG and per-type breakdown", async () => {
  const filler = ["I went hiking last weekend in the mountains", "Can you recommend a pasta recipe", "My laptop battery drains fast", "What is a good sci-fi novel", "I am learning to play the piano"];
  const data = [
    entry("Which city did I say my sister moved to?", "single-session-user", [...filler, "My sister just moved to Lisbon for work"], ["sess_5"]),
    entry("What breed is my dog?", "single-session-user", ["My dog Max is a border collie", ...filler], ["sess_0"]),
    entry("How many piano lessons do I take per week?", "multi-session", [...filler, "I take two piano lessons per week now"], ["sess_5"]),
  ];
  const r = await runLongMemEval(data, { embeddings: "none" });
  assert.equal(r.all.n, 3);
  assert.equal(r.all.r5, 100);
  assert.ok(r.all.mrr > 50);
  assert.deepEqual(Object.keys(r.byType).sort(), ["multi-session", "single-session-user"]);
  assert.match(formatLongMemEval(r), /\| \*\*all\*\* \| 3 \| \*\*100%\*\*/);
});
