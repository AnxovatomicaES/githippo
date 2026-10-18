// Sleep-time consolidation (step 2): after a session, a cheap model reviews what happened and proposes memory
// updates. Proposals are applied in a separate git worktree on a branch, so the live vault (and any running
// server) is untouched until someone accepts. With a GitHub remote and gh, the branch becomes a pull request.
// Model output is untrusted: every proposal goes through the same secrets guard and injection screen.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FileStore } from "./filestore.js";
import { MemoryIndex } from "./search.js";
import { Brain } from "./brain.js";
import { factLines, plain } from "./parse.js";

const SYSTEM = `You maintain a user's long-term memory: Markdown notes, one durable fact per bullet.
Given what happened in a work session and the current related memory, propose ONLY changes a careful human
assistant would make. Durable facts only: decisions, preferences, people's roles, project status, deadlines,
corrections. Skip chit-chat, transient tasks, guesses and anything already in memory. Never include secrets or
ID numbers. Return a JSON array (empty if nothing to change) of operations:
{"op":"add","fact":"one self-contained third-person fact","about":"entity name or null"}
{"op":"supersede","old":"exact existing line text","new":"replacement fact"}
{"op":"contradiction","a":"existing line","b":"other existing line","note":"why they conflict"}`;

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

export async function proposeUpdates({ llm, sessionText, brain }) {
  const related = await brain.recall(sessionText.slice(0, 4000), { budget: 1500 });
  const ops = await llm.json({
    system: SYSTEM,
    prompt: `<current_memory>\n${related.context || "(empty)"}\n</current_memory>\n\n<session>\n${sessionText.slice(-24000)}\n</session>\n\nReturn the JSON array.`,
    maxTokens: 2000,
  });
  return Array.isArray(ops) ? ops.slice(0, 40) : [];
}

/**
 * Applies proposals on branch githippo/proposals-<stamp> in a worktree next to the vault.
 * Returns { branch, applied:[...], rejected:[{op, reason}], contradictions:[...] }.
 */
export async function applyOnBranch({ vaultDir, ops, root = "memory", stampNow = new Date() }) {
  const branch = `githippo/proposals-${stampNow.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  const wt = join(vaultDir, "..", `.githippo-worktree-${process.pid}-${Date.now()}`);
  git(vaultDir, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  const result = { branch, applied: [], rejected: [], contradictions: [] };
  try {
    const store = new FileStore({ dir: wt, root, source: "consolidation", autoPush: false });
    const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
    await brain.index.sync({ maxAgeMs: 0 });
    const norm = (x) => String(x).toLowerCase().replace(/\s+/g, " ").trim();
    const superseded = new Set(); // a batch must not re-add what it just superseded
    for (const op of ops) {
      try {
        if (op.op === "add" && op.fact && superseded.has(norm(op.fact))) {
          result.rejected.push({ op, reason: "contradicts a supersession in the same batch" });
        } else if (op.op === "add" && op.fact) {
          const r = await brain.remember(String(op.fact), { about: op.about || undefined, source: "inferred" });
          if (r.status === "duplicate") result.rejected.push({ op, reason: "already in memory" });
          else result.applied.push({ op, path: r.path });
        } else if (op.op === "supersede" && op.old && op.new) {
          const hit = [...brain.index.files.values()].find((f) => factLines(f.body).some((l) => plain(l).trim() === String(op.old).trim()));
          if (!hit) {
            result.rejected.push({ op, reason: "old line not found" });
            continue;
          }
          await brain.remember(String(op.new), { path: hit.path, replaces: String(op.old), source: "inferred" });
          superseded.add(norm(op.old));
          result.applied.push({ op, path: hit.path });
        } else if (op.op === "contradiction") result.contradictions.push(op);
        else result.rejected.push({ op, reason: "unknown operation" });
      } catch (e) {
        result.rejected.push({ op, reason: e.message.split("\n")[0] });
      }
    }
    await store.queue;
  } finally {
    git(vaultDir, "worktree", "remove", "--force", wt);
  }
  if (!result.applied.length) git(vaultDir, "branch", "-D", branch);
  return result;
}

/** Accept = merge the proposals branch into the vault's current branch; reject = delete it. */
export function acceptProposals(vaultDir, branch) {
  git(vaultDir, "-c", "user.name=githippo", "-c", "user.email=githippo@localhost", "merge", "--no-edit", "-q", branch);
  git(vaultDir, "branch", "-d", branch);
}
export function rejectProposals(vaultDir, branch) {
  git(vaultDir, "branch", "-D", branch);
}
export function listProposals(vaultDir) {
  return git(vaultDir, "branch", "--list", "githippo/proposals-*").split("\n").map((b) => b.replace(/^[*+ ]+/, "").trim()).filter(Boolean);
}

/** Opens a pull request for the branch if the vault has a GitHub remote and gh is logged in. */
export function openPullRequest(vaultDir, branch, summary) {
  try {
    if (!git(vaultDir, "remote")) return null;
    git(vaultDir, "push", "-q", "-u", "origin", branch);
    return execFileSync("gh", ["pr", "create", "--head", branch, "--title", `Memory updates proposed after a session (${branch.slice(-12)})`, "--body", summary], { cwd: vaultDir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}
