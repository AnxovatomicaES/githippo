// A/B pilot, step 1: build a vault of synthetic notes, a memory dump of all of it, and a question list. The answers live in a separate file.
//   node eval/ab-setup.js --size 150 --questions 12 --seed 11 --out /tmp/ab
// Writes <out>/vault/<folder>/<note>.md (a plain folder of notes), <out>/memory.md (all notes in one file), <out>/questions.json (no answers),
// and <out>.key.json (the expected answers, outside the folder the trial runners work in).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildVault } from "./scale-context.js";

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const size = Number(arg("size", 150));
const count = Number(arg("questions", 12));
const seed = Number(arg("seed", 11));
const out = arg("out");
if (!out) throw new Error("--out is required");

// reuse the generator, then ask about facts it really planted: rare codename -> technology ("needle"), name -> what they prefer ("preference")
const { md, questions: planted } = buildVault(size, { queries: count * 2, seed });
const needles = planted.filter((q) => q.type === "needle").slice(0, Math.ceil(count / 2));
const people = Object.keys(md).filter((p) => p.startsWith("people/"));
const rng = (() => { let a = seed; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const prefs = [];
const used = new Set(needles.map((n) => n.path));
while (prefs.length < count - needles.length) {
  const p = people[Math.floor(rng() * people.length)];
  if (used.has(p)) continue;
  const m = md[p].match(/prefers (.+?) over (.+?)\n/);
  if (!m) continue;
  used.add(p);
  const title = md[p].match(/title: (.+)/)[1];
  prefs.push({ type: "preference", q: `What does ${title} prefer to use for communicating, and over what?`, expect: m[1], path: p });
}
const qs = [
  ...needles.map((n) => ({ type: "needle", q: n.q.replace("What did we decide for", "What technology did we decide to use for"), expect: n.fact.split(" for the ")[0], path: n.path })),
  ...prefs,
].map((q, i) => ({ id: `q${String(i + 1).padStart(2, "0")}`, ...q }));

for (const [p, c] of Object.entries(md)) {
  mkdirSync(dirname(join(out, "vault", p)), { recursive: true });
  writeFileSync(join(out, "vault", p), c);
}
const tokens = (s) => Math.ceil(s.length / 4);
const dump = Object.entries(md).map(([p, c]) => `## ${p}\n${c.replace(/^---[\s\S]*?---\n\n?/, "")}`).join("\n");
writeFileSync(join(out, "memory.md"), dump);
writeFileSync(join(out, "questions.json"), JSON.stringify(qs.map(({ id, q }) => ({ id, q })), null, 2));
writeFileSync(`${out}.key.json`, JSON.stringify(qs.map(({ id, type, expect, path }) => ({ id, type, expect, path })), null, 2));
console.log(JSON.stringify({ notes: size, questions: qs.length, memoryTokens: tokens(dump), out }, null, 2));
