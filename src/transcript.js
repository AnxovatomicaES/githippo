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
  let rest = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    rest += chunk;
    let from = 0;
    for (let i = rest.indexOf("\n", from); i >= 0; i = rest.indexOf("\n", from)) {
      p.line(rest.slice(from, i).replace(/\r$/, ""));
      from = i + 1;
    }
    rest = rest.slice(from);
  }
  p.line(rest.replace(/\r$/, ""));
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

  if (t.prompts.length) {
    section("Goal", [`- ${clip(oneLine(t.prompts[0]), 400)}`]);
    const recent = t.prompts.slice(1).slice(-4);
    section("Latest requests", recent.map((p) => `- ${clip(oneLine(p), 240)}`));
  }
  if (t.todos?.length) {
    const mark = { completed: "x", in_progress: "~", pending: " " };
    section("Tasks", t.todos.filter((td) => td && typeof td === "object").map((td) => `- [${Object.hasOwn(mark, td.status) ? mark[td.status] : " "}] ${safe(td.content ?? "", 160)}`));
  }
  const files = [...t.files].sort((a, b) => b[1] - a[1]).slice(0, 15);
  section("Files changed", files.map(([f, n]) => `- ${safe(f, 160)}${n > 1 ? ` (${n} edits)` : ""}`));
  section("Recent errors", [...new Set(t.errors || [])].slice(-4).map((e) => `- ${safe(e, 200)}`));
  section("Recent commands", [...new Set(t.commands)].slice(-5).map((c) => `- \`${safe(c, 120).replace(/`/g, "'")}\``));
  if (t.lastAssistant) section("Where it stopped", [`- ${clip(oneLine(t.lastAssistant), 600)}`]);
  if (t.priorSummary) section("Earlier summary", [`- ${clip(oneLine(t.priorSummary), 500)}`]);

  let text = out.join("\n");
  const max = budgetTokens * 4;
  if (text.length > max) text = `${text.slice(0, max - 20)}\n- …(truncated)\n`;
  return { project, text };
}

export async function checkpointFromFile(path, opts) {
  return renderCheckpoint(await parseTranscriptFile(path), opts);
}
