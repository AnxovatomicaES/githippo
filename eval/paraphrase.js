// Paraphrase benchmark: can recall find a note when the question shares no content words with it?
//   node eval/paraphrase.js [--embeddings none|local|static|voyage|hash] [--model <hf id>] [--set <file>] [--json]
//   node eval/paraphrase.js --merge a.json b.json … --out eval/paraphrase-set.json     (build the set from generated domain files)
// The set (eval/paraphrase-set.json) is notes plus queries. Every English query was checked by `violations()`: after stemming it has no
// content word in common with its note except the entity's own name, so keyword search has nothing to match on and only meaning can find
// the note. Spanish queries ask about the same notes across languages. Reports hit@1, hit@5 and MRR over the files recall returns.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { createEmbedder } from "../src/embed.js";
import { Brain } from "../src/brain.js";

export const DEFAULT_SET = fileURLToPath(new URL("./paraphrase-set.json", import.meta.url));

const slug = (path) => path.replace(/^.*\//, "").replace(/\.md$/, "");
const noteText = (n) => `---\nname: ${slug(n.path)}\ntitle: ${n.title}\ndescription: ${n.description}\naliases: [${(n.aliases || []).join(", ")}]\n---\n\n${n.facts.map((f) => `- ${f}`).join("\n")}\n`;

// Words that name no topic (pronouns, auxiliaries, prepositions, conjunctions, quantifiers). Sharing "before" or "can" with a note is not a lexical
// clue, so it doesn't make a paraphrase impure; the search's own stop list is shorter than this one.
const FUNCTION_WORDS = new Set(
  "a about above across after again against all along also although always among an and any are around as at away be because been before being below between both but by can could did do does doing done down during each either else even ever every few for from get gets got had has have having he her here hers him his how however i if in into is it its just may me might more most much must my need needs never no nor not now of off often on once only onto or other our ours out over own per quite rather same shall she should since so some still such than that the their them then there these they this those though through thus to too under until up upon us very was we were what when where whether which while who whom whose why will with within without would yet you your yours".split(" "),
);

/** A light English stem, stricter than the search's own: "rotated", "rotates", "rotation" and "rotate" meet. Only used to judge the data, never to rank. */
const loose = (w) => {
  let s = w.toLowerCase().replace(/'s$/, "");
  for (const [re, rep] of [[/ations?$/, "at"], [/ies$/, "y"], [/(ings?|ments?|ions?|ness|ers?|ed|es|s|ly)$/, ""]]) {
    if (!re.test(s)) continue;
    const t = s.replace(re, rep);
    if (t.length >= 3) s = t;
    break;
  }
  return s.replace(/e$/, "");
};
const words = (text) => (String(text).toLowerCase().match(/[a-z0-9]+(?:'s)?/g) || []).map((w) => w.replace(/'s$/, ""));

/** English query words that also occur in the note, other than words of the entity's name (title, aliases) and function words: what a keyword search could match. */
export function violations(query, note) {
  const own = new Set([note.title, ...(note.aliases || [])].flatMap(words).map(loose));
  const body = new Set([note.title, note.description, ...(note.aliases || []), ...note.facts].flatMap(words).map(loose));
  return [...new Set(words(query).filter((w) => !FUNCTION_WORDS.has(w)).map(loose))].filter((t) => t.length >= 3 && body.has(t) && !own.has(t));
}

/** Builds one set from generated domain files; drops English queries that share words with their note. Returns the set and what was dropped. */
export function merge(files, { provenance = "" } = {}) {
  const notes = [];
  const dropped = [];
  const seen = new Set();
  for (const file of files) {
    const d = JSON.parse(readFileSync(file, "utf8"));
    for (const n of d.notes) {
      if (seen.has(n.path) || !n.facts?.length || !n.queries?.length) {
        dropped.push({ path: n.path, why: "duplicate path or empty" });
        continue;
      }
      seen.add(n.path);
      const queries = [];
      for (const q of n.queries) {
        const v = q.lang === "en" ? violations(q.text, n) : [];
        if (v.length) dropped.push({ path: n.path, id: q.id, text: q.text, shared: v });
        else queries.push({ id: q.id, lang: q.lang, text: q.text });
      }
      notes.push({ domain: d.domain, path: n.path, title: n.title, description: n.description, aliases: n.aliases || [], facts: n.facts, queries });
    }
  }
  return { set: { provenance, notes }, dropped };
}

async function build(set, embedder) {
  const store = new InMemoryStore();
  for (const [p, c] of Object.entries({ "index.md": "---\nname: index\n---\n\n", "inbox.md": "---\nname: inbox\ntitle: Inbox\ntype: inbox\n---\n\n" })) await store.write(p, c, "new", "seed");
  for (const n of set.notes) await store.write(n.path, noteText(n), "new", "seed");
  const brain = new Brain({ store, index: new MemoryIndex(store, embedder, {}) });
  await brain.index.sync({ maxAgeMs: 0 });
  return brain;
}

export async function runParaphrase({ embeddings = "none", model, set, quiet = true } = {}) {
  set ??= JSON.parse(readFileSync(DEFAULT_SET, "utf8"));
  const env = { ...process.env, EMBEDDINGS: embeddings, ...(model ? { LOCAL_EMBED_MODEL: model, STATIC_EMBED_MODEL: model } : {}) };
  const embedder = createEmbedder(env);
  const t0 = Date.now();
  const brain = await build(set, embedder);
  const byKey = {};
  const misses = [];
  const bump = (key, rank) => {
    const m = (byKey[key] ??= { n: 0, h1: 0, h5: 0, rr: 0 });
    m.n++;
    if (rank === 1) m.h1++;
    if (rank && rank <= 5) m.h5++;
    if (rank) m.rr += 1 / rank;
  };
  for (const n of set.notes) {
    for (const q of n.queries) {
      const r = await brain.recall(q.text, { mode: "brief" });
      const files = [...new Set(r.hits.map((h) => h.ref.split(":")[0]))];
      const rank = files.indexOf(n.path) + 1;
      for (const key of ["all", `lang:${q.lang}`, `domain:${n.domain}`]) bump(key, rank);
      if (rank !== 1) misses.push({ q: q.text, want: n.path, got: files.slice(0, 3), rank: rank || null });
    }
  }
  const pct = (a, b) => Math.round((1000 * a) / b) / 10;
  const sum = (m) => ({ n: m.n, hit1: pct(m.h1, m.n), hit5: pct(m.h5, m.n), mrr: Math.round((1000 * m.rr) / m.n) / 1000 });
  return {
    embeddings: embedder?.id || "none (keyword + graph)",
    notes: set.notes.length,
    summary: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, sum(v)])),
    ms: Date.now() - t0,
    misses,
  };
}

export function formatParaphrase(r) {
  const row = (k) => `| ${k} | ${r.summary[k].n} | ${r.summary[k].hit1}% | ${r.summary[k].hit5}% | ${r.summary[k].mrr} |`;
  const keys = Object.keys(r.summary);
  return [`paraphrase benchmark · ${r.embeddings} · ${r.notes} notes · ${r.ms} ms`, "", "| queries | n | hit@1 | hit@5 | MRR |", "|---|---|---|---|---|", ...keys.filter((k) => k === "all" || k.startsWith("lang:")).map(row), ...keys.filter((k) => k.startsWith("domain:")).map(row)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  if (argv.includes("--merge")) {
    const files = argv.slice(argv.indexOf("--merge") + 1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--out");
    const { set, dropped } = merge(files, { provenance: "Notes and queries written by Claude Sonnet 5.5 subagents (one domain each); English queries kept only if they share no content word with their note (see violations())." });
    writeFileSync(flag("out") || DEFAULT_SET, JSON.stringify(set, null, 1) + "\n");
    console.log(`${set.notes.length} notes, ${set.notes.reduce((s, n) => s + n.queries.length, 0)} queries kept, ${dropped.length} dropped`);
    for (const d of dropped) console.log(" dropped:", JSON.stringify(d));
  } else {
    const set = flag("set") ? JSON.parse(readFileSync(flag("set"), "utf8")) : undefined;
    const r = await runParaphrase({ embeddings: flag("embeddings") || "none", model: flag("model"), set });
    console.log(argv.includes("--json") ? JSON.stringify(r, null, 1) : formatParaphrase(r));
    process.exit(0); // the embedding worker keeps the loop alive otherwise
  }
}
