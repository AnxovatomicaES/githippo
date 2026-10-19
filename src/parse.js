// Markdown memory files: a small YAML-ish frontmatter block plus a body of
// bullet lines grouped under optional headings.
import { createHash } from "node:crypto";

export const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return v.replace(/^["']|["']$/g, "");
}

export function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: content, bodyOffset: 0 };
  const meta = {};
  for (const line of m[1].split("\n").slice(0, 200)) {
    const kv = line.match(/^([A-Za-z_][\w-]{0,40}):\s*(.{0,2000})$/);
    // __proto__ / constructor / prototype would rewrite the object's prototype; they're not metadata
    if (kv && !["__proto__", "constructor", "prototype"].includes(kv[1])) meta[kv[1]] = parseValue(kv[2]);
  }
  const bodyOffset = m[0].split("\n").length - 1;
  return { meta, body: content.slice(m[0].length), bodyOffset };
}

export const stem = (path) => path.split("/").pop().replace(/\.md$/, "");
export const folder = (path) => (path.includes("/") ? path.split("/")[0] : "");

/** Parses a file into entity metadata plus retrievable chunks. */
/** "- ~~old fact~~ (until 2026-01-01)": a superseded record is history even if it ended up outside the History section. */
export const isSuperseded = (line) => /^\s*[-*]\s+~~.+~~\s*\(until \d{4}-\d{2}-\d{2}\)\s*$/.test(line);

export function parseFile(path, content, { maxChars = 700 } = {}) {
  content = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"); // a BOM (some Windows editors) hid the frontmatter; B2: Windows line endings
  const { meta, body, bodyOffset } = parseFrontmatter(content);
  // frontmatter is user-editable: any field can arrive as a list, empty, or huge. Coerce to short strings here, once,
  // so nothing downstream ever sees an array where it expects text ("title: []" used to break every recall).
  const text = (v) => (Array.isArray(v) ? v.map(String).join(", ") : v == null ? "" : String(v)).slice(0, 300);
  const name = text(meta.name) || stem(path);
  const title = text(meta.title) || name;
  const description = text(meta.description);
  const aliases = (Array.isArray(meta.aliases) ? meta.aliases : meta.aliases ? [meta.aliases] : []).map(text).filter(Boolean).slice(0, 30);
  const chunks = [];
  let heading = "";
  let buf = [];
  let startLine = 0;

  const flush = () => {
    const inHistory = /^(history|archived)$/i.test(heading);
    const raw = (inHistory ? buf : buf.filter((l) => !isSuperseded(l))).join("\n");
    // dates the chunk's facts were written (hidden stamps) or stopped being true (History "until")
    const dates = [...raw.matchAll(/<!--\+(\d{4}-\d{2}-\d{2})(?: src:\w+)?-->|\(until (\d{4}-\d{2}-\d{2})\)/g)].map((m) => m[1] || m[2]);
    // facts that came from web pages, files or tool output are marked so Claude treats them as data
    const text = raw
      .split("\n")
      .map((l) => (/<!--\+\S+ src:external-->/.test(l) ? l.replace(/^(\s*[-*]\s+)/, "$1[external] ") : l))
      .join("\n")
      .replace(/\s*<!--[^]{0,300}?-->/g, "")
      .trim();
    if (text) {
      // The description is the file's best semantic summary ("Johnny" means nothing to a model; "Voice assistant for the Mac" does).
      const embedText = `${title}${description && description !== title ? ` — ${description}` : ""}${heading ? ` › ${heading}` : ""}\n${text}`;
      chunks.push({
        id: `${path}#${chunks.length}`,
        path,
        heading,
        history: /^(history|archived)$/i.test(heading),
        dates,
        line: startLine,
        text,
        embedText,
        hash: hash(embedText),
      });
    }
    buf = [];
  };

  body.split("\n").forEach((line, i) => {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1].trim();
      return;
    }
    if (!buf.length) {
      if (!line.trim()) return; // B1: a chunk's ref must point at content, not a blank line
      startLine = bodyOffset + i + 1;
    }
    const len = buf.reduce((n, l) => n + l.length + 1, 0);
    if (len + line.length > maxChars && buf.length) {
      flush();
      startLine = bodyOffset + i + 1;
    }
    buf.push(line);
  });
  flush();

  if (!chunks.length && description) {
    const embedText = `${title}\n${description}`;
    chunks.push({ id: `${path}#0`, path, heading: "", history: false, line: 1, text: description, embedText, hash: hash(embedText) });
  }
  const live = body.split(/^#{1,6}\s+(?:history|archived)\s*$/im)[0].split("\n").filter((l) => !isSuperseded(l)).join("\n");
  const tags = [...new Set([...live.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_-]*)/gu)].map((m) => m[1].toLowerCase()))];
  return { path, name, title, description, aliases, type: text(meta.type) || folder(path), meta, body, live, tags, chunks };
}

/** Renders [[id|Word]] as Word and [[id]] as id: the graph lives server-side, so links cost tokens for nothing. */
// bounded/linear patterns only: stamps are short, link contents exclude "["
export const plain = (s) => s.replace(/\s*<!--[^]{0,300}?-->/g, "").replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g, "$2").replace(/\[\[([^\[\]]+)\]\]/g, "$1");

export function factLines(body) {
  return body
    .split(/^#{1,6}\s+(?:history|archived)\s*$/im)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l) && !isSuperseded(l))
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

// Tags whose content must never be stored (idea from claude-mem):
//  <private>…</private>          user opt-out for sensitive text
//  <githippo-context>…</…>      what our own hooks injected (prevents re-saving memory as new memory)
//  <system-reminder>…</…>       harness-injected text
/** Control characters (NUL, bell…) never belong in memory text; tab and newline stay. */
export const cleanControl = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

const MEMORY_TAGS = ["private", "githippo-context", "system-reminder"];

/** Removes balanced memory-tag blocks (nested ok). An unclosed "<private>" in ordinary prose is left alone. */
export function stripMemoryTags(input) {
  if (!input || !input.includes("<")) return { text: input || "", removed: 0, unclosed: false };
  let text = input;
  let removed = 0;
  let unclosed = false;
  for (const tag of MEMORY_TAGS) {
    // Depth-counting scan, one tag name at a time. Everything inside an open tag is dropped, nested tags included.
    // A closing tag with nothing open is just removed. An opener that never closes makes everything after it
    // private: content the user marked private must never survive because they forgot (or an attacker omitted) the closer.
    const re = new RegExp(`<(\\/?)${tag}(?:\\s[^>]*)?>`, "gi");
    let out = "";
    let last = 0;
    let depth = 0;
    let found = false;
    for (const m of text.matchAll(re)) {
      found = true;
      if (depth === 0) out += text.slice(last, m.index);
      if (m[1] !== "/") {
        if (depth === 0) removed++;
        depth++;
      } else if (depth > 0) depth--;
      last = m.index + m[0].length;
    }
    if (!found) continue;
    if (depth === 0) out += text.slice(last);
    else unclosed = true;
    text = out;
  }
  return { text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), removed, unclosed };
}

export const wrapContext = (s) => (s ? `<githippo-context>\n${s}\n</githippo-context>` : s);

/** Hidden creation stamp on a fact line: invisible in Obsidian, stripped before recall and embedding. */
export const stamp = (date = new Date().toISOString().slice(0, 10), source = null) => ` <!--+${date}${source ? ` src:${source}` : ""}-->`;
export const stampOf = (line) => line.match(/<!--\+(\d{4}-\d{2}-\d{2})(?: src:\w+)?-->/)?.[1] || null;
export const sourceOf = (line) => line.match(/<!--\+\d{4}-\d{2}-\d{2} src:(\w+)-->/)?.[1] || null;
