// What does a question cost, and is the answer still found, as memory grows? A synthetic stress test, keyword mode (no model):
//   node eval/scale-context.js [--sizes 100,1000,10000] [--queries 40] [--seed 7] [--json]
//
// For each vault size it builds that many notes (people and projects, 4-8 facts each, with the overlapping vocabulary real notes have: many
// people "prefer written RFCs", many projects "decided to use Postgres") and asks two kinds of question about 40 planted facts:
//   named   "What does Sam Okafor say about the billing migration?"   the person's full name plus a topic word
//   needle  "What did we decide for the zorvakel migration?"          a rare codename plus a topic word that hundreds of notes share
// and reports what a model would actually have to read, against loading the whole memory into the context.
//
// What it does NOT show: paraphrase handling (keyword mode has none; see `githippo eval` for that), or real notes. It is a stress test of
// "does cost stay flat and does the needle stay findable as the haystack grows 100x", not a leaderboard number.
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain, approxTokens } from "../src/brain.js";
import { fmt } from "../src/format.js";

const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const FIRST = "Sam Priya Marcel Ada Jonas Lena Tariq Mei Oskar Noor Ivan Chloe Diego Aiko Felix Hana Luca Zara Pavel Ines Omar Greta Raj Sofia Ben Yuki Leo Mira Andre Tess".split(" ");
const CITY = "Lisbon Berlin Madrid Toronto Nairobi Osaka Austin Dublin Prague Lagos Oslo Lima".split(" ");
const COMM = ["written RFCs", "async updates", "short standups", "long meetings", "phone calls", "voice notes", "design docs"];
const ROLE = ["tech lead", "data lead", "product owner", "designer", "SRE", "analyst", "engineering manager"];
const TEAM = ["payments", "search", "growth", "platform", "mobile", "billing", "security"];
const LANG = ["Go", "Rust", "TypeScript", "Python", "Kotlin", "Elixir", "Java"];
const TECH = ["Postgres 16", "Kafka", "Redis", "gRPC", "Terraform", "Kubernetes", "SQLite", "GraphQL"];
const THING = ["migration", "rollout", "rewrite", "audit", "launch", "refactor", "integration"];
const WHEN = ["end of Q1", "end of Q2", "end of Q3", "mid-June", "the first week of March", "before the holidays"];
const SERVICE = ["billing", "auth", "search", "notifications", "ingest", "reporting", "checkout"];

const syllable = (r) => "bcdfghjklmnprstvz"[Math.floor(r() * 17)] + "aeiou"[Math.floor(r() * 5)];
const word = (r, n) => Array.from({ length: n }, () => syllable(r)).join("");
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** A reproducible vault of `n` notes plus the planted questions. */
export function buildVault(n, { queries = 40, seed = 7 } = {}) {
  const r = mulberry32(seed + n);
  const files = {};
  const made = [];
  const names = new Set();
  for (let i = 0; i < n; i++) {
    const person = i % 2 === 0;
    let title;
    do title = person ? `${pick(r, FIRST)} ${cap(word(r, 3))}` : `${cap(word(r, 3))} ${pick(r, ["service", "platform", "initiative"])}`;
    while (names.has(title));
    names.add(title);
    const slug = title.toLowerCase().replace(/\s+/g, "-");
    const facts = person
      ? [
          `prefers ${pick(r, COMM)} over ${pick(r, COMM)}`,
          `works from ${pick(r, CITY)}`,
          `is the ${pick(r, ROLE)} for the ${pick(r, TEAM)} team`,
          `codes mostly in ${pick(r, LANG)}`,
          `must deliver the ${pick(r, THING)} by ${pick(r, WHEN)}`,
          `owns the ${pick(r, SERVICE)} service`,
        ]
      : [
          `decided to use ${pick(r, TECH)} for the ${pick(r, THING)}`,
          `runs on ${pick(r, TECH)} and ${pick(r, TECH)}`,
          `launch is ${pick(r, WHEN)}`,
          `owned by the ${pick(r, TEAM)} team`,
          `the ${pick(r, THING)} is blocked on ${pick(r, SERVICE)}`,
        ];
    const keep = facts.slice(0, 4 + Math.floor(r() * (facts.length - 3)));
    files[`${person ? "people" : "projects"}/${slug}.md`] = { title, person, facts: keep, slug };
    made.push(files[`${person ? "people" : "projects"}/${slug}.md`]);
  }
  const questions = [];
  const chosen = new Set();
  while (questions.length < queries) {
    const i = Math.floor(r() * n);
    if (chosen.has(i)) continue;
    chosen.add(i);
    const note = made[i];
    const path = `${note.person ? "people" : "projects"}/${note.slug}.md`;
    if (questions.length % 2 === 0) {
      // named: the full name plus a topic word from a fact it really has
      const thing = pick(r, THING);
      note.facts.push(`said the ${thing} needs a second reviewer`);
      questions.push({ type: "named", q: `What does ${note.title} say about the ${thing}?`, path, fact: `the ${thing} needs a second reviewer` });
    } else {
      // needle: a rare codename plus a topic word that hundreds of other notes share
      const code = word(r, 4);
      const thing = pick(r, THING);
      const tech = pick(r, TECH);
      note.facts.push(`decided to use ${tech} for the ${code} ${thing}`);
      questions.push({ type: "needle", q: `What did we decide for the ${code} ${thing}?`, path, fact: `${tech} for the ${code} ${thing}` });
    }
  }
  const md = Object.fromEntries(
    Object.entries(files).map(([path, f]) => [path, `---\nname: ${f.slug}\ntitle: ${f.title}\ntype: ${f.person ? "person" : "project"}\n---\n\n${f.facts.map((x) => `- ${f.person ? f.title.split(" ")[0] : f.title} ${x}`).join("\n")}\n`]),
  );
  return { md, questions };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function runScale({ sizes = [100, 1000, 10000], queries = 40, seed = 7 } = {}) {
  const rows = [];
  for (const n of sizes) {
    const { md, questions } = buildVault(n, { queries, seed });
    const store = new InMemoryStore();
    for (const [p, c] of Object.entries(md)) await store.write(p, c, "new", "seed");
    const index = new MemoryIndex(store, null, {});
    const t0 = performance.now();
    await index.sync({ maxAgeMs: 0 });
    const indexMs = performance.now() - t0;
    const brain = new Brain({ store, index });
    const everything = approxTokens(Object.values(md).join("\n"));
    const stat = { named: { n: 0, pack: 0, h1: 0, h5: 0 }, needle: { n: 0, pack: 0, h1: 0, h5: 0 } };
    const packTokens = [];
    const briefTokens = [];
    const ms = [];
    for (const { type, q, path, fact } of questions) {
      const t = performance.now();
      const pack = await brain.recall(q);
      ms.push(performance.now() - t);
      const brief = await brain.recall(q, { mode: "brief" });
      packTokens.push(approxTokens(fmt.recall(pack)));
      briefTokens.push(approxTokens(fmt.recall(brief)));
      const files = [...new Set(brief.hits.map((h) => h.ref.split(":")[0]))];
      const s = stat[type];
      s.n++;
      if (pack.context.includes(fact)) s.pack++; // the fact itself reached the model
      if (files[0] === path) s.h1++;
      if (files.slice(0, 5).includes(path)) s.h5++;
    }
    rows.push({
      notes: n,
      everything_tokens: everything,
      pack_tokens_mean: Math.round(mean(packTokens)),
      brief_tokens_mean: Math.round(mean(briefTokens)),
      savings_vs_everything: +(everything / Math.max(1, mean(packTokens))).toFixed(1),
      named: { fact_in_pack: stat.named.pack / stat.named.n, hit1: stat.named.h1 / stat.named.n, hit5: stat.named.h5 / stat.named.n },
      needle: { fact_in_pack: stat.needle.pack / stat.needle.n, hit1: stat.needle.h1 / stat.needle.n, hit5: stat.needle.h5 / stat.needle.n },
      query_ms_median: Math.round(median(ms)),
      cold_index_ms: Math.round(indexMs),
    });
  }
  return rows;
}

const pct = (x) => `${Math.round(x * 100)}%`;
export function formatScale(rows) {
  const head = "| notes | loading everything | recall pack (mean) | recall brief (mean) | pack is smaller by | named: fact in pack | needle: fact in pack | needle hit@1 | query (median) | cold index |\n|---|---|---|---|---|---|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.notes.toLocaleString("en")} | ${r.everything_tokens.toLocaleString("en")} tok | ${r.pack_tokens_mean} tok | ${r.brief_tokens_mean} tok | ${r.savings_vs_everything.toLocaleString("en")}x | ${pct(r.named.fact_in_pack)} | ${pct(r.needle.fact_in_pack)} | ${pct(r.needle.hit1)} | ${r.query_ms_median} ms | ${r.cold_index_ms.toLocaleString("en")} ms |`)
    .join("\n");
  return `${head}\n${body}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, d) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const rows = await runScale({ sizes: arg("sizes", "100,1000,10000").split(",").map(Number), queries: Number(arg("queries", 40)), seed: Number(arg("seed", 7)) });
  console.log(process.argv.includes("--json") ? JSON.stringify(rows, null, 2) : formatScale(rows));
}
