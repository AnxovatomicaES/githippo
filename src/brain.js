// The githippo brain: recall, auto-remember, pinned core memory, temporal
// supersession, forget, session checkpoints, consolidation, graph, time travel.
import { MemoryError, MAX_FILE_BYTES, normalizePath } from "./store.js";
import { factLines, hash, parseFile, plain, stamp, stampOf, stem, stripMemoryTags } from "./parse.js";
import { redact, scan } from "./guard.js";
import { cosine } from "./embed.js";
import { tokenize } from "./search.js";
import { ALLOW_ALL, AclStore } from "./accounts.js";
import { terse } from "./terse.js";
import { KeyedMutex } from "./lock.js";
import { injectionKinds } from "./injection.js";

const KIND_FOLDER = { person: "people", project: "projects", topic: "topics", company: "orgs", decision: "decisions" };
const SYSTEM_FILES = new Set(["index.md", "core.md", "inbox.md"]);
// Words that start sentences without naming anything (EN + ES); any other capitalised word is a name.
const STARTERS = new Set(
  "the a an this that these those it its we i our my you your they he she use uses prefers always never all every each no not do does is are was el la los las un una unos unas este esta estos estas se usa usar prefiere siempre nunca todo todos cada no es son hay".split(" "),
);

/** Tokens that change a fact's meaning even when embeddings barely notice: numbers, dates, names. */
export function salient(text) {
  const words = plain(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  const out = new Set();
  words.forEach((w, i) => {
    const lw = w.toLowerCase();
    if (/\d/.test(w)) out.add(lw);
    else if (/^\p{Lu}/u.test(w) && !(i === 0 && STARTERS.has(lw))) out.add(lw);
  });
  return out;
}

/**
 * True if either side has a salient token the other text doesn't contain at all.
 * `ignore`: names of the entity the fact is filed under ("Sample rate for Johnny is 16 kHz" in Johnny's
 * own file says the same as "Sample rate is 16 kHz").
 */
export function salientDiffers(a, b, ignore = new Set()) {
  const ta = new Set(plain(a).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);
  const tb = new Set(plain(b).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);
  const keep = (t) => !ignore.has(t);
  return [...salient(a)].filter(keep).some((t) => !tb.has(t)) || [...salient(b)].filter(keep).some((t) => !ta.has(t));
}

export const approxTokens = (s) => Math.ceil(s.length / 4);
// B3: names with no Latin letters ("王伟") still get a stable, valid file name.
const slugify = (s) =>
  s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) ||
  `entity-${hash(s).slice(0, 8)}`;
// B4: anything user-supplied that lands in frontmatter is one line and can't open a new key.
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const yamlValue = (s) => (/[:#\[\]{}"']|^[-?&*!|>%@`]/.test(s) ? `"${s.replace(/"/g, "'")}"` : s);
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

// Words that are never topical enough to decide where a fact belongs, however rare they are in a vault:
// time words, everyday verbs/adjectives and filler, in the supported languages. Used only for routing.
const EVERYDAY = new Set(
  [
    "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday",
    "day week month year today tomorrow yesterday morning afternoon evening night time hour minute second first last next early late soon now ago",
    "about good great bad new old big small long short high low best better more less most least much many few very really also still only just",
    "get got make made need want like prefer think know see read say said take give use go come keep let put try call ask tell work feel look find",
    "thing stuff people person way part lot kind place point case fact idea question problem number",
    "over under above below before after during between into onto through across around without within than then there here every each all some any other another same such own",
    "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre lunes martes miércoles jueves viernes sábado domingo",
    "día semana mes año hoy mañana ayer tarde noche hora antes después ahora bueno buena malo nuevo nueva más menos muy también solo",
    "quiere necesita prefiere hacer tener usar ver leer decir cosa gente persona vez parte",
    "sobre bajo entre durante desde hasta hacia cada todo toda todos otro otra mismo",
  ].join(" ").split(" ").map((w) => (w.length > 4 && /[^su]s$/.test(w) ? w.slice(0, -1) : w)),
);

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
    `title: ${yamlValue(oneLine(title))}`,
    `type: ${kind}`,
    `description: ${yamlValue(oneLine(description))}`,
    `created: ${today()}`,
    `aliases: [${aliases.map((a) => oneLine(a).replace(/[,\[\]]/g, " ")).join(", ")}]`,
    "---",
    "",
    "",
  ].join("\n");
}

export class Brain {
  constructor({ store, index, llm = null, coreBudgetTokens = 400, decayActiveDays = 20, style = "plain" }) {
    Object.assign(this, { store, index, llm, coreBudgetTokens, decayActiveDays, style });
    this.core = "";
    this.acl = ALLOW_ALL;
  }

  /**
   * A view of this brain for one user: same index and models, but every read, write and search goes
   * through their folder ACL, and commits are attributed to them.
   */
  forUser(acl) {
    if (!acl || acl === ALLOW_ALL) return this;
    const view = Object.create(this);
    view.acl = acl;
    view.store = new AclStore(this.store, acl);
    view.core = "";
    return view;
  }

  get user() {
    return this.acl.user || null;
  }

  search(q, opts = {}) {
    return this.index.search(q, { ...opts, canRead: (p) => this.acl.canRead(p), user: this.user });
  }

  get graph() {
    return this.index.graph;
  }

  get t() {
    // No embedder → similarity is token overlap (Jaccard), whose scale differs from cosine: a one-word
    // change in a five-word fact scores ~0.6. Thresholds from that arithmetic, not tuned on the eval set.
    return this.index.embedder?.profile || { dup: 0.8, related: 0.5, conflict: 0.6, strong: 0.45, floor: 0.3 };
  }

  file(path) {
    return this.acl.canRead(path) ? this.index.files.get(path) : undefined;
  }

  // ---------- core memory (pinned, injected into the system prompt) ----------
  async loadCore() {
    const parts = [];
    for (const p of [...new Set(["core.md", this.acl.home("core.md")])]) {
      if (!this.acl.canRead(p)) continue;
      const f = this.file(p) || (await this.store.read(p).catch(() => null));
      if (f) parts.push(plain(parseFile(p, f.content).body.trim()));
    }
    this.core = parts.filter(Boolean).join("\n");
    if (this.style === "terse") this.core = terse(this.core);
    return this.core;
  }

  // ---------- line similarity ----------
  async lineVectors(lines) {
    const emb = this.index.embedder;
    if (!emb) return null;
    const keys = lines.map((l) => `line:${hash(l)}`);
    const missing = [...new Set(keys.filter((k) => !this.index.vectors.has(k)))];
    if (missing.length) {
      const vecs = await this.index.safeEmbed(missing.map((k) => lines[keys.indexOf(k)]), "document");
      if (!vecs) return null; // B16: fall back to token overlap
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
    budget = Math.min(8000, Math.max(100, Number.isFinite(+budget) ? +budget : 1000)); // B14
    const hits = await this.search(query, { k: mode === "brief" ? 12 : 8, prefix: scope });
    if (mode === "brief") {
      return {
        mode,
        // Per-hit cost of expanding it (idea from claude-mem), so the model can choose what is worth reading.
        hits: hits.map((h) => ({ ref: `${h.path}:${h.line}`, text: plain(h.text.split("\n").find((l) => l.trim()) || "").slice(0, 110), cost: approxTokens(plain(h.text)), via: h.signals.graph })),
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
    // memory that was actually handed to the model counts as "used" for ranking
    this.index.usage.record(hits.filter((h) => sections.has(h.path)).map((h) => h.chunk), this.user);
    let context = [...sections.values()].map((s) => `${s.head}\n${s.parts.join("\n")}`).join("\n");
    if (this.style === "terse") context = terse(context);
    return { mode: "pack", context, tokens: approxTokens(context), files: sections.size };
  }

  // ---------- remember ----------
  async chooseTarget(fact, { about, path, kind }) {
    if (path) {
      // a new note created by explicit path still gets a proper title and type when we know them
      const create = about ? { title: oneLine(about), kind: kind || (/^people\//.test(path) ? "person" : "topic") } : undefined;
      return { path: normalizePath(path), reason: "explicit", ...(create ? { create } : {}) };
    }
    if (about) {
      const id = this.graph.resolve(about);
      if (id) return { path: this.graph.nodes.get(id).path, reason: `entity:${id}` };
      return { path: `${KIND_FOLDER[kind] || "topics"}/${slugify(about)}.md`, reason: "new entity", create: { title: about, kind: kind || "topic" } };
    }
    const mentioned = this.graph.mentions(fact).map((m) => m.id).filter((id) => this.acl.canRead(this.graph.nodes.get(id).path));
    const hits = await this.search(fact, { k: 5, expand: false });
    if (mentioned.length) {
      const best = hits.find((h) => mentioned.includes(this.graph.idOf(h.path)));
      const id = best ? this.graph.idOf(best.path) : mentioned[0];
      return { path: this.graph.nodes.get(id).path, reason: `mentions:${id}` };
    }
    const lexical = this.distinctiveMatch(fact);
    if (lexical) return { path: lexical, reason: "distinctive words" };
    const strong = hits.find((h) => (h.signals.cosine ?? 0) >= this.t.strong && !SYSTEM_FILES.has(h.path));
    if (strong) return { path: strong.path, reason: "semantic" };
    return { path: this.acl.home("inbox.md"), reason: "inbox", create: { title: "Inbox", kind: "inbox" } };
  }

  /**
   * Keyword routing that doesn't depend on vault size: a note wins if it shares a *distinctive* word with
   * the fact (one found in at most 2 notes) and clearly beats the runner-up. Common words ("manual",
   * "prefers") can't route a fact anywhere; with no distinctive match the fact goes to the inbox.
   */
  distinctiveMatch(fact, { maxFiles = 2, margin = 1.5 } = {}) {
    const lex = this.index.lexical;
    if (!lex) return null;
    const fileOf = new Map();
    for (const c of this.index.chunks || []) {
      if (SYSTEM_FILES.has(c.path) || c.path.startsWith("sessions/") || c.history || !this.acl.canRead(c.path)) continue;
      for (const t of lex.tf.get(c.id).counts.keys()) {
        if (!fileOf.has(t)) fileOf.set(t, new Set());
        fileOf.get(t).add(c.path);
      }
    }
    const nFiles = new Set([...fileOf.values()].flatMap((s) => [...s])).size || 1;
    const score = new Map();
    for (const t of new Set(tokenize(fact))) {
      if (t.length < 3 || /^\d+$/.test(t) || /\d/.test(t) && t.length < 4 || EVERYDAY.has(t)) continue;
      const files = fileOf.get(t);
      if (!files || files.size > maxFiles || files.size > Math.max(1, nFiles * 0.15)) continue;
      const idf = Math.log(1 + nFiles / files.size);
      for (const f of files) score.set(f, (score.get(f) || 0) + idf);
    }
    const ranked = [...score].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const [top, second] = ranked;
    return !second || top[1] >= margin * second[1] ? top[0] : null;
  }

  /** Where a fact may actually be written: its natural home, or the user's own inbox if that's off-limits. */
  async writableTarget(fact, opts) {
    const t = await this.chooseTarget(fact, opts);
    if (this.acl.canWrite(t.path) || opts.path) return t;
    return { path: this.acl.home("inbox.md"), reason: `${t.reason}, no write access → your inbox`, create: { title: "Inbox", kind: "inbox" } };
  }

  /** B15: if another session/surface changed the file between our read and write, re-sync once and redo. */
  async retrying(fn) {
    // In-process: mutating operations run one at a time (shared by every per-user view, via the index),
    // so they always read what the previous one wrote. Across processes: re-sync and retry with backoff.
    const mutex = (this.index.writeMutex ??= new KeyedMutex());
    return mutex.run("memory", async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (attempt >= 5 || !(e instanceof MemoryError) || !/Version conflict|already exists|sha|409/.test(e.message)) throw e;
          await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 30));
          await this.index.sync({ maxAgeMs: 0 });
        }
      }
    });
  }

  async remember(fact, opts = {}) {
    return this.retrying(() => this._remember(fact, opts));
  }

  async _remember(fact, opts = {}) {
    const { text: visible, removed } = stripMemoryTags(fact);
    const clean = bare(visible).replace(/\s+/g, " ");
    if (clean.length < 3) throw new MemoryError(removed ? "Nothing to save: the fact was entirely inside <private> tags." : "Fact is empty.");
    assertSafe(clean);
    const inj = injectionKinds(clean);
    if (inj.length) {
      throw new MemoryError(`Not saved: this reads like instructions aimed at an AI (${inj.join(", ")}), and memory is replayed into future sessions as trusted context. If it's a genuine fact, rephrase it as a statement about the source.`);
    }
    const source = ["user", "inferred", "external", "import"].includes(opts.source) ? opts.source : null;
    await this.index.sync();
    if (opts.pin) {
      if (source === "external") throw new MemoryError("External content can't be pinned to core memory, which is treated as always true.");
      return this.pin(clean);
    }

    const target = await this.writableTarget(clean, opts);
    const existing = this.file(target.path) || (await this.store.read(target.path));
    const content = existing?.content ?? null;

    if (opts.replaces) return this.supersede(target.path, existing, opts.replaces, clean);

    // Duplicate / supersession check against target + nearest files.
    const candidates = new Set([target.path]);
    for (const h of await this.search(clean, { k: 3, expand: false })) candidates.add(h.path);
    if (opts.movingFrom) candidates.delete(opts.movingFrom); // a fact being moved isn't a duplicate of itself
    const lines = [];
    for (const p of candidates) {
      const f = this.file(p);
      if (f) for (const l of factLines(f.body)) lines.push({ path: p, line: l });
    }
    const sims = await this.similarity(clean, lines.map((l) => l.line));
    const scored = lines.map((l, i) => ({ ...l, sim: sims[i] })).sort((a, b) => b.sim - a.sim);
    // A duplicate must match in meaning AND in details: "end of Q1" vs "end of Q2" embed almost identically.
    const node = this.graph.nodes.get(this.graph.idOf(target.path));
    const own = new Set((node?.names || []).flatMap((n) => n.toLowerCase().split(/[\s_-]+/)));
    const dup = scored.find((s) => s.sim >= this.t.dup && !salientDiffers(clean, s.line, s.path === target.path ? own : undefined));
    if (dup) return { status: "duplicate", path: dup.path, existing: plain(dup.line) };
    const related = scored.filter((s) => s.sim >= this.t.related).slice(0, 2);

    const { text, linked } = this.graph.autoLink(clean, [this.graph.idOf(target.path)]);
    const line = `- ${text}${stamp(undefined, source)}`;
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
    const historyAt = lines.findIndex((l) => /^#{1,6}\s+(?:history|archived)\s*$/i.test(l));
    const idx = lines.findIndex((l, i) => (historyAt < 0 || i < historyAt) && /^\s*[-*]\s+/.test(l) && tokenize(plain(bare(l))).join(" ") === want);
    if (idx < 0) throw new MemoryError(`Line to replace not found in ${path}.`);
    const old = plain(bare(lines[idx]));
    const { text, linked } = this.graph.autoLink(newFact, [this.graph.idOf(path)]);
    lines[idx] = `- ${text}${stamp()}`;
    let next = lines.join("\n").replace(/\n*$/, "\n");
    const record = `- ~~${old}~~ (until ${today()})`;
    next = /^#{1,6}\s+history\s*$/im.test(next) ? `${next}${record}\n` : `${next}\n## History\n${record}\n`;
    const r = await this.store.write(path, next, existing.version, "supersede");
    await this.index.upsert(path, next, r.version);
    return { status: "superseded", path, old: plain(old), new: plain(text), linked };
  }

  async pin(fact) {
    const corePath = this.acl.canWrite("core.md") ? "core.md" : this.acl.home("core.md");
    const existing = this.file(corePath) || (await this.store.read(corePath));
    const base = existing?.content ?? frontmatter({ name: "core", title: "Core memory", kind: "core", description: "Pinned facts injected into every session" });
    if (factLines(base).some((l) => tokenize(plain(l)).join(" ") === tokenize(fact).join(" "))) {
      return { status: "duplicate", path: "core.md", existing: fact };
    }
    const next = insertLive(base, `- ${fact}`); // core is pinned: never stamped, never decays
    const body = parseFile(corePath, next).body;
    if (approxTokens(body) > this.coreBudgetTokens) {
      throw new MemoryError(`Core memory would exceed ${this.coreBudgetTokens} tokens. Unpin something (forget with path core.md) or save it unpinned.`);
    }
    const r = await this.store.write(corePath, next, existing ? existing.version : "new", "pin");
    await this.index.upsert(corePath, next, r.version);
    await this.loadCore();
    return { status: "pinned", path: corePath, core_tokens: approxTokens(this.core) };
  }

  async forget(text, opts = {}) {
    return this.retrying(() => this._forget(text, opts));
  }

  async _forget(text, { path } = {}) {
    await this.index.sync();
    const want = tokenize(plain(bare(text))).join(" ");
    let candidates = path ? [normalizePath(path)] : [];
    if (!path) {
      const hits = await this.search(text, { k: 5, expand: false });
      candidates = [...new Set([...hits.map((h) => h.path), "core.md", this.acl.home("core.md")])].filter((p) => this.acl.canWrite(p));
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
      if (/(^|\/)core\.md$/.test(p)) await this.loadCore();
      return { status: "forgotten", path: p, line: plain(removed), note: "Still in git history; rewrite history to purge completely." };
    }
    throw new MemoryError("No exact matching line found. Use recall mode=brief to get the exact text.");
  }

  async addToIndex(path, description) {
    if (SYSTEM_FILES.has(path) || /^users\//.test(path) || !this.acl.canWrite("index.md")) return; // B13, ACL
    const idx = this.file("index.md");
    if (!idx || idx.content.includes(`[[${stem(path)}`)) return;
    const next = `${idx.content.replace(/\n*$/, "\n")}- [[${stem(path)}]] — ${description}\n`;
    const r = await this.store.write("index.md", next, idx.version, "index");
    await this.index.upsert("index.md", next, r.version);
  }

  // ---------- session checkpoints (compaction anchor for any client) ----------
  async checkpoint(opts = {}) {
    return this.retrying(() => this._checkpoint(opts));
  }

  async _checkpoint({ session = "default", task, state, next, files } = {}) {
    await this.index.sync();
    const path = this.acl.user ? this.acl.home(`sessions/${slugify(session) || "default"}.md`) : `sessions/${slugify(session) || "default"}.md`;
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
    const content = `${stripMemoryTags(lines.join("\n\n")).text}\n`;
    assertSafe(content);
    const r = await this.store.write(path, content, existing ? existing.version : "new", "checkpoint");
    await this.index.upsert(path, content, r.version);
    return { status: "checkpointed", path, tokens: approxTokens(content) };
  }

  async saveRawCheckpoint(path, content, op = "precompact") {
    const { text } = redact(content); // B24
    const existing = await this.store.read(path);
    return this.store.write(path, text, existing ? existing.version : "new", op);
  }

  // ---------- consolidation ----------
  /**
   * Activity-aware decay (idea from claude-memory-system): age is counted in days you actually used memory,
   * not calendar days, so a holiday doesn't erase anything. Only low-value material decays: inbox facts and
   * session checkpoints. Core, people, projects and topics never do. Archived inbox facts stay in the file
   * under "## Archived" (out of recall); checkpoints are removed from the tree but stay in git history.
   */
  async decayCandidates(activeDaysLimit) {
    const today = new Date().toISOString().slice(0, 10);
    const oldest = [];
    const inbox = this.file("inbox.md");
    const stale = { inbox: [], sessions: [] };
    const inboxLines = inbox ? factLines(inbox.body).filter((l) => stampOf(l)) : [];
    for (const l of inboxLines) oldest.push(stampOf(l));
    const sessions = [...this.index.files.values()].filter((f) => f.path.startsWith("sessions/"));
    for (const f of sessions) oldest.push((f.meta.updated || f.meta.created || today).slice(0, 10));
    if (!oldest.length) return stale;
    const days = await this.store.activeDays(`${oldest.sort()[0]}T00:00:00Z`);
    const activeSince = (d) => days.filter((x) => x > d).length;
    for (const l of inboxLines) if (activeSince(stampOf(l)) >= activeDaysLimit) stale.inbox.push(l);
    for (const f of sessions) if (activeSince((f.meta.updated || f.meta.created || today).slice(0, 10)) >= activeDaysLimit) stale.sessions.push(f);
    return stale;
  }

  /**
   * A home for a fact sitting in the inbox. Looser than automatic filing (which refuses to guess on weak
   * evidence): any keyword match, or a semantic match above the model's floor, in a note the user can write.
   * Only applied by `maintain tidy=true`, i.e. when someone asks.
   */
  async suggestHome(fact) {
    const lexical = this.distinctiveMatch(fact, { maxFiles: 3, margin: 1 });
    if (lexical && this.acl.canWrite(lexical)) return { path: lexical, why: "shared key words" };
    if (!this.index.embedder) return null;
    const hits = await this.search(fact, { k: 5, expand: false });
    const h = hits.find((x) => !SYSTEM_FILES.has(x.path) && !/^users\/[^/]+\/inbox\.md$/.test(x.path) && this.acl.canWrite(x.path) && (x.signals.cosine ?? 0) >= this.t.floor + 0.1);
    return h ? { path: h.path, why: `similar (${h.signals.cosine.toFixed(2)})` } : null;
  }

  async maintain({ reindex = false, rewrite = null, decay = false, tidy = false, active_days = this.decayActiveDays } = {}) {
    if (!this.acl.isAdmin) throw new MemoryError("maintain works on the whole vault, so it needs full write access.");
    await this.index.sync({ maxAgeMs: 0 });
    const files = [...this.index.files.values()].filter((f) => !f.path.startsWith("sessions/"));
    const all = files.flatMap((f) => factLines(f.body).map((line) => ({ path: f.path, line: plain(line) }))).slice(0, 500);
    const duplicates = [];
    const conflicts = [];
    const vecs = await this.lineVectors(all.map((a) => plain(a.line)));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const sim = vecs ? cosine(vecs[i], vecs[j]) : jaccard(all[i].line, all[j].line);
        const differs = salientDiffers(all[i].line, all[j].line);
        if (sim >= this.t.dup && !differs) duplicates.push({ a: all[i], b: all[j], sim: +sim.toFixed(3) });
        else if (sim >= this.t.conflict && differs) conflicts.push({ a: all[i], b: all[j], sim: +sim.toFixed(3) });
      }
    }
    const indexBody = this.file("index.md")?.body || "";
    const health = this.graph.health();
    const report = {
      files: files.length,
      facts: all.length,
      core_tokens: approxTokens(this.core),
      duplicates: duplicates.slice(0, 20),
      conflicts: conflicts.slice(0, 20),
      oversized: files.filter((f) => Buffer.byteLength(f.content) > MAX_FILE_BYTES * 0.75).map((f) => f.path),
      missing_from_index: files.filter((f) => !SYSTEM_FILES.has(f.path) && !indexBody.includes(`[[${stem(f.path)}`)).map((f) => f.path),
      orphans: health.orphans.filter((p) => !SYSTEM_FILES.has(p) && !p.startsWith("sessions/")),
      broken_links: health.broken_links,
      actions: [],
    };

    // Inbox triage: suggest homes; move them only when asked (tidy=true).
    const inboxFile = this.file("inbox.md");
    report.inbox = [];
    for (const raw of inboxFile ? factLines(inboxFile.body) : []) {
      const fact = plain(raw);
      const home = await this.suggestHome(fact);
      if (home) report.inbox.push({ fact, ...home });
    }
    if (tidy && report.inbox.length) {
      let moved = 0;
      for (const { fact, path } of report.inbox) {
        const r = await this.remember(fact, { path, movingFrom: "inbox.md" });
        // Delete the inbox copy only once the fact verifiably lives in the destination note.
        const landed = (r.status === "saved" && r.path === path) || (r.status === "duplicate" && r.path === path);
        if (!landed) continue;
        await this.forget(fact, { path: "inbox.md" }).catch(() => {});
        moved++;
      }
      report.actions.push(`moved ${moved} inbox facts to their suggested notes`);
      report.inbox = [];
    }

    const stale = await this.decayCandidates(active_days).catch(() => ({ inbox: [], sessions: [] }));
    report.decay = { inbox: stale.inbox.length, sessions: stale.sessions.length, active_days };
    if (decay && stale.inbox.length) {
      const f = this.file("inbox.md");
      let lines = f.content.split("\n");
      const drop = new Set(stale.inbox.map((l) => l.trim()));
      lines = lines.filter((l) => !drop.has(l.replace(/^\s*[-*]\s+/, "").trim()));
      let next = lines.join("\n").replace(/\n*$/, "\n");
      const archived = stale.inbox.map((l) => `- ${plain(l)} (archived ${new Date().toISOString().slice(0, 10)})`).join("\n");
      next = /^#{1,6}\s+archived\s*$/im.test(next) ? `${next}${archived}\n` : `${next}\n## Archived\n${archived}\n`;
      const r = await this.store.write("inbox.md", next, f.version, "decay");
      await this.index.upsert("inbox.md", next, r.version);
      report.actions.push(`archived ${stale.inbox.length} inbox facts`);
    }
    if (decay) {
      for (const f of stale.sessions) {
        await this.store.delete(f.path, f.version);
        this.index.remove(f.path);
      }
      if (stale.sessions.length) report.actions.push(`removed ${stale.sessions.length} old checkpoints (kept in git history)`);
    }

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
    if (!r || !this.acl.canRead(r.entity.path)) throw new MemoryError(`No entity "${entity}". Try recall.`);
    const visible = new Set([r.entity.id, ...r.nodes.filter((n) => this.acl.canRead(n.path)).map((n) => n.id)]);
    return { ...r, nodes: r.nodes.filter((n) => visible.has(n.id)), relations: r.relations.filter((x) => visible.has(x.from) && visible.has(x.to)) };
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
  const m = content.match(/\n#{1,6}\s+(?:history|archived)\s*\n/i);
  if (!m) return `${content.replace(/\n*$/, "\n")}${line}\n`;
  const head = content.slice(0, m.index).replace(/\n*$/, "\n");
  return `${head}${line}\n${content.slice(m.index)}`;
}
