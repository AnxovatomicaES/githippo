// githippo as the storage behind Anthropic's native memory tool ({"type":"memory_20250818","name":"memory"}).
// Implements view / create / str_replace / insert / delete / rename with the reference return strings
// (https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool). /memories maps onto the vault,
// so API agents share memory with Claude Code and Desktop; every write is a git commit, indexed for recall,
// and checked by the secrets guard. Files Claude names notes.txt are stored as notes.txt.md (indexable,
// visible in Obsidian) and shown back as notes.txt.
import { assertSafe } from "./brain.js";
import { MemoryError } from "./store.js";

const ROOT = "/memories";
const MAX_VIEW_CHARS = 16_000;

export class MemoryToolError extends Error {}

/** /memories/a/b.txt → "a/b.txt" ("" for the root). Rejects anything that could escape the root. */
export function toRel(raw) {
  let p = String(raw ?? "");
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(p); i++) {
    try {
      p = decodeURIComponent(p);
    } catch {
      break;
    }
  }
  if (p.includes("\\") || p.includes("\0")) throw new MemoryToolError(`Error: Invalid path ${raw}`);
  if (p !== ROOT && !p.startsWith(`${ROOT}/`)) throw new MemoryToolError(`Error: Paths must start with ${ROOT}`);
  const segs = p.slice(ROOT.length).split("/").filter(Boolean);
  if (segs.some((s) => s === ".." || s === "." || s.startsWith("."))) throw new MemoryToolError(`Error: Invalid path ${raw}`);
  if (segs.some((s) => !/^[\p{L}\p{N}\p{M} ._@()+,&'-]+$/u.test(s))) throw new MemoryToolError(`Error: Invalid characters in path ${raw}`);
  return segs.join("/");
}

const storeName = (rel) => (rel.endsWith(".md") ? rel : `${rel}.md`);
const shownName = (stored) => (/\.[a-z0-9]+\.md$/i.test(stored) ? stored.slice(0, -3) : stored);
const human = (n) => (n < 1024 ? `${n}B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1024 ** 2).toFixed(1)}M`);
const numbered = (text, start = 1) => text.split("\n").map((l, i) => `${String(i + start).padStart(6)}\t${l}`).join("\n");

export function createMemoryTool(brain) {
  const store = brain.store;
  const index = brain.index;
  const findFile = async (rel) => (rel ? await store.read(storeName(rel)).catch(() => null) : null);
  const listUnder = async (rel) => (await store.list(rel ? `${rel}/` : "")).filter((f) => !rel || f.path.startsWith(`${rel}/`));
  const write = async (rel, content, version, op) => {
    try {
      assertSafe(content);
    } catch (e) {
      throw new MemoryToolError(`Error: ${e.message}`);
    }
    const r = await store.write(storeName(rel), content, version, op);
    await index.upsert(r.path, content, r.version);
    return r;
  };

  async function run(input = {}) {
    const cmd = input.command;
    if (cmd === "view") {
      const rel = toRel(input.path);
      const file = await findFile(rel);
      if (file) {
        const lines = file.content.replace(/\n$/, "").split("\n");
        if (lines.length > 999_999) throw new MemoryToolError(`File ${input.path} exceeds maximum line limit of 999,999 lines.`);
        let [a, b] = Array.isArray(input.view_range) ? input.view_range : [1, lines.length];
        if (b === -1) b = lines.length;
        let body = numbered(lines.slice(a - 1, b).join("\n"), a);
        if (body.length > MAX_VIEW_CHARS) body = `${body.slice(0, MAX_VIEW_CHARS)}\n… (truncated; use view_range to see more)`;
        return `Here's the content of ${input.path} with line numbers:\n${body}`;
      }
      const files = await listUnder(rel);
      if (rel && !files.length) throw new MemoryToolError(`The path ${input.path} does not exist. Please provide a valid path.`);
      const base = rel ? `${ROOT}/${rel}` : ROOT;
      const depth = (p) => p.slice(rel ? rel.length + 1 : 0).split("/").length;
      const rows = [`${human(files.reduce((n, f) => n + (f.size || 0), 0))}\t${base}`];
      const dirs = new Set();
      for (const f of files) {
        const inner = f.path.slice(rel ? rel.length + 1 : 0);
        const top = inner.split("/");
        if (top.length > 1) dirs.add(top[0]);
        if (depth(f.path) <= 2) rows.push(`${human(f.size || 0)}\t${base}/${shownName(inner)}`);
      }
      for (const d of dirs) if (!rows.some((r) => r.endsWith(`\t${base}/${d}`))) rows.push(`${human(files.filter((f) => f.path.startsWith(`${rel ? `${rel}/` : ""}${d}/`)).reduce((n, f) => n + (f.size || 0), 0))}\t${base}/${d}`);
      rows.splice(1, rows.length - 1, ...rows.slice(1).sort((x, y) => x.split("\t")[1].localeCompare(y.split("\t")[1])));
      return `Here're the files and directories up to 2 levels deep in ${base}, excluding hidden items and node_modules:\n${rows.join("\n")}`;
    }
    if (cmd === "create") {
      const rel = toRel(input.path);
      if (!rel) throw new MemoryToolError(`Error: Cannot create ${ROOT} itself`);
      const existing = await findFile(rel);
      // reference behavior is an error; the docs allow overwriting, and Claude's tool description says "creates or overwrites"
      await write(rel, String(input.file_text ?? ""), existing ? existing.version : "new", existing ? "memory-tool overwrite" : "memory-tool create");
      return `File created successfully at: ${input.path}`;
    }
    if (cmd === "str_replace") {
      const rel = toRel(input.path);
      const file = await findFile(rel);
      if (!file) throw new MemoryToolError(`Error: The path ${input.path} does not exist. Please provide a valid path.`);
      const old = String(input.old_str ?? "");
      const parts = file.content.split(old);
      if (!old || parts.length === 1) throw new MemoryToolError(`No replacement was performed, old_str \`${old}\` did not appear verbatim in ${input.path}.`);
      if (parts.length > 2) {
        const lines = file.content.split("\n").map((l, i) => (l.includes(old) ? i + 1 : 0)).filter(Boolean);
        throw new MemoryToolError(`No replacement was performed. Multiple occurrences of old_str \`${old}\` in lines: ${lines.join(", ")}. Please ensure it is unique`);
      }
      const next = parts.join(String(input.new_str ?? ""));
      await write(rel, next, file.version, "memory-tool edit");
      const at = next.slice(0, next.indexOf(String(input.new_str ?? "")) >= 0 ? next.indexOf(String(input.new_str ?? "")) : 0).split("\n").length;
      const lines = next.split("\n");
      const from = Math.max(1, at - 2);
      return `The memory file has been edited.\n${numbered(lines.slice(from - 1, at + 3).join("\n"), from)}`;
    }
    if (cmd === "insert") {
      const rel = toRel(input.path);
      const file = await findFile(rel);
      if (!file) throw new MemoryToolError(`Error: The path ${input.path} does not exist`);
      const lines = file.content.replace(/\n$/, "").split("\n");
      const n = Number(input.insert_line);
      if (!Number.isInteger(n) || n < 0 || n > lines.length) throw new MemoryToolError(`Error: Invalid \`insert_line\` parameter: ${input.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`);
      lines.splice(n, 0, ...String(input.insert_text ?? "").replace(/\n$/, "").split("\n"));
      await write(rel, `${lines.join("\n")}\n`, file.version, "memory-tool insert");
      return `The file ${input.path} has been edited.`;
    }
    if (cmd === "delete") {
      const rel = toRel(input.path);
      if (!rel) throw new MemoryToolError(`Error: Cannot delete the ${ROOT} directory itself`);
      const file = await findFile(rel);
      const targets = file ? [{ path: storeName(rel), version: file.version }] : await listUnder(rel);
      if (!targets.length) throw new MemoryToolError(`Error: The path ${input.path} does not exist`);
      for (const f of targets) {
        await store.delete(f.path, f.version);
        index.remove(f.path);
      }
      return `Successfully deleted ${input.path}`;
    }
    if (cmd === "rename") {
      const from = toRel(input.old_path);
      const to = toRel(input.new_path);
      if (!from) throw new MemoryToolError(`Error: Cannot rename the ${ROOT} directory itself`);
      if ((await findFile(to)) || (to && (await listUnder(to)).length)) throw new MemoryToolError(`Error: The destination ${input.new_path} already exists`);
      const file = await findFile(from);
      const moves = file ? [{ src: storeName(from), dst: storeName(to), file }] : (await listUnder(from)).map((f) => ({ src: f.path, dst: `${to}${f.path.slice(from.length)}` }));
      if (!moves.length) throw new MemoryToolError(`Error: The path ${input.old_path} does not exist`);
      for (const m of moves) {
        const cur = m.file || (await store.read(m.src));
        const r = await store.write(m.dst, cur.content, "new", "memory-tool rename");
        await index.upsert(r.path, cur.content, r.version);
        await store.delete(m.src, cur.version);
        index.remove(m.src);
      }
      return `Successfully renamed ${input.old_path} to ${input.new_path}`;
    }
    throw new MemoryToolError(`Error: Unknown command "${cmd}". Expected one of: view, create, str_replace, insert, delete, rename.`);
  }

  /** Returns a tool_result block for a memory tool_use block. */
  return async function handle(toolUse) {
    try {
      return { type: "tool_result", tool_use_id: toolUse.id, content: await run(toolUse.input) };
    } catch (e) {
      const msg = e instanceof MemoryToolError ? e.message : e instanceof MemoryError ? `Error: ${e.message}` : `Error: ${e.message}`;
      return { type: "tool_result", tool_use_id: toolUse.id, content: msg, is_error: true };
    }
  };
}
