// Step 1: the evaluation harnesses, driven by a scripted stand-in model (real runs need ANTHROPIC_API_KEY).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runQA, judgePrompt, formatQA } from "../eval/qa.js";
import { runBehavior, SCENARIO } from "../eval/behavior.js";

const session = (t) => [{ role: "user", content: t }, { role: "assistant", content: "ok" }];
const DATA = [{ question_id: "q1", question_type: "single-session-user", question: "Which city did my sister move to?", answer: "Lisbon", question_date: "2023/06/01 (Thu) 10:00", haystack_session_ids: ["a", "b"], haystack_dates: ["2023/05/01 (Mon) 10:00", "2023/05/02 (Tue) 10:00"], haystack_sessions: [session("My sister moved to Lisbon"), session("pasta recipe please")], answer_session_ids: ["a"] }];

test("QA harness: reader sees recalled history; judge grades; three conditions scored", async () => {
  const seen = [];
  const llm = {
    complete: async ({ prompt }) => {
      seen.push(prompt);
      if (prompt.startsWith("I will give you")) return /Model response: .*Lisbon/.test(prompt) ? "yes" : "no";
      return /<history>[\s\S]*Lisbon/.test(prompt) ? "Lisbon" : "I don't know";
    },
  };
  const s = await runQA(DATA, { llm });
  assert.deepEqual(s.none.all, [0, 1], "closed book can't know");
  assert.deepEqual(s.githippo.all, [1, 1], "githippo recall finds it");
  assert.deepEqual(s.oracle.all, [1, 1]);
  assert.match(formatQA(s), /\| \*\*all\*\* \| \*\*0%\*\* \| \*\*100%\*\* \| \*\*100%\*\* \|/);
  assert.match(judgePrompt({ ...DATA[0], question_type: "temporal-reasoning" }, "x"), /off-by-one/);
  assert.match(judgePrompt({ ...DATA[0], question_id: "q1_abs" }, "x"), /cannot be answered/);
});

test("behavior harness: tool loop, saved facts, junk and probe answers", async () => {
  // stand-in "Claude": remembers sentences that look durable, recalls before answering probes
  const llm = {
    messages: async ({ messages }) => {
      const last = messages.at(-1);
      if (Array.isArray(last.content)) {
        const txt = last.content.map((b) => b.content).join(" ");
        return { content: [{ type: "text", text: `From memory: ${txt}` }] };
      }
      const u = last.content;
      if (/\?$/.test(u) && messages.length === 1) return { content: [{ type: "tool_use", id: "r1", name: "recall", input: { q: u } }] };
      if (/decided|always|joined|deadline|vegetarian|lead the payments/i.test(u)) return { content: [{ type: "tool_use", id: "m1", name: "remember", input: { fact: u } }] };
      return { content: [{ type: "text", text: "Sure." }] };
    },
  };
  const r = await runBehavior({ llm });
  assert.ok(r.calls.remember >= 5);
  assert.equal(r.junkLines, 0);
  assert.match(r.coverage, /^\d+\/7$/);
  assert.equal(r.answers.length, SCENARIO.probes.length);
  assert.ok(r.answers.find((a) => /tech lead/.test(a.q)).ok, "recalled Sam");
});
