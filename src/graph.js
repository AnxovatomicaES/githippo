// Knowledge graph over memory files: entities are files, edges are [[links]].
import { stem } from "./parse.js";

const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
// One-word first names that are also everyday words (B6).
const COMMON_WORDS = new Set("will mark may bill grace hope rose frank april june august max jack art sky page rich dawn pat sue ray joy faith amber summer ivy hunter chase drew wade gene earl iris lily violet sage river skye angel king prince major".split(" "));

/** Replaces URLs, `code` and [[links]] with spaces of the same length, so positions stay aligned (B7). */
export function maskSpans(text) {
  return text.replace(/https?:\/\/\S+|www\.\S+|`[^`]*`|\[\[[^\]]*\]\]/g, (m) => " ".repeat(m.length));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class KnowledgeGraph {
  constructor(files = []) {
    this.nodes = new Map(); // id -> node
    this.lookup = new Map(); // lowercased name/alias -> id
    this.idByPath = new Map();
    this.edges = []; // { from, to, context, broken }
    // B5: ids are file stems, unless two files share a stem (people/johnny + projects/johnny) → folder/stem
    const counts = new Map();
    for (const f of files) counts.set(stem(f.path), (counts.get(stem(f.path)) || 0) + 1);
    for (const f of files) this.addNode(f, counts.get(stem(f.path)) > 1 ? f.path.replace(/\.md$/, "") : stem(f.path));
    for (const f of files) this.addEdges(f);
  }

  idOf(path) {
    return this.idByPath.get(path) || stem(path);
  }

  addNode(f, id = stem(f.path)) {
    const s = stem(f.path);
    const names = [...new Set([id, s, f.name, f.title, ...f.aliases, s.replace(/[-_]/g, " ")].filter(Boolean))];
    this.nodes.set(id, { id, path: f.path, type: f.type, title: f.title, description: f.description, names });
    this.idByPath.set(f.path, id);
    for (const n of names) if (!this.lookup.has(n.toLowerCase())) this.lookup.set(n.toLowerCase(), id);
  }

  resolve(name) {
    if (!name) return null;
    const key = name.trim().toLowerCase().replace(/\.md$/, "");
    const exact = this.lookup.get(key) || this.lookup.get(key.split("/").pop());
    if (exact) return exact;
    // Fuzzy: a unique entity whose name contains the query as whole words ("Hersh" -> "Hersh Oberoi").
    const words = key.split(/\s+/).filter(Boolean);
    const hits = new Set();
    for (const node of this.nodes.values()) {
      for (const n of node.names) {
        const nw = n.toLowerCase().split(/[\s_-]+/);
        if (words.every((w) => nw.includes(w))) hits.add(node.id);
      }
    }
    return hits.size === 1 ? [...hits][0] : null;
  }

  addEdges(f) {
    const from = this.idOf(f.path);
    for (const line of (f.live ?? f.body).split("\n")) {
      // Typed relations, Basic Memory / Dataview style: "- works_on [[x]]" or "owner:: [[x]]".
      const typed = line.match(/^\s*[-*]\s+([a-z][\w-]*)\s+\[\[/) || line.match(/([a-z][\w-]*)::\s*\[\[/);
      for (const m of line.matchAll(LINK_RE)) {
        const to = this.resolve(m[1]);
        this.edges.push({
          from,
          to: to || m[1].trim(),
          type: typed ? typed[1] : "mentions",
          context: line.trim().replace(/^[-*]\s+/, ""),
          broken: !to,
        });
      }
    }
  }

  neighbors(id, depth = 1) {
    const start = this.resolve(id);
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
  mentions(text, exclude = []) {
    const masked = maskSpans(text);
    const found = new Map();
    for (const node of this.nodes.values()) {
      if (exclude.includes(node.id) || ["index", "core", "inbox"].includes(node.id) || node.path.startsWith("sessions/")) continue;
      for (const name of node.names) {
        if (name.length < 3 || name.includes("/")) continue;
        const proper = /\p{Lu}/u.test(name);
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(name)})(?=$|[^\\p{L}\\p{N}])`, proper ? "gu" : "giu");
        for (const m of masked.matchAll(re)) {
          const pos = m.index + m[1].length;
          const word = text.slice(pos, pos + m[2].length);
          const atSentenceStart = /(^|[.!?]\s+)$/.test(text.slice(0, pos));
          if (proper && !name.includes(" ") && COMMON_WORDS.has(name.toLowerCase()) && atSentenceStart) continue;
          const prev = found.get(node.id);
          if (!prev || word.length > prev.match.length) found.set(node.id, { id: node.id, match: word, pos });
          break;
        }
      }
    }
    return [...found.values()].sort((a, b) => a.pos - b.pos);
  }

  /** Rewrites the first mention of each entity as a [[link]], by position (never inside URLs, code or links). */
  autoLink(text, exclude = []) {
    const ms = this.mentions(text, exclude).filter((m) => !text.includes(`[[${m.id}`));
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
