import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "githippo-"));
process.env.GITHIPPO_HOME = home;
const { preCompact, sessionStart, promptRecall } = await import("../src/hooks.js");
const { parseTranscript, renderCheckpoint } = await import("../src/transcript.js");
const { setup } = await import("./helpers.js");

const line = (o) => JSON.stringify(o);
const transcript = [
  line({ type: "user", cwd: "/Users/m/code/johnny", message: { role: "user", content: "Build wake-word detection for Johnny using Porcupine" } }),
  line({ type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "Plan: add a detector module." },
    { type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Add detector", status: "completed" }, { content: "Wire to mic stream", status: "in_progress" }, { content: "Tests", status: "pending" }] } },
    { type: "tool_use", name: "Write", input: { file_path: "/Users/m/code/johnny/src/wake.ts" } },
    { type: "tool_use", name: "Edit", input: { file_path: "/Users/m/code/johnny/src/wake.ts" } },
    { type: "tool_use", name: "Bash", input: { command: "npm test -- wake" } },
  ] } }),
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
  line({ type: "user", message: { role: "user", content: "<command-name>/cost</command-name>" } }),
  line({ type: "user", message: { role: "user", content: "use a 16kHz sample rate" } }),
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Switched to 16kHz; next I'll connect the mic stream to the detector." }] } }),
  "not json garbage",
].join("\n");

test("transcript → deterministic checkpoint", () => {
  const t = parseTranscript(transcript);
  assert.equal(t.prompts.length, 2);
  const { project, text } = renderCheckpoint(t, { sessionId: "abc12345-x" });
  assert.equal(project, "johnny");
  assert.match(text, /## Goal\n- Build wake-word detection/);
  assert.match(text, /- \[x\] Add detector\n- \[~\] Wire to mic stream\n- \[ \] Tests/);
  assert.match(text, /wake\.ts \(2 edits\)/);
  assert.match(text, /## Where it stopped\n- Switched to 16kHz/);
  assert.doesNotMatch(text, /\/cost/);
});

test("PreCompact saves locally + to repo; SessionStart(compact) injects the state itself", async () => {
  const tp = join(home, "t.jsonl");
  await writeFile(tp, transcript);
  const { brain, gh } = setup();
  await preCompact({ session_id: "sess-1", transcript_path: tp, cwd: "/Users/m/code/johnny" }, { brain });
  assert.ok([...gh.files.keys()].some((k) => k.startsWith("memory/sessions/johnny-sess-1")));

  const out = JSON.parse(await sessionStart({ session_id: "sess-1", source: "compact", cwd: "/Users/m/code/johnny" }));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctx, /ground truth/);
  assert.match(ctx, /\[~\] Wire to mic stream/);
  assert.doesNotMatch(ctx, /^---/m);

  const fresh = JSON.parse(await sessionStart({ session_id: "new", source: "startup", cwd: "/Users/m/code/johnny" }));
  assert.match(fresh.hookSpecificOutput.additionalContext, /Last session in johnny/);
  assert.equal(await sessionStart({ session_id: "x", source: "startup", cwd: "/elsewhere" }), "");
});

test("PreCompact survives repo failure (local copy still written)", async () => {
  const tp = join(home, "t2.jsonl");
  await writeFile(tp, transcript);
  const broken = { saveRawCheckpoint: async () => { throw new Error("offline"); } };
  await preCompact({ session_id: "sess-2", transcript_path: tp, cwd: "/x/johnny" }, { brain: broken });
  assert.match(await readFile(join(home, "checkpoints", "sess-2.md"), "utf8"), /Wire to mic stream/);
});

test("prompt hook: confident matches only, budgeted, never repeated", async () => {
  const cacheDir = join(home, "cache");
  const { index } = setup({ cacheDir });
  await index.sync();
  await new Promise((r) => setTimeout(r, 50));
  const first = await promptRecall({ prompt: "what does the wake word need on the mac?", session_id: "p1" }, { cacheDir });
  assert.match(JSON.parse(first).hookSpecificOutput.additionalContext, /projects\/johnny\.md: .*wake word/);
  assert.equal(await promptRecall({ prompt: "what does the wake word need on the mac?", session_id: "p1" }, { cacheDir }), "");
  assert.equal(await promptRecall({ prompt: "write a haiku about autumn leaves", session_id: "p1" }, { cacheDir }), "");
});
