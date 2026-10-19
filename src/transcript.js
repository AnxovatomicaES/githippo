// Turns a Claude Code transcript (JSONL) into a compact session checkpoint,
// deterministically: no LLM call, so it works inside a PreCompact hook.
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { cleanControl, stripMemoryTags } from "./parse.js";
import { defang } from "./injection.js";
import { redact } from "./guard.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Every free-text line is cleaned in this order: private spans out, secrets redacted, THEN cut to length (a token cut in half by the limit
// no longer matches any secret pattern, and its first 24 characters used to be written to disk), then screened for planted instructions.
const clip = (s, n) => {
  const t = redact(stripMemoryTags(String(s)).text).text;
  return defang(t.length > n ? `${t.slice(0, n - 1)}…` : t);
};
const oneLine = (s) => cleanControl(String(s)).replace(/\s+/g, " ").trim();

function blocks(message) {
  const c = message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

/** Human-typed prompt text, ignoring tool results and harness wrappers. */
function promptText(entry) {
  if (entry.type !== "user" || entry.isMeta) return null;
  const bs = blocks(entry.message);
  if (bs.some((b) => b.type === "tool_result")) return null;
  const text = stripMemoryTags(bs.filter((b) => b.type === "text").map((b) => b.text).join("\n")).text;
  if (!text || /^<(command|local-command|system|user-prompt-submit-hook)/.test(text)) return null;
  if (/^Caveat:|This session is being continued from a previous conversation/.test(text)) return null;
  return text;
}

/** Incremental parser: feed entries one at a time, so a 250 MB transcript never sits in memory (B27). */
export function transcriptParser() {

  const prompts = [];
  const files = new Map();
  const commands = [];
  const errors = [];
  const toolNames = new Map(); // tool_use id -> tool name, to label errors
  let branch = "";
  let todos = null; // legacy TodoWrite list
  const tasks = new Map(); // current TaskCreate/TaskUpdate list: id -> { subject, status }
  const creates = new Map(); // tool_use id -> provisional task id
  let seq = 0;
  let lastAssistant = "";
  let priorSummary = "";
  let cwd = "";

  const add = (e) => {
    cwd ||= e.cwd || "";
    if (e.gitBranch) branch = e.gitBranch;
    if (e.type === "summary" && e.summary) priorSummary = String(e.summary);
    const p = promptText(e);
    if (p) prompts.push(p);
    if (e.type === "user") {
      // Failed tool calls: "what broke" is the first thing lost in compaction (idea from agentmemory).
      for (const b of blocks(e.message)) {
        if (b.type !== "tool_result" || !b.is_error) continue;
        const text = typeof b.content === "string" ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : "");
        const msg = oneLine(stripMemoryTags(text).text);
        if (msg) errors.push(`${toolNames.get(b.tool_use_id) || "tool"}: ${msg.slice(0, 300)}`);
        if (errors.length > 100) errors.splice(0, 50);
      }
      // TaskCreate results say "Task #N created…": use the real id if it differs from our provisional one.
      for (const b of blocks(e.message)) {
        if (b.type !== "tool_result" || !creates.has(b.tool_use_id)) continue;
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
        const real = text.match(/#(\d+)/)?.[1];
        const prov = creates.get(b.tool_use_id);
        if (real && real !== prov && tasks.has(prov)) {
          tasks.set(real, tasks.get(prov));
          tasks.delete(prov);
        }
      }
    }
    if (e.type !== "assistant") return;
    for (const b of blocks(e.message)) {
      if (b.type === "text" && b.text.trim()) lastAssistant = stripMemoryTags(b.text).text;
      if (b.type !== "tool_use") continue;
      toolNames.set(b.id, b.name);
      const input = b.input || {};
      if (EDIT_TOOLS.has(b.name) && (input.file_path || input.notebook_path)) {
        const f = input.file_path || input.notebook_path;
        files.set(f, (files.get(f) || 0) + 1);
      }
      if (b.name === "TodoWrite" && Array.isArray(input.todos)) todos = input.todos.filter((td) => td && typeof td === "object");
      if (b.name === "TaskCreate" && (input.subject || input.description)) {
        const id = String(++seq);
        tasks.set(id, { content: input.subject || input.description, status: "pending" });
        creates.set(b.id, id);
      }
      if (b.name === "TaskUpdate" && input.taskId != null) {
        const t = tasks.get(String(input.taskId));
        if (t && input.status === "deleted") tasks.delete(String(input.taskId));
        else if (t && input.status) t.status = input.status;
      }
      if (b.name === "Bash" && input.command) {
        commands.push(oneLine(input.command).slice(0, 300));
        if (commands.length > 200) commands.splice(0, 100);
      }
    }
  };
  const result = () => {
    return { prompts, files, commands: commands.slice(-50), todos: tasks.size ? [...tasks.values()] : todos, lastAssistant, priorSummary, cwd, branch, errors: errors.slice(-20) };
  };
  return {
    add,
    result,
    line(l) {
      if (!l) return;
      try {
        add(JSON.parse(l));
      } catch {}
    },
  };
}

export function parseTranscript(jsonl) {
  const p = transcriptParser();
  for (const l of jsonl.split("\n")) p.line(l);
  return p.result();
}

export async function parseTranscriptFile(path) {
  const p = transcriptParser();
  // Split on "\n" only. readline also splits on U+2028/U+2029, and JSON.stringify writes those raw inside strings, so a prompt
  // containing one was cut in two and both halves were dropped as invalid JSON.
  // Each chunk is searched once and the pieces of an unfinished line are joined once, when it ends: re-scanning the accumulated text for
  // every chunk is quadratic, and one 30 MB line (a pasted file, a base64 image) took seconds.
  let parts = [];
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    let from = 0;
    for (let i = chunk.indexOf("\n", from); i >= 0; i = chunk.indexOf("\n", from)) {
      parts.push(chunk.slice(from, i));
      p.line(parts.join("").replace(/\r$/, ""));
      parts = [];
      from = i + 1;
    }
    if (from < chunk.length) parts.push(chunk.slice(from));
  }
  if (parts.length) p.line(parts.join("").replace(/\r$/, ""));
  return p.result();
}

/** Renders a checkpoint that fits a token budget (~4 chars per token). */
export function renderCheckpoint(t, { sessionId = "", budgetTokens = 900 } = {}) {
  // Everything below is text copied from a session (paths, branch names, tool output). A newline in any of it could end the
  // line it's on and forge a heading or a frontmatter key ("## Where it stopped"), so every value is one clipped line.
  const safe = (v, n = 200) => clip(oneLine(String(v ?? "")), n);
  const project = safe(t.cwd ? basename(String(t.cwd)) : "unknown", 80);
  const sid = safe(sessionId, 80);
  const out = [
    "---",
    `name: ${project}-${sid.slice(0, 8)}`,
    `title: Session checkpoint (${project})`,
    "type: session",
    `description: Working state of a Claude Code session in ${project}, saved before compaction`,
    `session: ${sid}`,
    `project: ${project}`,
    ...(t.branch ? [`branch: ${safe(t.branch, 100)}`] : []),
    ...(t.cwd ? [`cwd: ${safe(t.cwd, 240)}`] : []),
    `updated: ${new Date().toISOString()}`,
    "---",
    "",
  ];
  const section = (title, lines) => lines.length && out.push(`## ${title}`, ...lines, "");

  const max = budgetTokens * 4;
  const header = out.slice();
  // A checkpoint has a hard size budget, and a big session (the only kind that compacts) overflows it. Cutting the text at the limit dropped the
  // LAST sections first: "Where it stopped", the errors and the commands, which are what a resumed session needs most. So the sections are built at
  // decreasing detail until the whole fits: lowest-value detail goes first (the old summary, commands, older requests, completed tasks), the goal and
  // where it stopped last, and nothing is ever cut mid-section. A small session fits at the first level and renders exactly as before.
  const LEVELS = [
    { goal: 400, req: 4, reqLen: 240, tasks: "all", taskLen: 160, files: 15, fileLen: 160, errors: 4, errLen: 200, commands: 5, cmdLen: 120, stop: 600, summary: 500 },
    { goal: 400, req: 4, reqLen: 200, tasks: "all", taskLen: 120, files: 12, fileLen: 140, errors: 3, errLen: 160, commands: 3, cmdLen: 110, stop: 600, summary: 0 },
    { goal: 300, req: 3, reqLen: 160, tasks: "open", taskLen: 120, files: 10, fileLen: 120, errors: 2, errLen: 150, commands: 2, cmdLen: 100, stop: 600, summary: 0 },
    { goal: 250, req: 2, reqLen: 120, tasks: "open8", taskLen: 90, files: 6, fileLen: 100, errors: 1, errLen: 120, commands: 0, cmdLen: 0, stop: 500, summary: 0 },
    { goal: 200, req: 1, reqLen: 100, tasks: "open5", taskLen: 70, files: 4, fileLen: 80, errors: 1, errLen: 100, commands: 0, cmdLen: 0, stop: 400, summary: 0 },
  ];
  const build = (c) => {
    out.length = 0;
    out.push(...header);
    if (t.prompts.length) {
      section("Goal", [`- ${clip(oneLine(t.prompts[0]), c.goal)}`]);
      const recent = t.prompts.slice(1).slice(-c.req);
      section("Latest requests", recent.map((p) => `- ${clip(oneLine(p), c.reqLen)}`));
    }
    if (t.todos?.length) {
      const mark = { completed: "x", in_progress: "~", pending: " " };
      const all = t.todos.filter((td) => td && typeof td === "object");
      const open = all.filter((td) => td.status !== "completed");
      const keep = c.tasks === "all" ? all : open.slice(0, c.tasks === "open" ? open.length : Number(c.tasks.slice(4)));
      const lines = keep.map((td) => `- [${Object.hasOwn(mark, td.status) ? mark[td.status] : " "}] ${safe(td.content ?? "", c.taskLen)}`);
      if (keep.length < all.length) lines.push(`- (+${all.length - keep.length} not shown, ${all.length - open.length} of the ${all.length} are done)`);
      section("Tasks", lines);
    }
    const files = [...t.files].sort((a, b) => b[1] - a[1]).slice(0, c.files);
    // a path is clipped from the left: its end is the file name, the part worth keeping
    const tail = (f) => (oneLine(f).length > c.fileLen ? `…${oneLine(f).slice(-(c.fileLen - 1))}` : f);
    section("Files changed", files.map(([f, n]) => `- ${safe(tail(f), 400)}${n > 1 ? ` (${n} edits)` : ""}`));
    section("Recent errors", [...new Set(t.errors || [])].slice(-c.errors).map((e) => `- ${safe(e, c.errLen)}`));
    section("Recent commands", c.commands ? [...new Set(t.commands)].slice(-c.commands).map((x) => `- \`${safe(x, c.cmdLen).replace(/`/g, "'")}\``) : []);
    if (t.lastAssistant) section("Where it stopped", [`- ${clip(oneLine(t.lastAssistant), c.stop)}`]);
    if (t.priorSummary && c.summary) section("Earlier summary", [`- ${clip(oneLine(t.priorSummary), c.summary)}`]);
    return out.join("\n");
  };
  let text = "";
  for (const level of LEVELS) {
    text = build(level);
    if (text.length <= max) break;
  }
  if (text.length > max) text = `${text.slice(0, max - 20)}\n- …(truncated)\n`; // only if even the smallest level doesn't fit (a tiny budget)
  return { project, text };
}

export async function checkpointFromFile(path, opts) {
  return renderCheckpoint(await parseTranscriptFile(path), opts);
}
