// The githippo brain: recall, auto-remember, pinned core memory, temporal
// supersession, forget, session checkpoints, consolidation, graph, time travel.
import { MemoryError, MAX_FILE_BYTES, normalizePath } from "./store.js";
import { factLines, hash, parseFile, plain, stem } from "./parse.js";
import { scan } from "./guard.js";
import { cosine } from "./embed.js";
import { tokenize } from "./search.js";

const KIND_FOLDER = { person: "people", project: "projects", topic: "topics", company: "orgs", decision: "decisions" };
const SYSTEM_FILES = new Set(["index.md", "core.md", "inbox.md"]);
const DUP = 0.93;
const RELATED = 0.75;

export const approxTokens = (s) => Math.ceil(s.length / 4);
const slugify = (s) =>
  s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const today = () => new Date().toISOString().slice(0, 10);
const bare = (l) => l.replace(/^\s*[-*]\s+/, "").trim();

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function assertSafe(text) {
  const findings = scan(text);
  if (findings.length) {
    throw new MemoryError(
      `Blocked by compliance guard: ${[...new Set(findings.map((f) => f.kind))].join(", ")}. ` +
        "Secrets and regulated identifiers are never committed to memory.",
      { findings },
    );
  }
}

function frontmatter({ name, title, kind, description, aliases = [] }) {
  return [
    "---",
    `name: ${name}`,
    `title: ${title}`,
    `type: ${kind}`,
    `description: ${description}`,
    `created: ${today()}`,
    `aliases: [${aliases.join(", ")}]`,
    "---",
    "",
    "",
  ].join("\n");
}

export class Brain {
  constructor({ store, index, llm = null, coreBudgetTokens = 400 }) {
    Object.assign(this, { store, index, llm, coreBudgetTokens });
    this.core = "";
  }

  get graph() {
    return this.index.graph;
  }

  file(path) {
    return this.index.files.get(path);
  }

  // ---------- core memory (pinned, injected into the system prompt) ----------
  async loadCore() {
    const f = this.file("core.md") || (await this.store.read("core.md"));
    this.core = f ? plain(parseFile("core.md", f.content).body.trim()) : "";
    return this.core;
  }

  // ---------- line similarity ----------
  async lineVectors(lines) {
    const emb = this.index.embedder;
    if (!emb) return null;
    const keys = lines.map((l) => `line:${hash(l)}`);
    const missing = [...new Set(keys.filter((k) => !this.index.vectors.has(k)))];
    if (missing.length) {
      const vecs = await emb.embed(missing.map((k) => lines[keys.indexOf(k)]), "document");
      missing.forEach((k, i) => this.index.vectors.set(k, vecs[i]));
    }
    return keys.map((k) => this.index.vectors.get(k));
  }

  async similarity(fact, lines) {
    if (!lines.length) return [];
    const norm = (s) => tokenize(plain(s)).join(" ");
    const vecs = await this.lineVectors([plain(fact), ...lines.map(plain)]);
    return lines.map((line, i) =>
      norm(line) === norm(fact) ? 1 : +(vecs ? cosine(vecs[0], vecs[i + 1]) : jaccard(fact, line)).toFixed(4),
    );
  }

  // ---------- recall ----------
  async recall(query, { budget = 1000, scope = "", mode = "auto" } = {}) {
    const hits = await this.index.search(query, { k: mode === "brief" ? 12 : 8, prefix: scope });
    if (mode === "brief") {
      return {
        mode,
        hits: hits.map((h) => ({ ref: `${h.path}:${h.line}`, text: plain(h.text.split("\n").find((l) => l.trim()) || "").slice(0, 110), via: h.signals.graph })),
      };
    }
    const entityId = this.graph.resolve(query);
    const cap = budget * 4;
    const sections = new Map();
    let used = 0;
    const take = (path, text, via) => {
      const f = this.file(path);
      if (!f) return;
      text = plain(text);
      if (!sections.has(path)) {
        const head = `§ ${path}${f.description ? ` — ${f.description}` : ""}${via ? ` (via ${via})` : ""} v:${f.version.slice(0, 8)}`;
        if (used + head.length > cap) return;
        sections.set(path, { head, parts: [] });
        used += head.length;
      }
      const s = sections.get(path);
      if (s.parts.includes(text)) return;
      const room = cap - used;
      if (room < 40) return;
      const piece = text.length > room ? `${text.slice(0, room - 1)}…` : text;
      s.parts.push(piece);
      used += piece.length;
    };
    if (entityId && !SYSTEM_FILES.has(this.graph.nodes.get(entityId).path)) {
      const f = this.file(this.graph.nodes.get(entityId).path);
      if (f && (!scope || f.path.startsWith(scope))) take(f.path, f.live.trim(), null);
    }
    for (const h of hits) take(h.path, h.text, h.signals.graph);
    const context = [...sections.values()].map((s) => `${s.head}\n${s.parts.join("\n")}`).join("\n");
    return { mode: "pack", context, tokens: approxTokens(context), files: sections.size };
  }

  // ---------- remember ----------
  async chooseTarget(fact, { about, path, kind }) {
    if (path) return { path: normalizePath(path), reason: "explicit" };
    if (about) {
      const id = this.graph.resolve(about);
      if (id) return { path: this.graph.nodes.get(id).path, reason: `entity:${id}` };
      return { path: `${KIND_FOLDER[kind] || "topics"}/${slugify(about)}.md`, reason: "new entity", create: { title: about, kind: kind || "topic" } };
    }
    const mentioned = this.graph.mentions(fact).map((m) => m.id);
    const hits = await this.index.search(fact, { k: 5, expand: false });
    if (mentioned.length) {
      const best = hits.find((h) => mentioned.includes(stem(h.path)));
      const id = best ? stem(best.path) : mentioned[0];
      return { path: this.graph.nodes.get(id).path, reason: `mentions:${id}` };
    }
    const strong = hits.find((h) => ((h.signals.cosine ?? 0) >= 0.45 || (h.signals.bm25 ?? 0) >= 3) && !SYSTEM_FILES.has(h.path));
    if (strong) return { path: strong.path, reason: "semantic" };
    return { path: "inbox.md", reason: "inbox", create: { title: "Inbox", kind: "inbox" } };
  }

  async remember(fact, opts = {}) {
    const clean = bare(fact).replace(/\s+/g, " ");
    if (clean.length < 3) throw new MemoryError("Fact is empty.");
    assertSafe(clean);
    await this.index.sync();
    if (opts.pin) return this.pin(clean);

    const target = await this.chooseTarget(clean, opts);
    const existing = this.file(target.path) || (await this.store.read(target.path));
    const content = existing?.content ?? null;

    if (opts.replaces) return this.supersede(target.path, existing, opts.replaces, clean);

    // Duplicate / supersession check against target + nearest files.
    const candidates = new Set([target.path]);
    for (const h of await this.index.search(clean, { k: 3, expand: false })) candidates.add(h.path);
    const lines = [];
    for (const p of candidates) {
      const f = this.file(p);
      if (f) for (const l of factLines(f.body)) lines.push({ path: p, line: l });
    }
    const sims = await this.similarity(clean, lines.map((l) => l.line));
    const scored = lines.map((l, i) => ({ ...l, sim: sims[i] })).sort((a, b) => b.sim - a.sim);
    if (scored[0]?.sim >= DUP) return { status: "duplicate", path: scored[0].path, existing: plain(scored[0].line) };
    const related = scored.filter((s) => s.sim >= RELATED).slice(0, 2);

    const { text, linked } = this.graph.autoLink(clean, [stem(target.path)]);
    const line = `- ${text}`;
    let next;
    if (!content) {
      const c = target.create || { title: stem(target.path), kind: "topic" };
      const aliases = c.kind === "person" && c.title.includes(" ") ? [c.title.split(" ")[0]] : [];
      next = `${frontmatter({ name: stem(target.path), title: c.title, kind: c.kind, description: c.title, aliases })}${line}\n`;
    } else {
      next = insertLive(content, line);
      if (Buffer.byteLength(next) > MAX_FILE_BYTES * 0.9) {
        throw new MemoryError(`${target.path} is nearly full; run maintain with rewrite first.`);
      }
    }
    const r = await this.store.write(target.path, next, content ? existing.version : "new", "remember");
    await this.index.upsert(target.path, next, r.version);
    if (!content) await this.addToIndex(target.path, target.create?.title || stem(target.path));
    return {
      status: "saved",
      path: target.path,
      reason: target.reason,
      linked,
      maybe_supersedes: related.map((r) => ({ path: r.path, line: plain(r.line) })),
    };
  }

  /** Temporal supersession: the old fact moves to a dated History section (excluded from recall), never silently lost. */
  async supersede(path, existing, oldText, newFact) {
    if (!existing) throw new MemoryError(`${path} does not exist; nothing to replace.`);
    const content = existing.content;
    const want = tokenize(plain(bare(oldText))).join(" ");
    const lines = content.split("\n");
    const historyAt = lines.findIndex((l) => /^#{1,6}\s+history\s*$/i.test(l));
    const idx = lines.findIndex((l, i) => (historyAt < 0 || i < historyAt) && /^\s*[-*]\s+/.test(l) && tokenize(plain(bare(l))).join(" ") === want);
    if (idx < 0) throw new MemoryError(`Line to replace not found in ${path}.`);
    const old = bare(lines[idx]);
    const { text, linked } = this.graph.autoLink(newFact, [stem(path)]);
    lines[idx] = `- ${text}`;
    let next = lines.join("\n").replace(/\n*$/, "\n");
    const record = `- ~~${old}~~ (until ${today()})`;
    next = /^#{1,6}\s+history\s*$/im.test(next) ? `${next}${record}\n` : `${next}\n## History\n${record}\n`;
    const r = await this.store.write(path, next, existing.version, "supersede");
    await this.index.upsert(path, next, r.version);
    return { status: "superseded", path, old: plain(old), new: plain(text), linked };
  }

  async pin(fact) {
    const existing = this.file("core.md") || (await this.store.read("core.md"));
    const base = existing?.content ?? frontmatter({ name: "core", title: "Core memory", kind: "core", description: "Pinned facts injected into every session" });
    if (factLines(base).some((l) => tokenize(plain(l)).join(" ") === tokenize(fact).join(" "))) {
      return { status: "duplicate", path: "core.md", existing: fact };
    }
    const next = insertLive(base, `- ${fact}`);
    const body = parseFile("core.md", next).body;
    if (approxTokens(body) > this.coreBudgetTokens) {
      throw new MemoryError(`Core memory would exceed ${this.coreBudgetTokens} tokens. Unpin something (forget with path core.md) or save it unpinned.`);
    }
    const r = await this.store.write("core.md", next, existing ? existing.version : "new", "pin");
    await this.index.upsert("core.md", next, r.version);
    await this.loadCore();
    return { status: "pinned", path: "core.md", core_tokens: approxTokens(this.core) };
  }

  async forget(text, { path } = {}) {
    await this.index.sync();
    const want = tokenize(plain(bare(text))).join(" ");
    let candidates = path ? [normalizePath(path)] : [];
    if (!path) {
      const hits = await this.index.search(text, { k: 5, expand: false });
      candidates = [...new Set([...hits.map((h) => h.path), "core.md"])];
    }
    for (const p of candidates) {
      const f = this.file(p);
      if (!f) continue;
      const lines = f.content.split("\n");
      const idx = lines.findIndex((l) => /^\s*[-*]\s+/.test(l) && tokenize(plain(bare(l))).join(" ") === want);
      if (idx < 0) continue;
      const removed = bare(lines[idx]);
      lines.splice(idx, 1);
      const next = lines.join("\n");
      const r = await this.store.write(p, next, f.version, "forget");
      await this.index.upsert(p, next, r.version);
      if (p === "core.md") await this.loadCore();
      return { status: "forgotten", path: p, line: plain(removed), note: "Still in git history; rewrite history to purge completely." };
    }
    throw new MemoryError("No exact matching line found. Use recall mode=brief to get the exact text.");
  }

  async addToIndex(path, description) {
    const idx = this.file("index.md");
    if (!idx || idx.content.includes(`[[${stem(path)}`)) return;
    const next = `${idx.content.replace(/\n*$/, "\n")}- [[${stem(path)}]] — ${description}\n`;
    const r = await this.store.write("index.md", next, idx.version, "index");
    await this.index.upsert("index.md", next, r.version);
  }

  // ---------- session checkpoints (compaction anchor for any client) ----------
  async checkpoint({ session = "default", task, state, next, files } = {}) {
    await this.index.sync();
    const path = `sessions/${slugify(session) || "default"}.md`;
    const existing = this.file(path) || (await this.store.read(path));
    if (!task && !state && !next) {
      if (!existing) return { status: "none", path };
      const body = plain(parseFile(path, existing.content).body.trim());
      return { status: "resume", path, checkpoint: body, tokens: approxTokens(body) };
    }
    const lines = [
      frontmatter({ name: stem(path), title: `Session ${session}`, kind: "session", description: `Working state for session ${session}` }).replace(/created: .*/, `updated: ${new Date().toISOString()}`),
      task && `## Task\n- ${task}`,
      state && `## State\n${state.split("\n").map((l) => (l.trim().startsWith("-") ? l.trim() : `- ${l.trim()}`)).join("\n")}`,
      files?.length && `## Files\n${files.map((f) => `- ${f}`).join("\n")}`,
      next && `## Next\n- ${next}`,
    ].filter(Boolean);
    const content = `${lines.join("\n\n")}\n`;
    assertSafe(content);
    const r = await this.store.write(path, content, existing ? existing.version : "new", "checkpoint");
    await this.index.upsert(path, content, r.version);
    return { status: "checkpointed", path, tokens: approxTokens(content) };
  }

  async saveRawCheckpoint(path, content) {
    assertSafe(content);
    const existing = await this.store.read(path);
    return this.store.write(path, content, existing ? existing.version : "new", "precompact");
  }

  // ---------- consolidation ----------
  async maintain({ reindex = false, rewrite = null } = {}) {
    await this.index.sync({ maxAgeMs: 0 });
    const files = [...this.index.files.values()].filter((f) => !f.path.startsWith("sessions/"));
    const all = files.flatMap((f) => factLines(f.body).map((line) => ({ path: f.path, line }))).slice(0, 500);
    const duplicates = [];
    const vecs = await this.lineVectors(all.map((a) => plain(a.line)));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const sim = vecs ? cosine(vecs[i], vecs[j]) : jaccard(all[i].line, all[j].line);
        if (sim >= DUP) duplicates.push({ a: all[i], b: all[j], sim: +sim.toFixed(3) });
      }
    }
    const indexBody = this.file("index.md")?.body || "";
    const health = this.graph.health();
    const report = {
      files: files.length,
      facts: all.length,
      core_tokens: approxTokens(this.core),
      duplicates: duplicates.slice(0, 20),
      oversized: files.filter((f) => Buffer.byteLength(f.content) > MAX_FILE_BYTES * 0.75).map((f) => f.path),
      missing_from_index: files.filter((f) => !SYSTEM_FILES.has(f.path) && !indexBody.includes(`[[${stem(f.path)}`)).map((f) => f.path),
      orphans: health.orphans.filter((p) => !SYSTEM_FILES.has(p) && !p.startsWith("sessions/")),
      broken_links: health.broken_links,
      actions: [],
    };

    if (reindex) {
      const groups = new Map();
      for (const f of files.filter((f) => !SYSTEM_FILES.has(f.path))) {
        const g = f.path.includes("/") ? f.path.split("/")[0] : "root";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(`- [[${stem(f.path)}]] — ${f.description || f.title}`);
      }
      const body =
        "---\nname: index\ndescription: Table of contents. Generated by githippo maintain.\n---\n\n" +
        [...groups].sort().map(([g, ls]) => `## ${g}\n${ls.sort().join("\n")}`).join("\n\n") + "\n";
      const cur = this.file("index.md");
      const r = await this.store.write("index.md", body, cur ? cur.version : "new", "reindex");
      await this.index.upsert("index.md", body, r.version);
      report.actions.push("rebuilt index.md");
    }

    if (rewrite) {
      if (!this.llm) throw new MemoryError("rewrite needs ANTHROPIC_API_KEY on the server.");
      const p = normalizePath(rewrite);
      const f = this.file(p);
      if (!f) throw new MemoryError(`${p} not found.`);
      const hints = duplicates.filter((d) => d.a.path === p || d.b.path === p).map((d) => [d.a.line, d.b.line]);
      const next = await this.llm.consolidate(f.content, hints);
      assertSafe(next);
      const lost = [...f.content.matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]).filter((l) => !next.includes(`[[${l}`));
      if (lost.length) throw new MemoryError(`Rewrite dropped links (${[...new Set(lost)].join(", ")}); not saved.`);
      if (f.content.startsWith("---") && !next.startsWith("---")) throw new MemoryError("Rewrite dropped frontmatter; not saved.");
      const r = await this.store.write(p, next, f.version, "consolidate");
      await this.index.upsert(p, next, r.version);
      report.actions.push(`rewrote ${p}: ${factLines(f.body).length}→${factLines(parseFile(p, next).body).length} facts`);
    }
    return report;
  }

  // ---------- graph & time ----------
  async neighbors(entity, depth = 1) {
    await this.index.sync();
    const r = this.graph.neighbors(entity, Math.min(depth, 3));
    if (!r) throw new MemoryError(`No entity "${entity}". Try recall.`);
    return r;
  }

  resolvePath(entity) {
    const id = this.graph.resolve(entity);
    return id ? this.graph.nodes.get(id).path : normalizePath(entity.endsWith(".md") ? entity : `${entity}.md`);
  }

  async history(entity, { at, limit = 15 } = {}) {
    await this.index.sync();
    const path = this.resolvePath(entity);
    if (at) return { kind: "as_of", ...(await this.store.at(path, at)) };
    return { kind: "timeline", path, commits: await this.store.history(path, limit) };
  }
}

/** Appends a line to the live section, i.e. before any "## History" heading. */
export function insertLive(content, line) {
  const m = content.match(/\n#{1,6}\s+history\s*\n/i);
  if (!m) return `${content.replace(/\n*$/, "\n")}${line}\n`;
  const head = content.slice(0, m.index).replace(/\n*$/, "\n");
  return `${head}${line}\n${content.slice(m.index)}`;
}
