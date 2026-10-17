// Optional terse rendering of recalled memory (MEMORY_STYLE=terse). Idea and rules from caveman
// (https://github.com/JuliusBrussee/caveman), kept to the safe subset: it only deletes padding, never rewrites.
// Applied to what's handed to the model, never to the files on disk. Deterministic, no LLM.
// Never touched: code, inline code, URLs, paths, [[links]], numbers and units, names, and every negation
// or limiter (not, no, never, only, without, except). Off by default: caveman's own cited research found that
// compressing prose a model reads can hurt answers, and on githippo's already-terse memory it saves 3-13%.
const PROTECT = /```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|(?<![\p{L}\p{N}])[.~]?\/[\w./-]+|\[\[[^\]]*\]\]/gu;
// A word only counts as standalone if nothing that joins tokens touches it ("A/B", "a.m.", "the_var", "x@a").
const W = (words) => new RegExp(`(?<![\\p{L}\\p{N}'’\\-/._@&:])(?:${words})(?![\\p{L}\\p{N}'’\\-/._@&:])\\s*`, "giu");

// Pure padding: deleting it can't change what a sentence asserts.
const PADDING = [
  [/(?<![\p{L}])(?:it is|it's) important to note that\s*/giu, ""],
  [/(?<![\p{L}])please note that\s*/giu, ""],
  [/(?<![\p{L}])in order to(?![\p{L}])/giu, "to"],
  [/(?<![\p{L}])due to the fact that(?![\p{L}])/giu, "because"],
  [W("a|an|the"), ""],
  [W("just|really|basically|actually|simply|essentially|generally|quite|very"), ""],
];

export function terse(text) {
  if (!text) return text;
  const kept = [];
  let s = text.replace(PROTECT, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  s = s
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*(?:[-*]|\d+\.)\s+|#+\s+|§\s+)?(.*)$/);
      let body = m[2];
      for (const [re, to] of PADDING) body = body.replace(re, to);
      body = body.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
      if (m[1] && !/^§/.test(m[1]) && body) body = body[0].toUpperCase() + body.slice(1);
      return (m[1] || "") + body;
    })
    .join("\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[+i]);
}
