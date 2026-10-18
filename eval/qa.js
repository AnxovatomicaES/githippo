// Step 1a: LongMemEval question answering with Claude as the reader and a judge model, under three conditions:
// no memory (closed book, the floor), githippo recall (budgeted pack), oracle (the gold answer sessions, the
// ceiling). Judge instructions are ADAPTED from LongMemEval's per-type evaluation rules, not copied verbatim.
// Usage: ANTHROPIC_API_KEY=… node eval/qa.js --data longmemeval_s_cleaned.json --sample 50 [--embeddings local]
import { readFileSync } from "node:fs";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { createEmbedder } from "../src/embed.js";
import { Brain } from "../src/brain.js";
import { createLLM } from "../src/llm.js";

const lmeDate = (s) => (String(s || "").match(/(\d{4})\/(\d{2})\/(\d{2})/) || []).slice(1).join("-") || null;
const sessionText = (turns) => turns.map((t) => `${t.role}: ${String(t.content).replace(/\s+/g, " ").trim()}`).join("\n");

export function judgePrompt(e, response) {
  const abstain = String(e.question_id || "").endsWith("_abs");
  const rule = abstain
    ? "Answer yes if the response correctly says the question cannot be answered from the history (or that the information was never given). Otherwise answer no."
    : e.question_type === "temporal-reasoning"
      ? "Answer yes if the response contains the correct answer. Do not penalise off-by-one errors in counts of days, weeks or months. Otherwise answer no."
      : e.question_type === "knowledge-update"
        ? "Answer yes if the response contains the correct, most recent answer. Mentioning older information as well is fine as long as the updated answer is given. Otherwise answer no."
        : e.question_type === "single-session-preference"
          ? "The correct answer is a rubric of the user's preferences. Answer yes if the response recalls and uses the user's personal information correctly; it need not cover every point. Otherwise answer no."
          : "Answer yes if the response contains the correct answer, or is equivalent to it. If it gives only part of the required information, answer no.";
  return `I will give you a question, a correct answer and a response from a model.\n${rule}\n\nQuestion: ${e.question}\nCorrect answer: ${e.answer}\nModel response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

export async function runQA(entries, { llm, judge = llm, embeddings = "none", conditions = ["none", "githippo", "oracle"], budget = 2000, readerModel, judgeModel, log = () => {} }) {
  const embedder = createEmbedder({ ...process.env, EMBEDDINGS: embeddings });
  const vectors = new Map();
  const score = Object.fromEntries(conditions.map((c) => [c, { all: [0, 0], byType: {} }]));
  for (const [qi, e] of entries.entries()) {
    const date = lmeDate(e.question_date);
    for (const cond of conditions) {
      let history = "";
      if (cond === "githippo") {
        const store = new InMemoryStore();
        for (let i = 0; i < e.haystack_sessions.length; i++) {
          const d = lmeDate(e.haystack_dates?.[i]);
          await store.write(`lme/s${i}.md`, "---\nname: session\n---\n\n" + e.haystack_sessions[i].map((t) => `- ${t.role}: ${String(t.content).replace(/\s+/g, " ").trim()}${d ? ` <!--+${d}-->` : ""}`).join("\n") + "\n", "new");
        }
        const brain = new Brain({ store, index: new MemoryIndex(store, embedder, {}) });
        brain.index.vectors = vectors;
        history = (await brain.recall(e.question, { budget })).context;
      } else if (cond === "oracle") {
        const gold = new Set(e.answer_session_ids);
        history = e.haystack_sessions.filter((_, i) => gold.has(e.haystack_session_ids[i])).map((s, i) => `Session ${i + 1}:\n${sessionText(s)}`).join("\n\n");
      }
      const prompt = cond === "none"
        ? `Current date: ${date}\nQuestion: ${e.question}\nAnswer briefly. If you don't know, say so.`
        : `Here is relevant history from earlier conversations with the user:\n<history>\n${history}\n</history>\nCurrent date: ${date}\nUsing the history, answer the question briefly. If the history doesn't contain the answer, say so.\nQuestion: ${e.question}`;
      const answer = await llm.complete({ prompt, maxTokens: 300, ...(readerModel ? { model: readerModel } : {}) });
      const verdict = await judge.complete({ prompt: judgePrompt(e, answer), maxTokens: 5, ...(judgeModel ? { model: judgeModel } : {}) });
      const ok = /^\s*yes/i.test(verdict);
      const s = score[cond];
      s.all[0] += ok; s.all[1]++;
      (s.byType[e.question_type] ??= [0, 0])[0] += ok;
      s.byType[e.question_type][1]++;
    }
    if ((qi + 1) % 10 === 0) log(`${qi + 1}/${entries.length}`);
  }
  embedder?.stop?.();
  return score;
}

export function formatQA(score, meta = "") {
  const pct = ([a, n]) => (n ? `${Math.round((1000 * a) / n) / 10}%` : "–");
  const conds = Object.keys(score);
  const types = [...new Set(conds.flatMap((c) => Object.keys(score[c].byType)))].sort();
  return [
    `**LongMemEval-S question answering** ${meta}`,
    "",
    `| question type | ${conds.join(" | ")} |`,
    `|---|${conds.map(() => "---").join("|")}|`,
    ...types.map((t) => `| ${t} | ${conds.map((c) => pct(score[c].byType[t] || [0, 0])).join(" | ")} |`),
    `| **all** | ${conds.map((c) => `**${pct(score[c].all)}**`).join(" | ")} |`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
  const llm = createLLM(process.env);
  if (!llm) throw new Error("set ANTHROPIC_API_KEY");
  const data = JSON.parse(readFileSync(arg("data", "longmemeval_s_cleaned.json"), "utf8"));
  const n = Number(arg("sample", 50));
  const sample = [...Array(n).keys()].map((i) => data[Math.floor((i * data.length) / n)]);
  const reader = arg("reader", "claude-sonnet-5-5");
  const judgeModel = arg("judge", "claude-sonnet-5-5");
  const score = await runQA(sample, { llm, embeddings: arg("embeddings", "none"), readerModel: reader, judgeModel, log: (m) => console.error(m) });
  console.log(formatQA(score, `· reader ${reader} · judge ${judgeModel} · ${n} evenly spaced questions · githippo recall ${arg("embeddings", "none")}, 2,000-token budget`));
}
