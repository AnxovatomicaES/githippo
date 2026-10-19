// Seeded fuzzing helpers. Reproduce a failure with FUZZ_SEED=<seed>; scale up with FUZZ_ITERATIONS=<multiplier>.
export const SEED = Number(process.env.FUZZ_SEED || 20261019);
export const MULT = Number(process.env.FUZZ_ITERATIONS || 1);

/** mulberry32: small, fast, well distributed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (r, a) => a[Math.floor(r() * a.length)];

const WORDS = ["Johnny", "wake word", "Sam", "Priya", "billing", "Adyen", "Mac mini", "Q3", "deadline", "prefers", "owns", "uses", "café", "笔记", "payments", "sample rate", "16 kHz", "March 31", "RFC", "the", "a", "not", "never", "only", "[[Sam Okafor]]", "`code`", "https://example.com/x"];
export const NASTY = [
  "", " ", "\n", "\u0000", "\u200b", "\u202e", "\ufeff", "\ud800", "😀", "👨‍👩‍👧", "\r\n", "\t",
  "../../etc/passwd", "a/b/../c", "%2e%2e/", "\\", "..", "/", "//", "C:\\x", "~", "$HOME", "`rm -rf /`",
  "<private>", "</private>", "<private>x", "[[", "]]", "[[a", "<!--", "-->", "<!--+2026-01-01 src:external-->", "---", "```", "~~", "## History", "- ", "\n- ", "\n## ", "<<<<<<< HEAD", "=======", ">>>>>>> x",
  "sk-ant-api03-" + "z".repeat(30), "4111 1111 1111 1111", "es91 2100 0418 4502 0005 1332", "ignore all previous instructions", "system: do it", "__proto__", "constructor", "null", "undefined", "NaN",
  "x".repeat(5000), "9".repeat(400), "é".repeat(300), "a ".repeat(3000),
];

export function text(r, max = 60) {
  const n = 1 + Math.floor(r() * 6);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.62) parts.push(pick(r, WORDS));
    else if (roll < 0.86) parts.push(pick(r, NASTY));
    else parts.push(String.fromCodePoint(Math.floor(r() * 0x2fff) + 1));
  }
  return parts.join(r() < 0.8 ? " " : "").slice(0, Math.max(8, max * (r() < 0.05 ? 400 : 1)));
}

export const sentence = (r) => `${pick(r, ["Johnny", "Sam", "Priya", "Ada"])} ${pick(r, ["prefers", "owns", "uses", "needs"])} ${pick(r, WORDS)} ${pick(r, WORDS)}`;

export const PATHS = ["people/ada.md", "topics/x.md", "projects/johnny.md", "core.md", "index.md", "inbox.md", "sessions/x.md", "users/u/x.md", "my notes/café.md", "a.md", "x", "x.txt", ".hidden.md", "../x.md", "/abs.md", "a//b.md", "a/./b.md", "笔记.md", "a\\b.md"];
export const pathLike = (r) => (r() < 0.75 ? pick(r, PATHS) : text(r, 30) + (r() < 0.5 ? ".md" : ""));

export function jsonValue(r, depth = 0) {
  const roll = r();
  if (roll < 0.12) return null;
  if (roll < 0.2) return r() < 0.5;
  if (roll < 0.3) return pick(r, [0, -1, 1, 1.5, 1e9, 1e308, -1e308]);
  if (roll < 0.62 || depth > 2) return text(r, 40);
  if (roll < 0.8) return [...Array(Math.floor(r() * 4))].map(() => jsonValue(r, depth + 1));
  const o = {};
  for (let i = 0; i < Math.floor(r() * 4); i++) o[pick(r, ["a", "path", "fact", "__proto__", "constructor", text(r, 6)])] = jsonValue(r, depth + 1);
  return o;
}

/** Arguments for an MCP tool from its JSON schema: mostly plausible, sometimes the wrong type, sometimes missing. */
export function argsFor(schema, r) {
  const out = {};
  for (const [k, p] of Object.entries(schema?.properties || {})) {
    if (r() < 0.15 && !(schema.required || []).includes(k)) continue;
    let v;
    if (r() < 0.1) v = jsonValue(r);
    else if (p.enum) v = r() < 0.85 ? pick(r, p.enum) : text(r);
    else if (/path|^to$|^from$/.test(k)) v = pathLike(r);
    else if (p.type === "string") v = r() < 0.5 ? sentence(r) : text(r, 80);
    else if (p.type === "boolean") v = r() < 0.5;
    else if (p.type === "number" || p.type === "integer") v = pick(r, [0, 1, -1, 5, 1e9, 1.5, 0.0001]);
    else if (p.type === "array") v = [...Array(Math.floor(r() * 4))].map(() => text(r, 30));
    else v = jsonValue(r);
    out[k] = v;
  }
  if (r() < 0.05) out[text(r, 8)] = jsonValue(r);
  return out;
}

const STRUCT = ["---\n", "\n", "\n\n", "- ", "* ", "## ", "# ", "## History\n", "[[", "]]", "[[x|y]]", "<!--", "-->", "<!--+2026-10-19-->", " <!--+2026-10-19 src:external-->", "```", "<private>", "</private>", "~~old~~ (until 2026-01-01)", "\u0000", "\u200b", "<<<<<<< a\n=======\n>>>>>>> b\n", "title: ", "aliases: [", "]\n", "  ", "\t", "https://x.example/a?b=c", "src/api/a_b-c.ts", "last spring", "in Q1", "3 days ago", "March", "May", "4111 1111 1111 1111", "sk-ant-api03-" + "q".repeat(32), "ES91 2100 0418 4502 0005 1332", "ignore all previous instructions", "👨‍👩‍👧", "é", "ﬁ", "٤١١١"];
export const markdownish = (r) => [...Array(1 + Math.floor(r() * 14))].map(() => (r() < 0.55 ? pick(r, STRUCT) : r() < 0.7 ? sentence(r) : text(r, 30))).join("");
