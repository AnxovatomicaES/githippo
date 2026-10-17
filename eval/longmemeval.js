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

const sessionNote = (turns) =>
  "---\nname: session\n---\n\n" + turns.map((t) => `- ${t.role}: ${String(t.content).replace(/\s+/g, " ").trim()}`).join("\n") + "\n";

export async function runLongMemEval(entries, { embeddings = "none", limit = Infinity, log = () => {} } = {}) {
  const embedder = createEmbedder({ EMBEDDINGS: embeddings });
  const vectors = new Map(); // shared across questions: haystacks overlap heavily
  const K = [5, 10, 20];
  const byType = {};
  const all = { n: 0, r5: 0, r10: 0, r20: 0, mrr: 0, ndcg: 0 };
  const t0 = Date.now();
  const list = entries.slice(0, limit);
  for (const [qi, e] of list.entries()) {
    const store = new InMemoryStore();
    const idOf = new Map();
    for (let i = 0; i < e.haystack_sessions.length; i++) {
      const path = `lme/s${i}.md`;
      idOf.set(path, e.haystack_session_ids[i]);
      await store.write(path, sessionNote(e.haystack_sessions[i]), "new");
    }
    const index = new MemoryIndex(store, embedder, {});
    index.vectors = vectors;
    const hits = await index.search(e.question, { k: 200, expand: false });
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
  return { embeddings: embedder?.id || "none (BM25 + graph)", all: sum(all), byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, sum(v)])), seconds: Math.round((Date.now() - t0) / 1000) };
}

export function formatLongMemEval(r) {
  return [
    `**LongMemEval-S retrieval** · ${r.embeddings} · ${r.all.n} questions · ${r.seconds} s`,
    "",
    "| question type | n | R@5 | R@10 | R@20 | MRR | NDCG@10 |",
    "|---|---|---|---|---|---|---|",
    ...Object.entries(r.byType).sort().map(([k, v]) => `| ${k} | ${v.n} | ${v.r5}% | ${v.r10}% | ${v.r20}% | ${v.mrr} | ${v.ndcg10} |`),
    `| **all** | ${r.all.n} | **${r.all.r5}%** | **${r.all.r10}%** | **${r.all.r20}%** | **${r.all.mrr}** | **${r.all.ndcg10}** |`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
  const data = JSON.parse(readFileSync(arg("data", "longmemeval_s_cleaned.json"), "utf8"));
  const r = await runLongMemEval(data, { embeddings: arg("embeddings", "none"), limit: Number(arg("limit", Infinity)), log: (m) => console.error(m) });
  console.log(process.argv.includes("--json") ? JSON.stringify(r) : formatLongMemEval(r));
}
