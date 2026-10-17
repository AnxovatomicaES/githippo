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
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = parseValue(kv[2]);
  }
  const bodyOffset = m[0].split("\n").length - 1;
  return { meta, body: content.slice(m[0].length), bodyOffset };
}

export const stem = (path) => path.split("/").pop().replace(/\.md$/, "");
export const folder = (path) => (path.includes("/") ? path.split("/")[0] : "");

/** Parses a file into entity metadata plus retrievable chunks. */
export function parseFile(path, content, { maxChars = 700 } = {}) {
  const { meta, body, bodyOffset } = parseFrontmatter(content);
  const name = meta.name || stem(path);
  const title = meta.title || name;
  const aliases = Array.isArray(meta.aliases) ? meta.aliases : meta.aliases ? [meta.aliases] : [];
  const chunks = [];
  let heading = "";
  let buf = [];
  let startLine = 0;

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) {
      const embedText = `${title}${heading ? ` › ${heading}` : ""}\n${text}`;
      chunks.push({
        id: `${path}#${chunks.length}`,
        path,
        heading,
        history: /^history$/i.test(heading),
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
    if (!buf.length) startLine = bodyOffset + i + 1;
    const len = buf.reduce((n, l) => n + l.length + 1, 0);
    if (len + line.length > maxChars && buf.length) {
      flush();
      startLine = bodyOffset + i + 1;
    }
    buf.push(line);
  });
  flush();

  if (!chunks.length && meta.description) {
    const embedText = `${title}\n${meta.description}`;
    chunks.push({ id: `${path}#0`, path, heading: "", history: false, line: 1, text: meta.description, embedText, hash: hash(embedText) });
  }
  const live = body.split(/^#{1,6}\s+history\s*$/im)[0];
  const tags = [...new Set([...live.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_-]*)/gu)].map((m) => m[1].toLowerCase()))];
  return { path, name, title, description: meta.description || "", aliases, type: meta.type || folder(path), meta, body, live, tags, chunks };
}

/** Renders [[id|Word]] as Word and [[id]] as id: the graph lives server-side, so links cost tokens for nothing. */
export const plain = (s) => s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");

export function factLines(body) {
  return body
    .split(/^#{1,6}\s+history\s*$/im)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""));
}
