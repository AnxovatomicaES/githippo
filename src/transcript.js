// Turns a Claude Code transcript (JSONL) into a compact session checkpoint,
// deterministically: no LLM call, so it works inside a PreCompact hook.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

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
  const text = bs.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text || /^<(command|local-command|system|user-prompt-submit-hook)/.test(text)) return null;
  if (/^Caveat:|This session is being continued from a previous conversation/.test(text)) return null;
  return text;
}

export function parseTranscript(jsonl) {
  const entries = jsonl
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const prompts = [];
  const files = new Map();
  const commands = [];
  let todos = null; // legacy TodoWrite list
  const tasks = new Map(); // current TaskCreate/TaskUpdate list: id -> { subject, status }
  const creates = new Map(); // tool_use id -> provisional task id
  let seq = 0;
  let lastAssistant = "";
  let priorSummary = "";
  let cwd = "";

  for (const e of entries) {
    cwd ||= e.cwd || "";
    if (e.type === "summary" && e.summary) priorSummary = e.summary;
    const p = promptText(e);
    if (p) prompts.push(p);
    if (e.type === "user") {
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
    if (e.type !== "assistant") continue;
    for (const b of blocks(e.message)) {
      if (b.type === "text" && b.text.trim()) lastAssistant = b.text.trim();
      if (b.type !== "tool_use") continue;
      const input = b.input || {};
      if (EDIT_TOOLS.has(b.name) && (input.file_path || input.notebook_path)) {
        const f = input.file_path || input.notebook_path;
        files.set(f, (files.get(f) || 0) + 1);
      }
      if (b.name === "TodoWrite" && Array.isArray(input.todos)) todos = input.todos;
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
      if (b.name === "Bash" && input.command) commands.push(oneLine(input.command));
    }
  }
  if (tasks.size) todos = [...tasks.values()];
  return { prompts, files, commands, todos, lastAssistant, priorSummary, cwd };
}

/** Renders a checkpoint that fits a token budget (~4 chars per token). */
export function renderCheckpoint(t, { sessionId = "", budgetTokens = 900 } = {}) {
  const project = t.cwd ? basename(t.cwd) : "unknown";
  const out = [
    "---",
    `name: ${project}-${sessionId.slice(0, 8)}`,
    `title: Session checkpoint (${project})`,
    "type: session",
    `description: Working state of a Claude Code session in ${project}, saved before compaction`,
    `session: ${sessionId}`,
    `project: ${project}`,
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
    section("Tasks", t.todos.map((td) => `- [${mark[td.status] ?? " "}] ${clip(oneLine(td.content || ""), 160)}`));
  }
  const files = [...t.files].sort((a, b) => b[1] - a[1]).slice(0, 15);
  section("Files changed", files.map(([f, n]) => `- ${f}${n > 1 ? ` (${n} edits)` : ""}`));
  section("Recent commands", [...new Set(t.commands)].slice(-5).map((c) => `- \`${clip(c, 120)}\``));
  if (t.lastAssistant) section("Where it stopped", [`- ${clip(oneLine(t.lastAssistant), 600)}`]);
  if (t.priorSummary) section("Earlier summary", [`- ${clip(oneLine(t.priorSummary), 500)}`]);

  let text = out.join("\n");
  const max = budgetTokens * 4;
  if (text.length > max) text = `${text.slice(0, max - 20)}\n- …(truncated)\n`;
  return { project, text };
}

export async function checkpointFromFile(path, opts) {
  return renderCheckpoint(parseTranscript(await readFile(path, "utf8")), opts);
}
