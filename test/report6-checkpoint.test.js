// A checkpoint has a hard size budget and a big session (the only kind that compacts) overflows it. Cutting at the limit dropped the LAST sections
// first: "Where it stopped", the errors, the commands. These tests keep the resume point and the open work when the budget is tight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, renderCheckpoint } from "../src/transcript.js";

const L = (o) => JSON.stringify(o);
const cwd = "/Users/me/work/payments-platform";

function bigSession() {
  const lines = [L({ type: "user", cwd, gitBranch: "feature/billing-v2", message: { role: "user", content: "Migrate the billing service from the nightly cron to a queue worker, keep idempotency keys on every write endpoint, and make the backfill resumable so a crash in the middle does not double charge anyone" } })];
  for (let i = 1; i <= 4; i++) lines.push(L({ type: "user", message: { role: "user", content: `Follow-up ${i}: please also make sure the ${["retry policy", "dead letter queue", "metrics dashboard", "rollback plan"][i - 1]} is covered, and write down what you decided so the next person can pick this up without asking me anything at all` } }));
  lines.push(L({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", name: "TodoWrite", input: { todos: Array.from({ length: 12 }, (_, i) => ({ content: `Step ${i + 1}: ${["write the worker", "add idempotency keys", "backfill job", "retry with jitter", "dead letter queue", "dashboards", "alerts", "load test", "rollback script", "docs", "cutover plan", "post-cutover cleanup"][i]} for the billing service and its callers`, status: i < 6 ? "completed" : i === 6 ? "in_progress" : "pending" })) } },
    ...Array.from({ length: 20 }, (_, i) => ({ type: "tool_use", name: "Edit", input: { file_path: `${cwd}/services/billing/src/workers/queue/handlers/invoice-created-handler-${i}.ts` } })),
    ...Array.from({ length: 6 }, (_, i) => ({ type: "tool_use", name: "Bash", input: { command: `npm test -- --runInBand --testPathPattern=billing/workers/handlers/invoice-${i} --coverage --verbose` } })),
  ] } }));
  lines.push(L({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: `Error: connect ECONNREFUSED 127.0.0.1:5432 while running the billing integration tests against the local database ${"x".repeat(300)}` }] } }));
  lines.push(L({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `I stopped in the middle of the backfill job: the resumable cursor is written but the crash-recovery test still fails because the worker acknowledges the message before the ledger write commits. Next I will move the ack after the commit, rerun the crash test, then do the cutover plan. ${"More detail about the ack ordering and the ledger transaction boundaries, which matters for the next session. ".repeat(4)}` }] } }));
  return parseTranscript(lines.join("\n"));
}

test("a big session's checkpoint still says where it stopped, what is open and what failed (these were cut off before)", () => {
  const { text } = renderCheckpoint(bigSession(), { sessionId: "s" });
  assert.ok(text.length <= 900 * 4, `${text.length} chars`);
  for (const must of ["## Goal", "## Tasks", "## Files changed", "## Recent errors", "## Where it stopped"]) assert.ok(text.includes(must), `${must} is missing:\n${text}`);
  assert.match(text, /acknowledges the message before the ledger write commits/, "the resume point survived");
  assert.match(text, /\[~\] Step 7/, "the task in progress is listed");
  assert.match(text, /ECONNREFUSED/, "the failure is listed");
  assert.ok(!text.includes("(truncated)"), "nothing was chopped mid-section");
  assert.match(text, /\(\+\d+ not shown, \d+ of the 12 are done\)/, "the tasks that don't fit are counted, not silently dropped");
});

test("a long path keeps its file name (clipped from the left), a small session is unchanged", () => {
  const long = parseTranscript([L({ type: "user", cwd, message: { role: "user", content: "x" } }), L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: `${cwd}/${"deep/".repeat(40)}the-file-that-matters.ts` } }] } })].join("\n"));
  assert.match(renderCheckpoint(long, { sessionId: "s" }).text, /- …[^\n]*the-file-that-matters\.ts/);
  // everything fits at the first level: all sections, commands and the earlier summary included, nothing dropped
  const small = parseTranscript([
    L({ type: "summary", summary: "earlier: set up the repo" }),
    L({ type: "user", cwd, message: { role: "user", content: "Fix the login bug" } }),
    L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", name: "Edit", input: { file_path: `${cwd}/a.js` } }, { type: "text", text: "Fixed the bug; next I will add a test." }] } }),
  ].join("\n"));
  const { text } = renderCheckpoint(small, { sessionId: "s" });
  for (const must of ["## Goal", "## Files changed", "## Recent commands", "## Where it stopped", "## Earlier summary"]) assert.ok(text.includes(must), must);
  assert.ok(!/not shown/.test(text));
});

test("with an absurdly small budget it still ends cleanly and keeps the header", () => {
  const { text } = renderCheckpoint(bigSession(), { sessionId: "s", budgetTokens: 60 });
  assert.ok(text.startsWith("---\nname: "));
  assert.ok(text.length <= 60 * 4 + 40);
});
