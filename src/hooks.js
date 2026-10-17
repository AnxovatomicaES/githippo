// Claude Code lifecycle hooks. They must be fast and must never break a
// session: every path exits 0, and network calls have short timeouts.
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME_DIR } from "./config.js";
import { checkpointFromFile } from "./transcript.js";
import { Bm25, tokenize } from "./search.js";
import { plain } from "./parse.js";

const CK_DIR = join(HOME_DIR, "checkpoints");
const STATE_DIR = join(HOME_DIR, "state");
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const safeId = (s) => String(s || "unknown").replace(/[^\w-]/g, "").slice(0, 64);

const emit = (event, additionalContext) =>
  additionalContext ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }) : "";

/** PreCompact: snapshot working state from the transcript, locally first, then to the repo. */
export async function preCompact(input, { brain } = {}) {
  if (!input.transcript_path) return "";
  const { project, text } = await checkpointFromFile(input.transcript_path, { sessionId: input.session_id || "" });
  await mkdir(CK_DIR, { recursive: true });
  await writeFile(join(CK_DIR, `${safeId(input.session_id)}.md`), text);
  await writeFile(join(CK_DIR, `latest-${safeId(project)}.md`), text);
  if (brain) {
    const path = `sessions/${safeId(project).toLowerCase()}-${safeId(input.session_id).slice(0, 8)}.md`;
    await withTimeout(brain.saveRawCheckpoint(path, text), 8000).catch((e) => console.error(`[githippo] repo checkpoint skipped: ${e.message}`));
  }
  return "";
}

const body = (md) => plain(md.replace(/^---\n[\s\S]*?\n---\n?/, "").trim());

/** SessionStart: after compaction/resume, inject the checkpoint itself (not a reminder to read it). */
export async function sessionStart(input) {
  const project = input.cwd ? input.cwd.split("/").filter(Boolean).pop() : "";
  const read = (f) => readFile(join(CK_DIR, f), "utf8").catch(() => null);
  if (["compact", "resume"].includes(input.source)) {
    const ck = (await read(`${safeId(input.session_id)}.md`)) || (project && (await read(`latest-${safeId(project)}.md`)));
    if (!ck) return "";
    return emit("SessionStart", `githippo restored your working state from before context compaction. Treat it as ground truth and continue from "Where it stopped":\n${body(ck)}`);
  }
  // Fresh session in the same project within 24h: brief continuity note.
  if (input.source === "startup" && project) {
    const file = join(CK_DIR, `latest-${safeId(project)}.md`);
    const s = await stat(file).catch(() => null);
    if (!s || Date.now() - s.mtimeMs > 86_400_000) return "";
    const ck = body(await readFile(file, "utf8"));
    const brief = ck.split(/\n(?=## )/).filter((sec) => /^## (Goal|Tasks|Where it stopped)/.test(sec)).join("\n").slice(0, 1200);
    return brief ? emit("SessionStart", `Last session in ${project} (githippo):\n${brief}`) : "";
  }
  return "";
}

/** UserPromptSubmit: proactive, budgeted recall from a local snapshot. Only fires on confident matches; never repeats within a session. */
export async function promptRecall(input, { cacheDir, maxTokens = 300 } = {}) {
  if (!input.prompt || tokenize(input.prompt).length < 2) return "";
  let snap;
  try {
    snap = JSON.parse(await readFile(join(cacheDir, "snapshot.json"), "utf8"));
  } catch {
    return "";
  }
  const bm = new Bm25(snap.chunks);
  const qTokens = [...new Set(tokenize(input.prompt))];
  const idfSum = qTokens.reduce((s, t) => s + (bm.df.has(t) ? Math.log(1 + snap.chunks.length / bm.df.get(t)) : 0), 0);
  // Size-independent confidence: share of the prompt's informative (IDF-weighted) terms the chunk covers,
  // and at least two distinct matched terms. Absolute BM25 cutoffs break on small vaults.
  const idf = (t) => Math.log(1 + snap.chunks.length / bm.df.get(t));
  const hits = bm.search(input.prompt).filter((h) => {
    const counts = bm.tf.get(h.c.id).counts;
    const matched = qTokens.filter((t) => counts.has(t));
    return idfSum > 0 && matched.length >= 2 && matched.reduce((s, t) => s + idf(t), 0) / idfSum >= 0.35;
  });
  if (!hits.length) return "";

  await mkdir(STATE_DIR, { recursive: true });
  const stateFile = join(STATE_DIR, `${safeId(input.session_id)}.json`);
  const seen = new Set(JSON.parse(await readFile(stateFile, "utf8").catch(() => "[]")));
  const lines = [];
  let used = 0;
  for (const { c } of hits.slice(0, 5)) {
    if (seen.has(c.id)) continue;
    const line = `${c.path}: ${plain(c.text).replace(/\s*\n\s*/g, " ")}`.slice(0, 400);
    if ((used + line.length) / 4 > maxTokens) break;
    lines.push(line);
    used += line.length;
    seen.add(c.id);
    if (lines.length === 3) break;
  }
  if (!lines.length) return "";
  await writeFile(stateFile, JSON.stringify([...seen]));
  return emit("UserPromptSubmit", `githippo memory that may be relevant:\n${lines.join("\n")}`);
}

export async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

export async function cleanupOld(days = 30) {
  for (const dir of [CK_DIR, STATE_DIR]) {
    for (const f of await readdir(dir).catch(() => [])) {
      const p = join(dir, f);
      const s = await stat(p).catch(() => null);
      if (s && Date.now() - s.mtimeMs > days * 86_400_000) await rm(p, { force: true });
    }
  }
}
