// Hybrid retrieval: BM25 (exact terms, names, numbers) + dense embeddings
// (meaning, cross-lingual) fused with Reciprocal Rank Fusion, then expanded
// one hop through the knowledge graph.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFile, stem } from "./parse.js";
import { KnowledgeGraph } from "./graph.js";
import { cosine } from "./embed.js";
import { Usage } from "./usage.js";
import { timeWindow, inWindow } from "./when.js";
import { hash as hashText } from "./parse.js";
import { forEachLimit } from "./lock.js";

// Function words for EN, ES, FR, DE, PT, IT. They carry no topic, so they shouldn't drive keyword ranking.
const STOP = new Set(
  [
    "the a an and or of to in on for with is are was were be by at as it this that from do does what who when where how which",
    "de la el los las y o en un una por con para que del al se es su lo qué cuál cuándo dónde quién cómo",
    "le les des et ou du au aux dans sur pour avec est sont ce cette qui quoi quand où comment quel quelle",
    "der die das den dem und oder von zu im in auf für mit ist sind ein eine was wer wann wo wie welche",
    "o os as um uma e ou do da dos das no na em para com é são que quem quando onde como qual",
    "il lo gli i e o di da in su per con è sono che chi quando dove come quale",
  ].join(" ").split(" "),
);

/**
 * Code-aware tokenizer (idea from claude-memory-hub): "handleRefund", "batch_insert" and "src/api/wake.ts"
 * also index as their parts ("handle", "refund", "batch", "insert", "api", "wake", "ts"), keeping the whole too.
 */
export const tokenize = (s) => {
  const out = [];
  const raw = s.normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}_./-]+/gu) || [];
  for (const w of raw) {
    const whole = w.toLowerCase().replace(/^[./-]+|[./-]+$/g, "");
    const parts = w
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .split(/[\s_./-]+/)
      .map((x) => x.toLowerCase())
      .filter(Boolean);
    if (parts.length > 1 && whole) out.push(whole);
    out.push(...parts);
  }
  // light plural folding so "refunds" meets "refund" and "invoices" meets "invoice" (not a full stemmer)
  return out.filter((t) => t.length > 1 && !STOP.has(t)).map((t) => (t.length > 4 && /[^su]s$/.test(t) ? t.slice(0, -1) : t));
};

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
const isSessionPath = (p) => p.startsWith("sessions/") || /^users\/[^/]+\/sessions\//.test(p);
const isCorePath = (p) => p === "core.md" || /^users\/[^/]+\/core\.md$/.test(p);

export function inDefaultScope(c, prefix = "") {
  if (!c.path.startsWith(prefix)) return false;
  if (prefix) return prefix.startsWith("sessions/") || /\/sessions\//.test(prefix) || !isSessionPath(c.path) ? !c.history || /history/i.test(prefix) : false;
  return !c.history && !isSessionPath(c.path) && !isCorePath(c.path) && c.path !== "index.md";
}

export class MemoryIndex {
  constructor(store, embedder, { cacheDir } = {}) {
    this.store = store;
    this.embedder = embedder;
    this.cacheDir = cacheDir;
    this.usage = new Usage(cacheDir ? join(cacheDir, "usage.json") : null);
    this.files = new Map(); // path -> parsed file (+version)
    this.vectors = new Map(); // chunk hash -> Float32Array
    this.graph = new KnowledgeGraph();
    this.syncing = null;
    this.lastSync = 0;
    this.embedPausedUntil = 0;
    this.embedError = null;
  }

  /**
   * B16: embeddings are an enhancement, never a dependency. If the model can't load (offline first run, no RAM)
   * or the provider errors, githippo keeps working on keyword search and retries embeddings 5 minutes later.
   */
  async safeEmbed(texts, kind) {
    if (!this.embedder || Date.now() < this.embedPausedUntil) return null;
    try {
      const v = await this.embedder.embed(texts, kind);
      this.embedError = null;
      return v;
    } catch (e) {
      this.embedPausedUntil = Date.now() + 5 * 60_000;
      if (this.embedError !== e.message) console.error(`[githippo] embeddings unavailable, using keyword search for now: ${e.message}`);
      this.embedError = e.message;
      return null;
    }
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

  /** B25: write at most every 3 s, keep only vectors still in use (+ the 2,000 most recent line vectors). */
  saveCache() {
    if (!this.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushCache().catch(() => {});
    }, 3000);
    this.saveTimer.unref?.();
  }

  async flushCache() {
    if (!this.cacheFile) return;
    const live = new Set((this.chunks || []).map((c) => c.hash));
    const lines = [...this.vectors.keys()].filter((k) => k.startsWith("line:")).slice(-2000);
    for (const k of [...this.vectors.keys()]) if (!live.has(k) && !lines.includes(k)) this.vectors.delete(k);
    await mkdir(this.cacheDir, { recursive: true });
    const obj = Object.fromEntries([...this.vectors].map(([h, v]) => [h, Array.from(v, (x) => +x.toFixed(5))]));
    await writeFile(this.cacheFile, JSON.stringify(obj));
  }

  /** Incremental sync: only files whose blob SHA changed are re-read and re-embedded. */
  async sync({ maxAgeMs = 5000 } = {}) {
    // another process committed to the vault since our last sync → re-sync now, not after maxAgeMs
    const token = this.store.stateToken?.() ?? null;
    if (Date.now() - this.lastSync < maxAgeMs && token === this.lastToken) return;
    this.lastToken = token;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      await this.loadCache();
      if (this.store.dir) {
        const { loadContexts } = await import("./contextualize.js");
        this.contexts = loadContexts(this.store.dir);
      }
      const listing = await this.store.list();
      const live = new Set(listing.map((f) => f.path));
      for (const p of this.files.keys()) if (!live.has(p)) this.files.delete(p);
      const changed = listing.filter((f) => this.files.get(f.path)?.version !== f.version);
      // Many changes (cold start): one tarball instead of one request per file, when the store supports it.
      if (changed.length > 20 && this.store.prefetch) await this.store.prefetch().catch(() => 0);
      const read = (f) => (this.store.readVersion ? this.store.readVersion(f.path, f.version) : this.store.read(f.path));
      await forEachLimit(
        changed,
        32,
        async (f) => {
          const file = await read(f);
          if (file) this.files.set(f.path, this.withContext({ ...parseFile(f.path, file.content, this.chunkChars ? { maxChars: this.chunkChars } : undefined), version: file.version, content: file.content }));
        },
      );
      // loud, not silent: a note that was listed but couldn't be read is a note the user can't search
      const unreadable = listing.filter((f) => !this.files.has(f.path));
      if (unreadable.length) console.error(`[githippo] ${unreadable.length} note(s) could not be read and are not searchable, e.g. ${unreadable[0].path}`);
      await this.embedMissing();
      this.rebuild();
      this.lastSync = Date.now();
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  /** Contextual retrieval: prepend a stored situating sentence to each chunk that has one. */
  withContext(file) {
    const ctx = this.contexts || {};
    for (const c of file.chunks) {
      c.baseHash = c.hash;
      const extra = ctx[c.hash];
      if (extra) {
        c.embedText = `${extra}\n${c.embedText}`;
        c.hash = hashText(c.embedText);
      }
    }
    return file;
  }

  /** Apply a write we just made without waiting for a full sync. */
  async upsert(path, content, version) {
    this.files.set(path, this.withContext({ ...parseFile(path, content), version, content }));
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
    const vecs = await this.safeEmbed([...todo.values()], "document");
    if (!vecs) return;
    [...todo.keys()].forEach((h, i) => this.vectors.set(h, vecs[i]));
    this.saveCache();
  }

  rebuild() {
    const files = [...this.files.values()];
    this.graph = new KnowledgeGraph(files);
    this.chunks = files.flatMap((f) => f.chunks);
    this.lexical = new Bm25(this.chunks);
    // Document-level index (one entry per note, live text only): a question whose words are spread across a
    // long note matches the note even when no single chunk contains them all. Fused with chunk evidence.
    this.docs = files.map((f) => ({ id: f.path, path: f.path, history: false, embedText: `${f.title} ${f.description || ""}\n${f.live}` }));
    this.docLexical = new Bm25(this.docs);
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
    const [qv] = (await this.safeEmbed([query], "query")) || [];
    if (!qv) return [];
    return this.chunks
      .filter((c) => this.vectors.has(c.hash))
      .map((c) => ({ c, s: cosine(qv, this.vectors.get(c.hash)) }))
      .sort((a, b) => b.s - a.s);
  }

  async search(query, { k = 8, prefix = "", expand = true, canRead = () => true, user = null, now = Date.now() } = {}) {
    await this.sync();
    if (!this.chunks?.length) return [];
    // Time-aware recall: "last spring", "in March", "3 days ago", "Q1"… → a window. Facts from that period
    // rank higher, and questions about the past may also see superseded (History) facts that were true then.
    const when = timeWindow(query, now);
    const inScope = (c) => (inDefaultScope(c, prefix) || (when?.past && c.history && inDefaultScope({ ...c, history: false }, prefix))) && canRead(c.path);
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
    // Document evidence: each matching note contributes its RRF term to its best chunk (or its first chunk
    // in scope, if none of its chunks matched on their own).
    const docHits = this.docLexical.search(query).filter((x) => x.c.path.startsWith(prefix) && canRead(x.c.path)).slice(0, 50);
    docHits.forEach(({ c, s }, rank) => {
      let best = null;
      for (const e of fused.values()) if (e.chunk.path === c.path && (!best || e.score > best.score)) best = e;
      if (!best) {
        const chunk = this.files.get(c.path)?.chunks.find((x) => inScope(x));
        if (!chunk) return;
        best = { chunk, score: 0, signals: {} };
        fused.set(chunk.id, best);
      }
      best.score += 1 / (RRF_K + rank + 1);
      best.signals.doc = +s.toFixed(4);
    });
    // Usage-weighted ranking: a small, fading boost for memory that keeps being used (1.0 with no data).
    for (const e of fused.values()) e.score *= this.usage.boost(e.chunk, user);
    if (when) {
      for (const e of fused.values()) {
        if (inWindow(e.chunk.dates, when)) {
          e.score *= 1.5;
          e.signals.when = true;
        } else if (e.chunk.history && !(e.chunk.dates || []).some((d) => d >= when.from)) e.score *= 0.5; // stopped being true before the window
      }
    }
    // Weak semantic matches shouldn't surface on their own.
    let ranked = [...fused.values()]
      .filter((e) => e.signals.bm25 || e.signals.doc || (e.signals.cosine ?? 0) > (this.embedder?.profile?.floor ?? 0.3))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    // RERANK=local: a cross-encoder rescores the top 20 (needs EMBEDDINGS=local for its worker)
    if (process.env.RERANK === "local" && this.embedder?.rerank && ranked.length > 1) {
      try {
        const top = ranked.slice(0, 20);
        const scores = await this.embedder.rerank(query, top.map((r) => r.chunk.text.slice(0, 1000)));
        top.forEach((r, i) => (r.signals.rerank = +scores[i].toFixed(3)));
        ranked = [...top.sort((a, b) => b.signals.rerank - a.signals.rerank), ...ranked.slice(20)];
      } catch {}
    }
    if (expand && ranked.length) {
      const have = new Set(ranked.map((r) => r.chunk.path));
      const extra = [];
      for (const r of ranked.slice(0, 3)) {
        const nb = this.graph.neighbors(this.graph.idOf(r.chunk.path), 1);
        for (const n of nb?.nodes || []) {
          if (have.has(n.path) || !n.path.startsWith(prefix)) continue;
          const f = this.files.get(n.path);
          const first = f?.chunks.find((c) => inDefaultScope(c, prefix) && canRead(c.path));
          if (!first) continue;
          have.add(n.path);
          extra.push({ chunk: first, score: r.score * 0.5, signals: { graph: this.graph.idOf(r.chunk.path) } });
        }
      }
      ranked = [...ranked, ...extra.slice(0, 3)];
    }
    return ranked.map((r) => ({
      chunk: r.chunk,
      path: r.chunk.path,
      line: r.chunk.line,
      heading: r.chunk.heading,
      text: r.chunk.text,
      score: +r.score.toFixed(5),
      signals: r.signals,
    }));
  }
}
