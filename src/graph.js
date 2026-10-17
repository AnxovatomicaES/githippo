// Knowledge graph over memory files: entities are files, edges are [[links]].
import { stem } from "./parse.js";

const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class KnowledgeGraph {
  constructor(files = []) {
    this.nodes = new Map(); // id -> node
    this.lookup = new Map(); // lowercased name/alias -> id
    this.edges = []; // { from, to, context, broken }
    for (const f of files) this.addNode(f);
    for (const f of files) this.addEdges(f);
  }

  addNode(f) {
    const id = stem(f.path);
    const names = [id, f.name, f.title, ...f.aliases, id.replace(/[-_]/g, " ")].filter(Boolean);
    this.nodes.set(id, { id, path: f.path, type: f.type, title: f.title, description: f.description, names });
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
    const from = stem(f.path);
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

  /** Entities mentioned by name or alias in free text (for auto-linking). */
  mentions(text, exclude = []) {
    const found = new Map();
    for (const node of this.nodes.values()) {
      if (exclude.includes(node.id) || ["index", "core", "inbox"].includes(node.id) || node.path.startsWith("sessions/")) continue;
      for (const name of node.names) {
        if (name.length < 3) continue;
        const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[])(${escapeRe(name)})(?=$|[^\\p{L}\\p{N}\\]])`, "iu");
        const m = text.match(re);
        if (m) {
          const pos = m.index + m[1].length;
          const prev = found.get(node.id);
          if (!prev || m[2].length > prev.match.length) found.set(node.id, { id: node.id, match: m[2], pos });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.pos - b.pos);
  }

  /** Rewrites the first mention of each entity as a [[link]]. */
  autoLink(text, exclude = []) {
    let out = text;
    const linked = [];
    for (const { id, match } of this.mentions(text, exclude)) {
      if (out.includes(`[[${id}`)) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[])(${escapeRe(match)})(?=$|[^\\p{L}\\p{N}\\]])`, "u");
      const next = out.replace(re, (_, pre, word) => `${pre}[[${id}|${word}]]`);
      if (next !== out) {
        out = next;
        linked.push(id);
      }
    }
    return { text: out, linked };
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
