// githippo eval: retrieval quality (hit@1, hit@5, MRR by query type), routing accuracy and dedupe/update
// classification on a labelled vault. Usage: githippo eval [--embeddings none|local|voyage] [--json]
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { createEmbedder } from "../src/embed.js";
import { Brain } from "../src/brain.js";
import { VAULT, QUERIES, ROUTING, DEV_ROUTING, DEDUPE } from "./dataset.js";

async function vault(embedder, extra = {}) {
  const store = new InMemoryStore();
  for (const [p, c] of Object.entries({ ...VAULT, "index.md": "---\nname: index\n---\n\n", "inbox.md": "---\nname: inbox\ntitle: Inbox\ntype: inbox\n---\n\n", ...extra })) await store.write(p, c, "new", "seed");
  const index = new MemoryIndex(store, embedder, {});
  index.vectors = sharedVectors; // reuse embeddings across fresh vaults (same text → same vector)
  return new Brain({ store, index });
}
const sharedVectors = new Map();

export async function runEval({ embeddings = "none" } = {}) {
  const embedder = createEmbedder({ EMBEDDINGS: embeddings });
  const t0 = Date.now();
  const brain = await vault(embedder);
  await brain.index.sync({ maxAgeMs: 0 });
  const byType = {};
  const all = { n: 0, h1: 0, h5: 0, rr: 0 };
  const misses = [];
  for (const [q, want, type] of QUERIES) {
    const r = await brain.recall(q, { mode: "brief" });
    const files = [...new Set(r.hits.map((h) => h.ref.split(":")[0]))];
    const rank = files.indexOf(want) + 1;
    const t = (byType[type] ??= { n: 0, h1: 0, h5: 0, rr: 0 });
    for (const m of [t, all]) {
      m.n++;
      if (rank === 1) m.h1++;
      if (rank && rank <= 5) m.h5++;
      if (rank) m.rr += 1 / rank;
    }
    if (rank !== 1) misses.push({ q, want, got: files.slice(0, 3), rank: rank || null });
  }
  // Filing: wrong-note errors are worse than parking a fact in the inbox, so they're counted separately.
  const route = async (set) => {
    let ok = 0, wrong = 0;
    const missed = [];
    for (const [fact, want] of set) {
      const b = await vault(embedder);
      const r = await b.remember(fact);
      if (r.path === want) ok++;
      else {
        if (r.path !== "inbox.md") wrong++;
        missed.push({ fact, want, got: r.path });
      }
    }
    return { ok, wrong, missed };
  };
  const test = await route(ROUTING);
  const dev = await route(DEV_ROUTING);
  const routed = test.ok;
  const routeMisses = test.missed;
  let classified = 0;
  const dedupeMisses = [];
  for (const [fact, existing, want] of DEDUPE) {
    const b = await vault(embedder);
    const file = Object.keys(VAULT).find((p) => VAULT[p].includes(existing));
    const r = await b.remember(fact, { path: file });
    const got = r.status === "duplicate" ? "duplicate" : (r.maybe_supersedes || []).some((m) => m.line.includes(existing.slice(0, 20))) ? "update" : "new";
    if (got === want) classified++;
    else dedupeMisses.push({ fact, want, got });
  }
  const pct = (a, b) => Math.round((1000 * a) / b) / 10;
  const summary = (m) => ({ n: m.n, hit1: pct(m.h1, m.n), hit5: pct(m.h5, m.n), mrr: Math.round((1000 * m.rr) / m.n) / 1000 });
  return {
    embeddings: embedder?.id || "none (keyword + graph)",
    retrieval: summary(all),
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, summary(v)])),
    routing: { n: ROUTING.length, accuracy: pct(routed, ROUTING.length), wrongNote: test.wrong, dev: { n: DEV_ROUTING.length, accuracy: pct(dev.ok, DEV_ROUTING.length), wrongNote: dev.wrong } },
    dedupe: { n: DEDUPE.length, accuracy: pct(classified, DEDUPE.length) },
    ms: Date.now() - t0,
    rssMB: Math.round(process.memoryUsage().rss / 1e6),
    misses,
    routeMisses,
    dedupeMisses,
  };
}

export function formatEval(r) {
  const rows = Object.entries(r.byType).map(([k, v]) => `| ${k} | ${v.n} | ${v.hit1}% | ${v.hit5}% | ${v.mrr} |`);
  return [
    `githippo eval · ${r.embeddings} · ${r.ms} ms · RSS ${r.rssMB} MB`,
    "",
    "| query type | n | hit@1 | hit@5 | MRR |",
    "|---|---|---|---|---|",
    ...rows,
    `| **all** | ${r.retrieval.n} | **${r.retrieval.hit1}%** | **${r.retrieval.hit5}%** | **${r.retrieval.mrr}** |`,
    "",
    `filing, held-out test: ${r.routing.accuracy}% of ${r.routing.n} (${r.routing.wrongNote} in a wrong note, rest in the inbox) · dev set: ${r.routing.dev.accuracy}% of ${r.routing.dev.n} (${r.routing.dev.wrongNote} wrong note)`,
    `duplicate / update / new classification: ${r.dedupe.accuracy}% of ${r.dedupe.n}`,
  ].join("\n");
}
