// LongMemEval-S retrieval benchmark (ICLR 2025, https://arxiv.org/abs/2410.10813), same protocol as
// agentmemory's published numbers so results are directly comparable: for each question, index its ~48
// haystack chat sessions (one note per session), search with the question, and check whether ANY gold
// answer session is in the top K. Retrieval only: no LLM, no answer generation, no judge.
// Usage: node eval/longmemeval.js --data longmemeval_s_cleaned.json [--embeddings none|local] [--limit N]
import { readFileSync } from "node:fs";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { createEmbedder } from "../src/embed.js";

export const DATASET_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json";

// "2023/05/20 (Sat) 02:21" → 2023-05-20
const lmeDate = (s) => (String(s || "").match(/(\d{4})\/(\d{2})\/(\d{2})/) || []).slice(1).join("-") || null;
const sessionNote = (turns, date) =>
  "---\nname: session\n---\n\n" + turns.map((t) => `- ${t.role}: ${String(t.content).replace(/\s+/g, " ").trim()}${date ? ` <!--+${date}-->` : ""}`).join("\n") + "\n";

// Deterministic shuffle (sanity check: results must not depend on session order).
function shuffled(n, seed) {
  const idx = [...Array(n).keys()];
  let x = seed >>> 0 || 1;
  for (let i = n - 1; i > 0; i--) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const j = x % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

export async function runLongMemEval(entries, { embeddings = "none", limit = Infinity, sample = 0, shuffle = 0, wholeSession = false, timeAware = true, log = () => {} } = {}) {
  const embedder = createEmbedder({ ...process.env, EMBEDDINGS: embeddings });
  const vectors = new Map(); // shared across questions: haystacks overlap heavily
  const K = [5, 10, 20];
  const byType = {};
  const all = { n: 0, r5: 0, r10: 0, r20: 0, mrr: 0, ndcg: 0 };
  let semanticQuestions = 0; // integrity: githippo silently falls back to keywords if embeddings fail
  const t0 = Date.now();
  // --sample N: N evenly spaced questions across the whole set (the file is grouped by question type,
  // so the first N would cover only one or two types)
  const list = sample ? [...Array(Math.min(sample, entries.length)).keys()].map((i) => entries[Math.floor((i * entries.length) / Math.min(sample, entries.length))]) : entries.slice(0, limit);
  for (const [qi, e] of list.entries()) {
    const store = new InMemoryStore();
    const idOf = new Map();
    const order = shuffle ? shuffled(e.haystack_sessions.length, shuffle + qi) : [...e.haystack_sessions.keys()];
    for (const [pos, i] of order.entries()) {
      const path = `lme/s${pos}.md`;
      idOf.set(path, e.haystack_session_ids[i]);
      await store.write(path, sessionNote(e.haystack_sessions[i], timeAware ? lmeDate(e.haystack_dates?.[i]) : null), "new");
    }
    const index = new MemoryIndex(store, embedder, {});
    // ablation: one chunk per session (whole-session documents, like agentmemory's harness)
    if (wholeSession) index.chunkChars = 1e9;
    index.vectors = vectors;
    const qd = lmeDate(e.question_date);
    const hits = await index.search(e.question, { k: 200, expand: false, ...(timeAware && qd ? { now: Date.parse(`${qd}T12:00:00Z`) } : { now: 0 }) });
    if (hits.some((h) => h.signals.cosine !== undefined)) semanticQuestions++;
    const ranked = [...new Set(hits.map((h) => idOf.get(h.path)))];
    const gold = new Set(e.answer_session_ids);
    const first = ranked.findIndex((s) => gold.has(s));
    const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + (gold.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
    const idcg = [...Array(Math.min(gold.size, 10))].reduce((s, _, i) => s + 1 / Math.log2(i + 2), 0);
    const t = (byType[e.question_type] ??= { n: 0, r5: 0, r10: 0, r20: 0, mrr: 0, ndcg: 0 });
    for (const m of [t, all]) {
      m.n++;
      for (const k of K) if (first >= 0 && first < k) m[`r${k}`]++;
      if (first >= 0) m.mrr += 1 / (first + 1);
      m.ndcg += idcg ? dcg / idcg : 0;
    }
    if ((qi + 1) % 50 === 0) log(`${qi + 1}/${list.length} · R@5 ${((100 * all.r5) / all.n).toFixed(1)}% · ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  embedder?.stop?.();
  const pct = (a, n) => Math.round((1000 * a) / n) / 10;
  const sum = (m) => ({ n: m.n, r5: pct(m.r5, m.n), r10: pct(m.r10, m.n), r20: pct(m.r20, m.n), mrr: pct(m.mrr, m.n), ndcg10: pct(m.ndcg, m.n) });
  return { semanticQuestions, embeddings: (embedder?.id || "none (BM25 + graph)") + (sample ? ` · evenly spaced sample of ${list.length}` : "") + (shuffle ? ` · sessions shuffled (seed ${shuffle})` : "") + (wholeSession ? " · whole-session documents" : "") + (timeAware ? "" : " · without session dates") + (process.env.RERANK === "local" ? " · reranked (cross-encoder)" : ""), all: sum(all), byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, sum(v)])), seconds: Math.round((Date.now() - t0) / 1000) };
}

export function formatLongMemEval(r) {
  return [
    `**LongMemEval-S retrieval** · ${r.embeddings} · ${r.all.n} questions · ${r.seconds} s` +
      (r.embeddings.startsWith("local") || r.embeddings.startsWith("voyage") ? ` · semantic results in ${r.semanticQuestions}/${r.all.n} questions${r.semanticQuestions < r.all.n ? " ⚠️ embeddings failed for some questions (keyword fallback), so this is not a pure model run" : ""}` : ""),
    "",
    "| question type | n | R@5 | R@10 | R@20 | MRR | NDCG@10 |",
    "|---|---|---|---|---|---|---|",
    ...Object.entries(r.byType).sort().map(([k, v]) => `| ${k} | ${v.n} | ${v.r5}% | ${v.r10}% | ${v.r20}% | ${v.mrr} | ${v.ndcg10} |`),
    `| **all** | ${r.all.n} | **${r.all.r5}%** | **${r.all.r10}%** | **${r.all.r20}%** | **${r.all.mrr}** | **${r.all.ndcg10}** |`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--rerank")) process.env.RERANK = "local";
  const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
  const data = JSON.parse(readFileSync(arg("data", "longmemeval_s_cleaned.json"), "utf8"));
  const r = await runLongMemEval(data, { embeddings: arg("embeddings", "none"), limit: Number(arg("limit", Infinity)), sample: Number(arg("sample", 0)), shuffle: Number(arg("shuffle", 0)), wholeSession: process.argv.includes("--whole-session"), timeAware: !process.argv.includes("--no-dates"), log: (m) => console.error(m) });
  console.log(process.argv.includes("--json") ? JSON.stringify(r) : formatLongMemEval(r));
}
