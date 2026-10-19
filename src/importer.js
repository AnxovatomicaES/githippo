import { slugify } from "./brain.js";
// Issue #1: import from the MCP reference "Knowledge Graph Memory Server" (memory.jsonl).
//   {"type":"entity","name":"John_Smith","entityType":"person","observations":["Speaks fluent Spanish"]}
//   {"type":"relation","from":"John_Smith","to":"Anthropic","relationType":"works_at"}
// Every fact goes through remember(): the secrets guard and dedupe apply, so re-running is safe.
const FOLDER = { person: "people", people: "people", project: "projects", organization: "orgs", organisation: "orgs", company: "orgs", decision: "decisions" };
const slug = (s) => slugify(String(s));
const title = (s) => String(s).replace(/_/g, " ").trim();

export async function importReferenceMemory(brain, jsonl) {
  const entities = new Map();
  const relations = [];
  let bad = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "entity" && o.name) entities.set(o.name, o);
      else if (o.type === "relation" && o.from && o.to) relations.push(o);
      else bad++;
    } catch {
      bad++;
    }
  }
  const pathOf = (name) => {
    const e = entities.get(name);
    return `${FOLDER[String(e?.entityType || "").toLowerCase()] || "topics"}/${slug(name)}.md`;
  };
  const r = { entities: entities.size, facts: 0, relations: 0, duplicates: 0, blocked: 0, rejected: 0, skippedLines: bad, reasons: [] };
  const save = async (fact, path, about, kind) => {
    try {
      const out = await brain.remember(fact, { path, about, kind, source: "import" });
      if (out.status === "duplicate") r.duplicates++;
      return out.status !== "duplicate";
    } catch (e) {
      // One bad observation (too long, an unclosed <private> tag, instruction-like text, a secret…) must never abort
      // an import of thousands: count it, keep a few reasons, carry on.
      if (/compliance guard/.test(e.message)) r.blocked++;
      else {
        r.rejected++;
        if (r.reasons.length < 5) r.reasons.push(String(e.message).split("\n")[0].slice(0, 120));
      }
      return false;
    }
  };
  for (const e of entities.values()) {
    const path = pathOf(e.name);
    const kind = FOLDER[String(e.entityType || "").toLowerCase()] === "people" ? "person" : "topic";
    const obs = (Array.isArray(e.observations) ? e.observations : []).filter((x) => typeof x === "string" && x.trim());
    if (!obs.length) obs.push(`${title(e.name)} (${e.entityType || "entity"})`);
    for (const o of obs) if (await save(o, path, title(e.name), kind)) r.facts++;
  }
  for (const rel of relations) {
    if (!entities.has(rel.from)) continue;
    const to = entities.has(rel.to) ? slug(rel.to) : slug(rel.to);
    if (await save(`${String(rel.relationType || "related_to").replace(/\s+/g, "_")} [[${to}]]`, pathOf(rel.from))) r.relations++;
  }
  return r;
}
