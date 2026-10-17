// Hybrid retrieval: BM25 (exact terms, names, numbers) + dense embeddings
// (meaning, cross-lingual) fused with Reciprocal Rank Fusion, then expanded
// one hop through the knowledge graph.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFile, stem } from "./parse.js";
import { KnowledgeGraph } from "./graph.js";
import { cosine } from "./embed.js";

const STOP = new Set(
  "the a an and or of to in on for with is are was were be by at as it this that from de la el los las y o en un una por con para que del al se es su lo".split(" "),
);

export const tokenize = (s) =>
  (s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );

export class Bm25 {
  constructor(chunks) {
    this.chunks = chunks;
    this.df = new Map();
    this.tf = new Map();
    let total = 0;
    for (const c of chunks) {
      const toks = tokenize(c.embedText);
      total += toks.length;
      const counts = new Map();
      for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
      this.tf.set(c.id, { counts, len: toks.length });
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = total / (chunks.length || 1);
  }

  search(query) {
    const q = [...new Set(tokenize(query))];
    const N = this.chunks.length;
    const k1 = 1.2;
    const b = 0.75;
    return this.chunks
      .map((c) => {
        const { counts, len } = this.tf.get(c.id);
        let s = 0;
        for (const t of q) {
          const f = counts.get(t);
          if (!f) continue;
          const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
          s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / this.avgLen)));
        }
        return { c, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
  }
}

/** Default scope: live facts only. History, session checkpoints and pinned core (already in the system prompt) are opt-in. */
export function inDefaultScope(c, prefix = "") {
  if (!c.path.startsWith(prefix)) return false;
  if (prefix) return prefix.startsWith("sessions/") || !c.path.startsWith("sessions/") ? !c.history || /history/i.test(prefix) : false;
  return !c.history && !c.path.startsWith("sessions/") && c.path !== "core.md" && c.path !== "index.md";
}

export class MemoryIndex {
  constructor(store, embedder, { cacheDir } = {}) {
    this.store = store;
    this.embedder = embedder;
    this.cacheDir = cacheDir;
    this.files = new Map(); // path -> parsed file (+version)
    this.vectors = new Map(); // chunk hash -> Float32Array
    this.graph = new KnowledgeGraph();
    this.syncing = null;
    this.lastSync = 0;
  }

  get cacheFile() {
    return this.cacheDir && this.embedder ? join(this.cacheDir, `${this.embedder.id.replace(/\W+/g, "_")}.json`) : null;
  }

  async loadCache() {
    if (!this.cacheFile || this.vectors.size) return;
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, "utf8"));
      for (const [h, v] of Object.entries(raw)) this.vectors.set(h, Float32Array.from(v));
    } catch {}
  }

  async saveCache() {
    if (!this.cacheFile) return;
    await mkdir(this.cacheDir, { recursive: true });
    const obj = Object.fromEntries([...this.vectors].map(([h, v]) => [h, Array.from(v, (x) => +x.toFixed(5))]));
    await writeFile(this.cacheFile, JSON.stringify(obj));
  }

  /** Incremental sync: only files whose blob SHA changed are re-read and re-embedded. */
  async sync({ maxAgeMs = 5000 } = {}) {
    if (Date.now() - this.lastSync < maxAgeMs) return;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      await this.loadCache();
      const listing = await this.store.list();
      const live = new Set(listing.map((f) => f.path));
      for (const p of this.files.keys()) if (!live.has(p)) this.files.delete(p);
      const changed = listing.filter((f) => this.files.get(f.path)?.version !== f.version);
      await Promise.all(
        changed.map(async (f) => {
          const file = await this.store.read(f.path);
          if (file) this.files.set(f.path, { ...parseFile(f.path, file.content), version: file.version, content: file.content });
        }),
      );
      await this.embedMissing();
      this.rebuild();
      this.lastSync = Date.now();
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  /** Apply a write we just made without waiting for a full sync. */
  async upsert(path, content, version) {
    this.files.set(path, { ...parseFile(path, content), version, content });
    await this.embedMissing();
    this.rebuild();
  }

  remove(path) {
    this.files.delete(path);
    this.rebuild();
  }

  async embedMissing() {
    if (!this.embedder) return;
    const todo = new Map();
    for (const f of this.files.values()) for (const c of f.chunks) if (!this.vectors.has(c.hash)) todo.set(c.hash, c.embedText);
    if (!todo.size) return;
    const vecs = await this.embedder.embed([...todo.values()], "document");
    [...todo.keys()].forEach((h, i) => this.vectors.set(h, vecs[i]));
    await this.saveCache();
  }

  rebuild() {
    const files = [...this.files.values()];
    this.graph = new KnowledgeGraph(files);
    this.chunks = files.flatMap((f) => f.chunks);
    this.lexical = new Bm25(this.chunks);
    this.writeSnapshot().catch(() => {});
  }

  bm25(query) {
    return this.lexical.search(query);
  }

  /** Small on-disk snapshot used by the UserPromptSubmit hook (no network, no model). */
  async writeSnapshot() {
    if (!this.cacheDir) return;
    await mkdir(this.cacheDir, { recursive: true });
    const chunks = this.chunks
      .filter((c) => inDefaultScope(c))
      .map(({ id, path, line, text, embedText }) => ({ id, path, line, text, embedText }));
    await writeFile(join(this.cacheDir, "snapshot.json"), JSON.stringify({ at: Date.now(), chunks }));
  }

  async dense(query) {
    if (!this.embedder || !this.chunks.length) return [];
    const [qv] = await this.embedder.embed([query], "query");
    return this.chunks
      .filter((c) => this.vectors.has(c.hash))
      .map((c) => ({ c, s: cosine(qv, this.vectors.get(c.hash)) }))
      .sort((a, b) => b.s - a.s);
  }

  async search(query, { k = 8, prefix = "", expand = true } = {}) {
    await this.sync();
    if (!this.chunks?.length) return [];
    const inScope = (c) => inDefaultScope(c, prefix);
    const lexical = this.bm25(query).filter((x) => inScope(x.c));
    const semantic = (await this.dense(query)).filter((x) => inScope(x.c));
    const RRF_K = 60;
    const fused = new Map();
    const add = (list, label) =>
      list.slice(0, 50).forEach(({ c, s }, rank) => {
        const e = fused.get(c.id) || { chunk: c, score: 0, signals: {} };
        e.score += 1 / (RRF_K + rank + 1);
        e.signals[label] = +s.toFixed(4);
        fused.set(c.id, e);
      });
    add(lexical, "bm25");
    add(semantic, "cosine");
    // Weak semantic matches shouldn't surface on their own.
    let ranked = [...fused.values()]
      .filter((e) => e.signals.bm25 || (e.signals.cosine ?? 0) > (this.embedder?.profile?.floor ?? 0.3))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    if (expand && ranked.length) {
      const have = new Set(ranked.map((r) => r.chunk.path));
      const extra = [];
      for (const r of ranked.slice(0, 3)) {
        const nb = this.graph.neighbors(stem(r.chunk.path), 1);
        for (const n of nb?.nodes || []) {
          if (have.has(n.path) || !n.path.startsWith(prefix)) continue;
          const f = this.files.get(n.path);
          const first = f?.chunks.find((c) => inDefaultScope(c, prefix));
          if (!first) continue;
          have.add(n.path);
          extra.push({ chunk: first, score: r.score * 0.5, signals: { graph: stem(r.chunk.path) } });
        }
      }
      ranked = [...ranked, ...extra.slice(0, 3)];
    }
    return ranked.map((r) => ({
      path: r.chunk.path,
      line: r.chunk.line,
      heading: r.chunk.heading,
      text: r.chunk.text,
      score: +r.score.toFixed(5),
      signals: r.signals,
    }));
  }
}
