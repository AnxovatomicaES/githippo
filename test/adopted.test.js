// One test per feature adopted from other memory tools (see docs/prior-art.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "githippo-adopt-"));
process.env.GITHIPPO_HOME = home;
const { setup } = await import("./helpers.js");
const { stripMemoryTags } = await import("../src/parse.js");
const { tokenize } = await import("../src/search.js");
const { fmt } = await import("../src/format.js");
const { parseTranscript, renderCheckpoint } = await import("../src/transcript.js");
const hooks = await import("../src/hooks.js");
const { hookEnabled } = await import("../src/config.js");
const L = (o) => JSON.stringify(o);

test("claude-mem: <private> content is never stored", async () => {
  const { brain, gh } = setup();
  await brain.remember("Johnny API base is staging <private>password hunter2</private> for now", { about: "johnny" });
  assert.doesNotMatch(gh.text("memory/projects/johnny.md"), /hunter2|private/);
  await assert.rejects(brain.remember("<private>only secret stuff here</private>"), /entirely inside <private>/);
  // an opener that never closes makes everything after it private (a forgotten closing tag must not leak the text),
  // and an explicit save is refused with a clear message instead of silently losing the end of the fact
  assert.deepEqual(stripMemoryTags("explain how <private> tags work"), { text: "explain how", removed: 1, unclosed: true });
  await assert.rejects(brain.remember("explain how <private> tags work"), /opened but never closed/);
});

test("claude-mem: injected memory is never re-captured (feedback-loop guard)", async () => {
  const t = parseTranscript([
    L({ type: "user", cwd: "/x/p", message: { content: "<githippo-context>\nold memory\n</githippo-context>\nRefactor the parser" } }),
    L({ type: "user", message: { content: "<system-reminder>harness text</system-reminder>" } }),
  ].join("\n"));
  assert.deepEqual(t.prompts, ["Refactor the parser"]);
  const out = await hooks.promptRecall({ prompt: "x" }, { cacheDir: home });
  assert.equal(out, "");
});

test("claude-mem: brief recall shows per-hit token cost, never date stamps", async () => {
  const { brain } = setup();
  await brain.remember("Johnny listens for the wake word Hey Johnny", { about: "johnny" });
  const text = fmt.recall(await brain.recall("wake word", { mode: "brief" }));
  assert.match(text, /^projects\/johnny\.md:\d+ ~\d+t /m);
  const pack = fmt.recall(await brain.recall("wake word"));
  await brain.remember("Johnny listens for the wake word Hey Jonny", { about: "johnny" });
  const report = fmt.maintain(await brain.maintain({}));
  assert.doesNotMatch(pack + text + report, /<!--/, "date stamps never reach the model");
});

test("claude-memory-hub: code-aware tokenizer finds identifiers by their parts", async () => {
  assert.ok(tokenize("handleRefund").includes("refund"));
  assert.ok(tokenize("batch_insert_personas").includes("insert"));
  assert.ok(tokenize("src/api/webhooks/stripe.ts").includes("webhook"), "plural folded");
  const { brain, gh } = setup();
  gh.seed("memory/topics/payments.md", "---\nname: payments\n---\n\n- handleRefundWebhook is still a stub\n");
  const r = await brain.recall("refund webhook", { mode: "brief" });
  assert.match(r.hits[0].ref, /payments\.md/);
});

test("agentmemory: failed tool calls are kept in the checkpoint", () => {
  const t = parseTranscript([
    L({ type: "user", cwd: "/x/p", message: { content: "Run the migration" } }),
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm run migrate" } }] } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "Error: relation users already exists" }] } }),
  ].join("\n"));
  assert.match(renderCheckpoint(t).text, /## Recent errors\n- Bash: Error: relation users already exists/);
});

test("claude-memory-hub: PreCompact steers the compactor with a priority list", async () => {
  const tp = join(home, "steer.jsonl");
  await writeFile(tp, [
    L({ type: "user", cwd: "/x/app", message: { content: "Ship CSV export" } }),
    L({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "TaskCreate", input: { subject: "Write exporter" } },
      { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x/app/src/export.ts" } },
    ] } }),
  ].join("\n"));
  const out = await hooks.preCompact({ session_id: "steer1", transcript_path: tp, cwd: "/x/app" });
  assert.match(out, /^githippo: keep these in the compaction summary:/);
  assert.match(out, /Open tasks: Write exporter/);
  assert.match(out, /Files changed: src\/export\.ts/);
  assert.ok(out.length <= 1000);
});

test("claude-memory-hub: PostCompact keeps the compactor's summary, but it isn't re-injected after compaction", async () => {
  const tp = join(home, "pc.jsonl");
  await writeFile(tp, L({ type: "user", cwd: "/x/app", message: { content: "Ship CSV export" } }));
  await hooks.preCompact({ session_id: "pc1", transcript_path: tp, cwd: "/x/app" });
  const summary = "<analysis>scratch</analysis><summary>" + "The user is shipping CSV export. ".repeat(10) + "</summary>";
  await hooks.postCompact({ session_id: "pc1", compact_summary: summary });
  const saved = await readFile(join(home, "checkpoints", "pc1.md"), "utf8");
  assert.match(saved, /## Compaction summary\nThe user is shipping CSV export/);
  assert.doesNotMatch(saved, /scratch|<summary>/);
  const restored = JSON.parse(await hooks.sessionStart({ session_id: "pc1", source: "compact", cwd: "/x/app" }));
  assert.doesNotMatch(restored.hookSpecificOutput.additionalContext, /Compaction summary/);
  assert.match(restored.hookSpecificOutput.additionalContext, /^<githippo-context>/);
});

test("memory-bank: session diffing reports commits by others, branch change and missing files", async () => {
  const repo = await mkdtemp(join(tmpdir(), "drift-"));
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Me");
  g("config", "user.email", "me@x");
  await writeFile(join(repo, "a.ts"), "1");
  g("add", "."); g("commit", "-qm", "a");
  const ck = `---\nupdated: 2000-01-01T00:00:00Z\nbranch: main\n---\n## Files changed\n- ${repo}/gone.ts\n`;
  g("-c", "user.name=Other", "commit", "-q", "--allow-empty", "-m", "b");
  g("checkout", "-q", "-b", "feature");
  const d = hooks.drift(ck, repo);
  assert.match(d, /2 commits since then \(1 by others\)/);
  assert.match(d, /branch changed: main → feature/);
  assert.match(d, /no longer exist: gone\.ts/);
});

test("claude-meister: trivial prompts never trigger recall", () => {
  for (const p of ["yes", "ok!", "continue", "sí", "gracias", "/compact", "go ahead"]) assert.ok(hooks.isTrivialPrompt(p), p);
  assert.ok(!hooks.isTrivialPrompt("what sample rate did we choose for Johnny?"));
});

test("ECC: hook profiles and per-hook switches", () => {
  assert.ok(hookEnabled("prompt", {}));
  assert.ok(!hookEnabled("prompt", { GITHIPPO_HOOK_PROFILE: "minimal" }));
  assert.ok(hookEnabled("restore", { GITHIPPO_HOOK_PROFILE: "minimal" }));
  assert.ok(!hookEnabled("steer", { GITHIPPO_DISABLED_HOOKS: "steer, drift" }));
  assert.ok(!hookEnabled("prompt", { PROMPT_RECALL: "0" }));
});

test("claude-meister: honest status line from local state only", async () => {
  const cacheDir = join(home, "cache");
  const { index } = setup({ cacheDir });
  await index.sync();
  await new Promise((r) => setTimeout(r, 50));
  const line = await hooks.statusLine({ session_id: "none", workspace: { current_dir: "/x/app" } }, { cacheDir });
  assert.match(line, /^🦛 githippo · \d+ facts · checkpoint \d+m ago$/);
});

test("claude-memory-system: decay counts active days, archives stale inbox facts, never touches entities", async () => {
  const { brain, gh, store } = setup();
  gh.seed("memory/inbox.md", "---\nname: inbox\n---\n\n- Old idea about dashboards <!--+2025-12-01-->\n- Undated note\n");
  for (let i = 0; i < 4; i++) await store.write(`scratch/n${i}.md`, "x", "new"); // 4 more active days
  const report = await brain.maintain({ active_days: 3 });
  assert.equal(report.decay.inbox, 1);
  assert.match(fmt.maintain(report), /decay candidates \(3\+ active days old\): 1 inbox facts/);
  await brain.maintain({ decay: true, active_days: 3 });
  const inbox = gh.text("memory/inbox.md");
  assert.match(inbox, /- Undated note\n\n## Archived\n- Old idea about dashboards \(archived/);
  assert.match(gh.text("memory/projects/johnny.md"), /Needs a wake word/);
  const r = await brain.recall("dashboards idea", { mode: "brief" });
  assert.ok(!r.hits.some((h) => h.ref.startsWith("inbox.md")), "archived facts stay out of recall");
});
