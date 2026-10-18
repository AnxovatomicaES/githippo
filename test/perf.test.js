// Regression for quadratic regexes (an unanchored ([a-z][\w-]*):: made remember take 4-12 s on a 64 KB word;
// unclosed "[[" made salientDiffers take 11 s). Every text function × pathological 64 KB inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, redact } from "../src/guard.js";
import { injectionKinds } from "../src/injection.js";
import { tokenize } from "../src/search.js";
import { terse } from "../src/terse.js";
import { salient, salientDiffers } from "../src/brain.js";
import { stripMemoryTags, parseFile, plain } from "../src/parse.js";
import { timeWindow } from "../src/when.js";
import { KnowledgeGraph, maskSpans } from "../src/graph.js";
import { setup } from "./helpers.js";

const N = 64 * 1024;
const SHAPES = {
  word: "a".repeat(N), digits: "4".repeat(N), digitsSpaced: "41 ".repeat(N / 3), unclosedPrivate: "<private> x ".repeat(N / 12),
  openLinks: "[[a".repeat(N / 3), colons: "a::".repeat(N / 3), backticks: "`a".repeat(N / 2), fences: "```a".repeat(N / 4),
  stamps: "<!--+2026".repeat(N / 9), urls: "https://x".repeat(N / 9), dashes: "-".repeat(N), names: "Mark Lee ".repeat(N / 9),
  mixed: "Ab_cD-eF.gh/".repeat(N / 12), lt: "<".repeat(N), months: "march may ".repeat(N / 10), ibanish: "ES91".repeat(N / 4),
};
const g = new KnowledgeGraph([parseFile("people/mark-lee.md", "---\ntitle: Mark Lee\naliases: [Mark]\n---\n- x\n")]);
const FNS = {
  scan, redact, injectionKinds, tokenize, terse, salient, salientDiffers: (t) => salientDiffers(t, t.slice(1)), stripMemoryTags, plain, timeWindow,
  maskSpans, mentions: (t) => g.mentions(t), autoLink: (t) => g.autoLink(t), parseFile: (t) => parseFile("x.md", `---\nname: x\n---\n\n- ${t}\n`),
  graph: (t) => new KnowledgeGraph([parseFile("x.md", `---\nname: x\n---\n\n- ${t}\n`)]),
};

test("every text function stays fast on pathological 64 KB inputs", () => {
  const slow = [];
  for (const [f, fn] of Object.entries(FNS)) for (const [shape, input] of Object.entries(SHAPES)) {
    const t = performance.now();
    try { fn(input); } catch {}
    const ms = performance.now() - t;
    if (ms > 600) slow.push(`${f}(${shape}) ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(slow, []);
});

test("remember on a 64 KB one-word file takes milliseconds, not seconds", async () => {
  const { brain, gh } = setup();
  gh.seed("memory/topics/big.md", `---\nname: big\n---\n\n- ${"a".repeat(N - 200)}\n`);
  await brain.index.sync({ maxAgeMs: 0 });
  const t = Date.now();
  await brain.remember("A small fact about the big topic", { path: "topics/big.md" }).catch(() => {});
  assert.ok(Date.now() - t < 1500, `${Date.now() - t} ms`);
});
