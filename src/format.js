// Compact text renderers. Pretty-printed JSON costs ~30-40% more tokens than
// this for the same information, on every single tool call.
import { short } from "./store.js";

const q = (s) => `"${s}"`;

export const fmt = {
  recall(r) {
    if (r.mode === "brief") {
      return r.hits.length ? r.hits.map((h) => `${h.ref} ~${h.cost}t ${h.text}${h.via ? ` ←${h.via}` : ""}`).join("\n") : "∅ no match";
    }
    return r.context ? `${r.context}\n[~${r.tokens} tok, ${r.files} files]` : "∅ no relevant memory";
  },
  remember(r) {
    if (r.status === "duplicate") return `= already known (${r.path}): ${q(r.existing)}`;
    if (r.status === "pinned") return `📌 pinned to core (${r.core_tokens}/budget tok)`;
    if (r.status === "superseded") return `↻ ${r.path}: ${q(r.old)} → ${q(r.new)} (old kept in History)`;
    let s = `✓ ${r.path} (${r.reason})`;
    if (r.linked?.length) s += ` links:${r.linked.join(",")}`;
    for (const m of r.maybe_supersedes || []) s += `\n? may supersede ${m.path}: ${q(m.line)} → call remember with replaces if so`;
    return s;
  },
  forget: (r) => `✗ ${r.path}: ${q(r.line)} (git history keeps it)`,
  graph(r) {
    const e = r.entity;
    const lines = [`${e.id} [${e.type}]${e.description ? ` — ${e.description}` : ""}`];
    for (const rel of r.relations.slice(0, 25)) lines.push(`${rel.from} -${rel.type}→ ${rel.to}: ${rel.context.replace(/\[\[([^\[\]|]+)\|?([^\[\]]*)\]\]/g, (_, a, b) => b || a)}`);
    return lines.join("\n");
  },
  history(r) {
    if (r.kind === "as_of") {
      return r.existed ? `${r.path} as of ${r.as_of} (commit ${short(r.commit)}):\n${r.content}` : `${r.path} did not exist on ${r.as_of}`;
    }
    return r.commits.length ? `${r.path}\n${r.commits.map((c) => `${c.date.slice(0, 16)} ${short(c.commit)} ${c.message}`).join("\n")}` : `${r.path}: no history`;
  },
  checkpoint(r) {
    if (r.status === "none") return `∅ no checkpoint at ${r.path}`;
    if (r.status === "resume") return `${r.path}\n${r.checkpoint}`;
    return `✓ checkpoint ${r.path} (~${r.tokens} tok)`;
  },
  maintain(r) {
    const out = [`${r.files} files, ${r.facts} facts, core ~${r.core_tokens} tok`];
    if (r.conflicts?.length) out.push(`possible contradictions (same subject, different details):\n${r.conflicts.map((d) => `  ${d.a.path}: ${q(d.a.line)} ↔ ${d.b.path}: ${q(d.b.line)}`).join("\n")}`);
    if (r.duplicates.length) out.push(`dupes:\n${r.duplicates.map((d) => `  ${d.a.path} ≈ ${d.b.path}: ${q(d.a.line)}`).join("\n")}`);
    for (const [k, v] of [["oversized", r.oversized], ["not in index", r.missing_from_index], ["orphans", r.orphans]]) {
      if (v.length) out.push(`${k}: ${v.join(", ")}`);
    }
    if (r.broken_links.length) out.push(`broken links: ${r.broken_links.map((b) => `${b.from}→${b.target}`).join(", ")}`);
    if (r.inbox?.length) out.push(`inbox → suggested homes (maintain tidy=true to move):\n${r.inbox.slice(0, 15).map((x) => `  ${q(x.fact)} → ${x.path} (${x.why})`).join("\n")}`);
    if (r.decay && (r.decay.inbox || r.decay.sessions) && !r.actions.some((a) => /archived|removed/.test(a))) {
      out.push(`decay candidates (${r.decay.active_days}+ active days old): ${r.decay.inbox} inbox facts, ${r.decay.sessions} checkpoints → maintain decay=true`);
    }
    if (r.actions.length) out.push(`done: ${r.actions.join("; ")}`);
    if (out.length === 1) out.push("healthy");
    return out.join("\n");
  },
  list: (files) => files.map((f) => `${f.path} ${short(f.version)} ${f.size}b`).join("\n") || "∅ empty",
  read: (files) => files.map((f) => (f.missing ? `${f.path}: missing` : `=== ${f.path} v:${short(f.version)}\n${f.content}`)).join("\n"),
  write: (r) => `✓ ${r.path} v:${short(r.version)} ${r.bytes}b${r.committed === false ? " (saved; git is busy, commit follows shortly)" : ""}`,
  delete: (r) => `✗ deleted ${r.path}`,
};

export function fmtError(err) {
  let s = `ERROR: ${err.message}`;
  if (err.current) s += `\ncurrent v:${short(err.current.version)}\n${err.current.content}`;
  return s;
}
