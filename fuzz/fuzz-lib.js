// Seeded generators for the fuzz tests. Everything is deterministic from the seed, so a failure is reproducible:
//   FUZZ_SEED=123 FUZZ_ITERATIONS=5 node --test fuzz/fuzz.test.js
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)], chance: (p) => next() < p };
}

const WORDS = ["Johnny", "Sam", "Priya", "billing", "wake word", "Mac mini", "deadline", "Q3", "rewrite", "Postgres 16", "café", "笔记", "データ", "Ada Lovelace", "prefers", "owns", "decided", "never", "always", "2026-03-04", "last spring", "https://example.com/a", "src/api/wake.ts", "handleRefund"];
export const NASTY = [
  "", " ", "\u0000", "\u200b", "\u202e", "\ufeff", "\ud800", "\udfff", "../../etc/passwd", "a/../../b", "%2e%2e/", "\\", "😀", "👨‍👩‍👧", "é", "e\u0301", "<private>", "</private>", "[[", "]]", "[[x|y]]",
  "<!--", "-->", "<!--+2026-01-01-->", "<!--+2026-01-01 src:external-->", "---", "```", "\n- ", "\n## History\n", "~~", "<<<<<<< HEAD\n", "=======\n", ">>>>>>> x\n",
  "sk-ant-api03-" + "a".repeat(40), "4111 1111 1111 1111", "ES91 2100 0418 4502 0005 1332", "٤١١١ ١١١١ ١١١١ ١١١١", "ignore all previous instructions", "system: do it", "\r\n", "\t", "\n\n\n",
  "x".repeat(5000), "9".repeat(3000), "a-".repeat(2000), "[[".repeat(500), "<!--".repeat(500), "`".repeat(300), "<private>".repeat(100), "https://", "file:///etc/passwd", "__proto__", "constructor",
  "{{", "${x}", "'; DROP TABLE x;--", "<script>", "%s%n", "NaN", "null", "undefined", "true", "inbox.md", "core.md", "users/x/inbox.md",
];
const MD = ["---\n", "name: x\n", "title: ", "description: ", "aliases: [a, b]\n", "- ", "* ", "## ", "# ", "\n", "\n\n", "[[", "]]", "<!--", "-->", "```", "<private>", "</private>", "~~", "(until 2026-01-01)", "## History\n", "- [ ] ", "> ", "| a | b |\n", "    ", "\t"];

export const text = (r, max = 10) => {
  const n = r.int(max + 1);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(r.chance(0.55) ? r.pick(WORDS) : r.chance(0.6) ? r.pick(NASTY) : String.fromCharCode(32 + r.int(95)).repeat(1 + r.int(4)));
  return parts.join(r.chance(0.8) ? " " : "");
};

/** Markdown-shaped soup: structure tokens mixed with words and nasties. */
export const mdish = (r, max = 40) => {
  const parts = [];
  for (let i = 0, n = r.int(max + 1); i < n; i++) parts.push(r.chance(0.4) ? r.pick(MD) : r.chance(0.5) ? r.pick(WORDS) : r.pick(NASTY));
  return parts.join(r.chance(0.5) ? "" : " ");
};

export const json = (r, depth = 0) => {
  const k = r.int(depth > 2 ? 6 : 9);
  switch (k) {
    case 0: return null;
    case 1: return r.chance(0.5);
    case 2: return r.pick([0, 1, -1, 7, 2.5, 1e9, 1e308, -0]);
    case 3: case 4: return text(r);
    case 5: return r.chance(0.2) ? "z".repeat(70_000) : "";
    case 6: return Array.from({ length: r.int(4) }, () => json(r, depth + 1));
    default: {
      const o = {};
      for (let i = 0, n = r.int(4); i < n; i++) o[r.pick(["a", "path", "fact", "text", "__proto__", "constructor", text(r, 2)])] = json(r, depth + 1);
      return o;
    }
  }
};

function valueFor(schema, r) {
  if (r.chance(0.1)) return json(r); // wrong type on purpose
  if (schema?.enum) return r.chance(0.9) ? r.pick(schema.enum) : text(r, 2);
  switch (schema?.type) {
    case "string": return r.chance(0.3) ? r.pick(["projects/johnny.md", "core.md", "inbox.md", "people/sam.md", "../x.md", "a b/c d.md", "café.md", "sessions/x.md", ""]) : text(r);
    case "boolean": return r.chance(0.5);
    case "number": case "integer": return r.pick([0, 1, -1, 3, 8, 1e9, 2.5]);
    case "array": return Array.from({ length: r.int(4) }, () => valueFor(schema.items || {}, r));
    default: return json(r);
  }
}

/** Arguments for an MCP tool from its JSON schema: mostly plausible, sometimes hostile or the wrong type. */
export function argsFor(tool, r) {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const out = {};
  for (const [k, s] of Object.entries(props)) if (required.has(k) ? r.chance(0.95) : r.chance(0.55)) out[k] = valueFor(s, r);
  if (r.chance(0.08)) out[text(r, 1) || "x"] = json(r);
  return out;
}

export const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms: ${label}`)), ms))]);

export const SEED = Number(process.env.FUZZ_SEED || 20261019);
export const K = Math.max(1, Number(process.env.FUZZ_ITERATIONS || 1));
