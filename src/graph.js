// Knowledge graph over memory files: entities are files, edges are [[links]].
import { stem } from "./parse.js";

// link contents exclude "[" so an unclosed "[[" can't make every later attempt scan to the end (quadratic)
const LINK_RE = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g;
// One-word first names that are also everyday words (B6).
const COMMON_WORDS = new Set("will mark may bill grace hope rose frank april june august max jack art sky page rich dawn pat sue ray joy faith amber summer ivy hunter chase drew wade gene earl iris lily violet sage river skye angel king prince major".split(" "));

/** Replaces URLs, `code` and [[links]] with spaces of the same length, so positions stay aligned (B7). */
export function maskSpans(text) {
  return text.replace(/https?:\/\/\S+|www\.\S+|`[^`]*`|\[\[[^\[\]]*\]\]/g, (m) => " ".repeat(m.length));
}

/** Wiki-link edges of one note, extracted once and cached on the parsed file object (rebuilds reuse it). */
function linksOf(f) {
  if (f.rawLinks) return f.rawLinks;
  const out = [];
  for (const line of (f.live ?? f.body).split("\n")) {
    if (!line.includes("[[")) continue;
    // anchored / bounded patterns: an unanchored ([a-z][\w-]*):: backtracked quadratically on long words
    const typed = line.match(/^\s*[-*]\s+([a-z][\w-]{0,40})\s+\[\[/) || (line.includes("::") ? line.match(/(?:^|[\s(*])([a-z][\w-]{0,40})::\s*\[\[/) : null);
    for (const m of line.matchAll(LINK_RE)) out.push({ target: m[1].trim(), type: typed ? typed[1] : "mentions", context: line.trim().replace(/^[-*]\s+/, "") });
  }
  return (f.rawLinks = out);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does a sentence start at `pos`: the very start of the text, or ". " / "! " / "? " (any whitespace) right before it?
 * Same answer as testing /(^|[.!?]\s+)$/ on text.slice(0, pos), without copying and rescanning the whole prefix for every
 * match (that made mentions() quadratic: 1.5 s on 64 KB of repeated names).
 */
export function startsSentence(text, pos) {
  if (pos === 0) return true;
  let i = pos;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i < pos && i > 0 && ".!?".includes(text[i - 1]);
}

export class KnowledgeGraph {
  constructor(files = []) {
    this.nodes = new Map(); // id -> node
    this.lookup = new Map(); // lowercased name/alias -> id
    this.idByPath = new Map();
    this.edges = []; // { from, to, context, broken }
    // B5: ids are file stems, unless two files share a stem (people/johnny + projects/johnny) → folder/stem
    const counts = new Map();
    for (const f of files) counts.set(stem(f.path), (counts.get(stem(f.path)) || 0) + 1);
    for (const f of files) {
      try {
        this.addNode(f, counts.get(stem(f.path)) > 1 ? f.path.replace(/\.md$/, "") : stem(f.path));
      } catch {}
    }
    for (const [key, id] of this.aliasQueue || []) if (!this.lookup.has(key)) this.lookup.set(key, id);
    this.aliasQueue = null;
    for (const f of files) {
      try {
        this.addEdges(f);
      } catch {}
    }
  }

  idOf(path) {
    return this.idByPath.get(path) || stem(path);
  }

  addNode(f, id = stem(f.path)) {
    const s = stem(f.path);
    const names = [...new Set([id, s, f.name, f.title, ...f.aliases, s.replace(/[-_]/g, " ")].filter(Boolean))];
    this.nodes.set(id, { id, path: f.path, type: f.type, title: f.title, description: f.description, names });
    this.idByPath.set(f.path, id);
    // A note's own name (file name, name, title) claims its key right away; its aliases only fill keys nobody owns, and
    // only after every note has been added (flushAliases): bob.md with alias "robert" must not take over robert.md.
    const aliasSet = new Set((f.aliases || []).map((a) => a.toLowerCase()));
    for (const n of names) {
      const key = n.toLowerCase();
      if (aliasSet.has(key) && ![id, s, f.name, f.title].filter(Boolean).some((x) => x.toLowerCase() === key)) (this.aliasQueue ||= []).push([key, id]);
      else if (!this.lookup.has(key)) this.lookup.set(key, id);
    }
  }

  /** Every note that has this name (file name, title, alias…), not just the one that won `lookup`. */
  claimants(key) {
    if (!this.nameIndex) {
      this.nameIndex = new Map();
      for (const node of this.nodes.values()) {
        for (const n of node.names) {
          const k = n.trim().toLowerCase();
          if (!this.nameIndex.has(k)) this.nameIndex.set(k, []);
          if (!this.nameIndex.get(k).includes(node.id)) this.nameIndex.get(k).push(node.id);
        }
      }
    }
    return this.nameIndex.get(key) || [];
  }

  /**
   * `visible(node)` limits resolution to notes the caller may read, so a note they can't read resolves like a name that doesn't exist: it can't
   * win a name over one they can, and it can't make a fuzzy match "ambiguous" (which would tell them it exists).
   */
  resolve(name, visible = null) {
    if (!name) return null;
    const key = name.trim().toLowerCase().replace(/\.md$/, "");
    const ok = (id) => !visible || visible(this.nodes.get(id));
    const exact = this.lookup.get(key) || this.lookup.get(key.split("/").pop());
    if (exact && ok(exact)) return exact;
    if (exact) {
      // the winner is hidden from this caller: a note they CAN read that has the same name (an alias) is still theirs to resolve to
      const seen = this.claimants(key).filter(ok);
      if (seen.length === 1) return seen[0];
    }
    // Fuzzy: a unique entity whose name contains the query as whole words ("Hersh" -> "Hersh Oberoi").
    // Through a word index: scanning every node for every unresolved link made each graph rebuild quadratic, and a vault
    // with a few thousand broken links took seconds per write.
    const words = key.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    this.wordIndex ||= this.buildWordIndex();
    let candidates = null;
    for (const w of words) {
      const ids = this.wordIndex.get(w);
      if (!ids) return null;
      candidates = candidates ? new Set([...candidates].filter((id) => ids.has(id))) : new Set(ids);
      if (!candidates.size) return null;
    }
    const hits = new Set();
    for (const id of candidates) {
      // the words must all be in ONE of the note's names, as before (the index only narrows the candidates)
      if (ok(id) && this.nodes.get(id).names.some((n) => {
        const nw = n.toLowerCase().split(/[\s_-]+/);
        return words.every((w) => nw.includes(w));
      })) hits.add(id);
    }
    return hits.size === 1 ? [...hits][0] : null;
  }

  buildWordIndex() {
    const idx = new Map();
    for (const node of this.nodes.values()) {
      for (const n of node.names) {
        for (const w of new Set(n.toLowerCase().split(/[\s_-]+/))) {
          if (!w) continue;
          if (!idx.has(w)) idx.set(w, new Set());
          idx.get(w).add(node.id);
        }
      }
    }
    return idx;
  }

  addEdges(f) {
    const from = this.idOf(f.path);
    for (const e of linksOf(f)) {
      const to = this.resolve(e.target);
      this.edges.push({ from, to: to || e.target, type: e.type, context: e.context, broken: !to });
    }
  }

  neighbors(id, depth = 1, visible = null) {
    const start = this.resolve(id, visible);
    if (!start) return null;
    const seen = new Map([[start, 0]]);
    const relations = [];
    let frontier = [start];
    for (let d = 1; d <= depth; d++) {
      const next = [];
      for (const n of frontier) {
        for (const e of this.edges) {
          if (e.broken) continue;
          let other = null;
          if (e.from === n) other = e.to;
          else if (e.to === n) other = e.from;
          if (!other) continue;
          relations.push({ from: e.from, to: e.to, type: e.type, context: e.context });
          if (!seen.has(other)) {
            seen.set(other, d);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    const uniq = [...new Map(relations.map((r) => [`${r.from}|${r.to}|${r.context}`, r])).values()];
    return {
      entity: this.nodes.get(start),
      nodes: [...seen].filter(([id]) => id !== start).map(([id, d]) => ({ ...this.nodes.get(id), distance: d })),
      relations: uniq,
    };
  }

  /**
   * Entities mentioned by name or alias in free text (for auto-linking).
   * B6: capitalised names match case-sensitively ("Mark" ≠ "mark this"), and a one-word name that is also
   *     a common word is ignored at the start of a sentence. Lowercase stems ("johnny") match any case.
   * B7: URLs, inline code and existing [[links]] are masked so nothing inside them is ever linked.
   */
  mentions(text, exclude = [], visible = null) {
    const idx = (this.nameIndex ??= this.buildNameIndex());
    const masked = maskSpans(text);
    // words (letters/digits) with positions; phrases of up to idx.maxWords consecutive words, joined only by
    // spaces, hyphens or underscores in the original text ("John Grecu", "john-grecu"; not "Mark. Lee")
    const words = [...masked.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
    const found = new Map();
    for (let i = 0; i < words.length; i++) {
      let key = "";
      for (let n = 0; n < idx.maxWords && i + n < words.length; n++) {
        if (n > 0 && !/^[\s_-]+$/.test(text.slice(words[i + n - 1].end, words[i + n].start))) break;
        const w = text.slice(words[i + n].start, words[i + n].end);
        key = n ? `${key} ${w}` : w;
        const span = text.slice(words[i].start, words[i + n].end);
        const pos = words[i].start;
        const hits = [...(idx.exact.get(key) || []), ...(idx.lower.get(key.toLowerCase()) || [])];
        for (const { id, proper, oneWordCommon } of hits) {
          if (exclude.includes(id)) continue;
          if (visible && !visible(this.nodes.get(id).path)) continue; // never reveal a note the caller can't read
          if (proper && oneWordCommon && startsSentence(text, pos)) continue; // B6
          const prev = found.get(id);
          if (!prev || span.length > prev.match.length) found.set(id, { id, match: span, pos });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.pos - b.pos);
  }

  /**
   * One hash lookup per phrase instead of one regex per name per call (was ~9 s per remember on a 5,000-note
   * vault). Capitalised names match case-sensitively (B6); lowercase names (file stems) match any case.
   */
  buildNameIndex() {
    const exact = new Map();
    const lower = new Map();
    let maxWords = 1;
    const norm = (n) => n.replace(/[\s_-]+/g, " ").trim();
    const push = (map, key, v) => {
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).some((x) => x.id === v.id)) map.get(key).push(v);
    };
    for (const node of this.nodes.values()) {
      if (["index", "core", "inbox"].includes(node.id) || node.path.startsWith("sessions/")) continue;
      for (const raw of node.names) {
        if (raw.length < 3 || raw.includes("/")) continue;
        const name = norm(raw);
        maxWords = Math.max(maxWords, name.split(" ").length);
        const proper = /\p{Lu}/u.test(name);
        const v = { id: node.id, proper, oneWordCommon: !name.includes(" ") && COMMON_WORDS.has(name.toLowerCase()) };
        if (proper) push(exact, name, v);
        else push(lower, name.toLowerCase(), v);
      }
    }
    return { exact, lower, maxWords: Math.min(maxWords, 6) };
  }

  /** Rewrites the first mention of each entity as a [[link]], by position (never inside URLs, code or links). */
  autoLink(text, exclude = [], visible = null) {
    const ms = this.mentions(text, exclude, visible).filter((m) => !text.includes(`[[${m.id}`));
    // non-overlapping, applied right to left so earlier positions stay valid
    const keep = [];
    for (const m of ms) if (!keep.some((k) => m.pos < k.pos + k.match.length && k.pos < m.pos + m.match.length)) keep.push(m);
    let out = text;
    for (const m of [...keep].sort((a, b) => b.pos - a.pos)) {
      out = `${out.slice(0, m.pos)}[[${m.id}|${m.match}]]${out.slice(m.pos + m.match.length)}`;
    }
    return { text: out, linked: keep.map((m) => m.id) };
  }

  health() {
    const degree = new Map([...this.nodes.keys()].map((k) => [k, 0]));
    for (const e of this.edges) {
      if (e.broken) continue;
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    }
    return {
      orphans: [...degree].filter(([id, d]) => d === 0 && id !== "index").map(([id]) => this.nodes.get(id).path),
      broken_links: this.edges.filter((e) => e.broken).map((e) => ({ from: e.from, target: e.to, context: e.context })),
    };
  }
}
