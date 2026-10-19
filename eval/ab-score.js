// A/B pilot, last step: score the answers the trial runners wrote.
//   node eval/ab-score.js <out>      reads <out>/answers/<arm>-<qid>.txt, <out>.key.json and (optionally) <out>/usage.json
// An answer is right when it contains the expected phrase (case-insensitive). usage.json: {"<arm>-<qid>": {"tokens": n, "tools": n}}.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
const key = JSON.parse(readFileSync(`${out}.key.json`, "utf8"));
const usage = existsSync(join(out, "usage.json")) ? JSON.parse(readFileSync(join(out, "usage.json"), "utf8")) : {};
const files = existsSync(join(out, "answers")) ? readdirSync(join(out, "answers")) : [];
const arms = [...new Set(files.map((f) => f.split("-")[0]))].sort();

// Wilson 95% interval for a proportion
const wilson = (k, n) => {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
};
const rows = [];
const right = {};
for (const arm of arms) {
  let k = 0, n = 0, tok = 0, tools = 0, withUsage = 0;
  for (const q of key) {
    const f = join(out, "answers", `${arm}-${q.id}.txt`);
    if (!existsSync(f)) continue;
    n++;
    const ok = readFileSync(f, "utf8").toLowerCase().includes(q.expect.toLowerCase());
    (right[arm] ||= {})[q.id] = ok;
    if (ok) k++;
    const u = usage[`${arm}-${q.id}`];
    if (u) { tok += u.tokens; tools += u.tools; withUsage++; }
  }
  const [lo, hi] = wilson(k, n);
  rows.push({ arm, correct: `${k}/${n}`, accuracy: `${Math.round((k / Math.max(1, n)) * 100)}% (${Math.round(lo * 100)}-${Math.round(hi * 100)}%)`, meanTokens: withUsage ? Math.round(tok / withUsage) : "-", meanToolCalls: withUsage ? +(tools / withUsage).toFixed(1) : "-" });
}
console.log("| arm | correct | accuracy (95% interval) | mean tokens per question | mean tool calls |\n|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.arm} | ${r.correct} | ${r.accuracy} | ${r.meanTokens} | ${r.meanToolCalls} |`);
const missed = key.filter((q) => arms.some((a) => right[a]?.[q.id] === false)).map((q) => `${q.id}(${q.type}): ${arms.filter((a) => right[a]?.[q.id] === false).join(",")}`);
if (missed.length) console.log(`\nmisses by question: ${missed.join("  ")}`);
