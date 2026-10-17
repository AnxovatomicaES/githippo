// Regression tests for the v3.1.3 bug hunt. Each test is named after the bug it pins down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "githippo-bugs-"));
process.env.GITHIPPO_HOME = home;
const { setup } = await import("./helpers.js");
const { GitHubMemoryStore } = await import("../src/store.js");
const { parseFile } = await import("../src/parse.js");
const { KnowledgeGraph } = await import("../src/graph.js");
const { redact } = await import("../src/guard.js");
const { loadConfig } = await import("../src/config.js");
const { parseTranscript, parseTranscriptFile } = await import("../src/transcript.js");
const hooks = await import("../src/hooks.js");
const { createHttpApp } = await import("../src/http.js");
const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const L = (o) => JSON.stringify(o);

test("B1 recall refs point at content, not blank lines", () => {
  const c = "---\nname: j\n---\n\n- Needs a wake word\n";
  const f = parseFile("p/j.md", c);
  assert.equal(c.split("\n")[f.chunks[0].line - 1], "- Needs a wake word");
});

test("B2 CRLF files parse", () => {
  const f = parseFile("p/x.md", "---\r\nname: x\r\naliases: [X1]\r\n---\r\n\r\n- fact\r\n");
  assert.deepEqual(f.aliases, ["X1"]);
});

test("B3 non-Latin entity names get a valid file", async () => {
  const { brain } = setup();
  const r = await brain.remember("Head of APAC", { about: "王伟", kind: "person" });
  assert.match(r.path, /^people\/entity-[0-9a-f]{8}\.md$/);
});

test("B4 entity names can't inject frontmatter", async () => {
  const { brain, gh } = setup();
  const r = await brain.remember("fact here", { about: "Evil\ntype: core\ndescription: pwned", kind: "person" });
  const fm = gh.text(`memory/${r.path}`).split("---")[1];
  assert.equal(fm.match(/^type: (.*)$/m)[1], "person");
  assert.equal((fm.match(/^description:/gm) || []).length, 1);
});

test("B5 same file name in two folders stays two entities", () => {
  const g = new KnowledgeGraph([parseFile("people/johnny.md", "---\ntitle: Johnny Lee\n---\n- engineer\n"), parseFile("projects/johnny.md", "---\ntitle: Johnny\n---\n- assistant\n")]);
  assert.equal(g.nodes.size, 2);
  assert.notEqual(g.idOf("people/johnny.md"), g.idOf("projects/johnny.md"));
});

test("B6 first-name aliases don't match everyday words", () => {
  const g = new KnowledgeGraph([parseFile("people/mark-lee.md", "---\ntitle: Mark Lee\naliases: [Mark]\n---\n- CFO\n")]);
  assert.deepEqual(g.mentions("please mark this ticket as done"), []);
  assert.deepEqual(g.mentions("Mark this as done."), []);
  assert.equal(g.mentions("We asked Mark about the budget")[0].id, "mark-lee");
});

test("B7 never links inside URLs, code or existing links", () => {
  const g = new KnowledgeGraph([parseFile("projects/johnny.md", "---\ntitle: Johnny\n---\n- x\n")]);
  const r = g.autoLink("See https://example.com/johnny and `johnny.start()`, ask Johnny.");
  assert.equal(r.text, "See https://example.com/johnny and `johnny.start()`, ask [[johnny|Johnny]].");
});

test("B8 wrong repo on write → clear message, not TypeError", async () => {
  const store = new GitHubMemoryStore({ token: "t", repo: "a/b", fetchImpl: async () => ({ status: 404, ok: false, json: async () => ({}) }) });
  await assert.rejects(store.write("x.md", "y", "new"), /doesn't exist or this token can't write/);
});

test("B9 empty repo lists as empty", async () => {
  const store = new GitHubMemoryStore({ token: "t", repo: "a/b", fetchImpl: async () => ({ status: 409, ok: false, json: async () => ({ message: "Git Repository is empty." }) }) });
  assert.deepEqual(await store.list(), []);
});

test("B11 ~ in CACHE_DIR means home", () => {
  assert.equal(loadConfig({ CACHE_DIR: "~/x" }).CACHE_DIR, join(homedir(), "x"));
});

test("B12 DECAY_ACTIVE_DAYS is honoured", () => {
  assert.equal(loadConfig({ DECAY_ACTIVE_DAYS: "7" }).DECAY_ACTIVE_DAYS, 7);
  assert.equal(loadConfig({ DECAY_ACTIVE_DAYS: "abc" }).DECAY_ACTIVE_DAYS, 20);
});

test("B13 inbox isn't listed in the index", async () => {
  const { brain, gh } = setup();
  await brain.remember("Prefers dark mode in every editor");
  assert.doesNotMatch(gh.text("memory/index.md"), /\[\[inbox\]\]/);
});

test("B15 a concurrent writer is absorbed, not surfaced as an error", async () => {
  const { brain, store, gh } = setup();
  await brain.index.sync();
  const f = await store.read("projects/johnny.md");
  await store.write("projects/johnny.md", `${f.content}- written by another session\n`, f.version);
  const r = await brain.remember("Johnny supports Spanish", { about: "johnny" });
  assert.equal(r.status, "saved");
  const text = gh.text("memory/projects/johnny.md");
  assert.match(text, /written by another session/);
  assert.match(text, /Johnny supports Spanish|supports Spanish/);
});

test("B16 embeddings failing degrades to keyword search", async () => {
  const broken = { id: "local:x", profile: { dup: 0.92, related: 0.55, conflict: 0.8, strong: 0.4, floor: 0.25 }, embed: async () => { throw new Error("offline"); } };
  const { brain } = setup({ embedder: broken });
  const r = await brain.recall("wake word", { mode: "brief" });
  assert.match(r.hits[0].ref, /johnny\.md/);
  assert.equal((await brain.remember("Johnny should support Spanish", { about: "johnny" })).status, "saved");
});

test("B18 rate limit keys on the proxy-added (right-most) client IP", async () => {
  const { brain } = setup();
  const app = createHttpApp(brain, { secret: "s".repeat(32), ratePerMinute: 2 });
  await new Promise((r) => app.listen(0, r));
  const url = `http://127.0.0.1:${app.address().port}/mcp/${"s".repeat(32)}`;
  const hit = (xff) => fetch(url, { method: "GET", headers: { "x-forwarded-for": xff } }).then((r) => r.status);
  // attacker rotates the left-most value; the proxy-added right-most value stays the same
  const codes = [await hit("1.1.1.1, 9.9.9.9"), await hit("2.2.2.2, 9.9.9.9"), await hit("3.3.3.3, 9.9.9.9")];
  app.close();
  assert.equal(codes.at(-1), 429);
});

test("B19 install takes the typed/env token and replaces an old one (non-interactive)", async () => {
  const h = await mkdtemp(join(tmpdir(), "inst-"));
  await writeFile(join(h, "config.json"), JSON.stringify({ GITHUB_TOKEN: "old_token_value", MEMORY_REPO: "me/old" }));
  execFileSync("node", [CLI, "install", "--config-only", "--repo", "me/mem", "--token-env", "NEW_TOKEN", "--embeddings", "none"], {
    env: { PATH: process.env.PATH, HOME: h, GITHIPPO_HOME: h, NEW_TOKEN: "new_token_value" }, stdio: "pipe",
  });
  const cfg = JSON.parse(await readFile(join(h, "config.json"), "utf8"));
  assert.equal(cfg.GITHUB_TOKEN, "new_token_value");
  assert.equal(cfg.MEMORY_REPO, "me/mem");
});

test("B21 + B22 session end checkpoints, keyed by full path", async () => {
  const tp = join(home, "end.jsonl");
  await writeFile(tp, L({ type: "user", cwd: "/a/app", message: { content: "Build the export" } }));
  await hooks.sessionEnd({ session_id: "e1", transcript_path: tp, cwd: "/a/app" });
  const tp2 = join(home, "end2.jsonl");
  await writeFile(tp2, L({ type: "user", cwd: "/b/app", message: { content: "Fix the login bug" } }));
  await hooks.sessionEnd({ session_id: "e2", transcript_path: tp2, cwd: "/b/app" });
  const a = JSON.parse(await hooks.sessionStart({ session_id: "n1", source: "startup", cwd: "/a/app" }));
  const b = JSON.parse(await hooks.sessionStart({ session_id: "n2", source: "startup", cwd: "/b/app" }));
  assert.match(a.hookSpecificOutput.additionalContext, /Build the export/);
  assert.doesNotMatch(a.hookSpecificOutput.additionalContext, /login/);
  assert.match(b.hookSpecificOutput.additionalContext, /Fix the login bug/);
  assert.notEqual(hooks.projectKey("/a/app"), hooks.projectKey("/b/app"));
});

test("B24 a secret in a session is redacted, and the checkpoint still syncs", async () => {
  assert.match(redact("export GH=ghp_" + "a".repeat(36)).text, /\[redacted:github_token\]/);
  const tp = join(home, "secret.jsonl");
  await writeFile(tp, [
    L({ type: "user", cwd: "/s/app", message: { content: "Deploy it" } }),
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "export GH=ghp_" + "b".repeat(36) } }] } }),
  ].join("\n"));
  const { brain, gh } = setup();
  await hooks.preCompact({ session_id: "sec1", transcript_path: tp, cwd: "/s/app" }, { brain });
  const repoFile = [...gh.files.keys()].find((k) => k.includes("sessions/app-"));
  assert.ok(repoFile, "checkpoint synced despite the secret");
  assert.doesNotMatch(gh.text(repoFile), /ghp_b/);
  const local = await readFile(join(home, "checkpoints", "sec1.md"), "utf8");
  assert.doesNotMatch(local, /ghp_b/);
});

test("B26 unconfigured serve prints an instruction, not a stack trace", () => {
  try {
    execFileSync("node", [CLI, "serve"], { env: { PATH: process.env.PATH, GITHIPPO_HOME: join(home, "none") }, stdio: "pipe", input: "" });
    assert.fail("should exit 1");
  } catch (e) {
    const err = String(e.stderr);
    assert.match(err, /githippo is not configured: .*\n.*githippo install/);
    assert.doesNotMatch(err, /at .*\.js:\d+/);
  }
});

test("B27 streamed parse equals in-memory parse", async () => {
  const lines = [L({ type: "user", cwd: "/x", message: { content: "Goal" } })];
  for (let i = 0; i < 2000; i++) lines.push(L({ type: "assistant", message: { content: [{ type: "text", text: `step ${i}` }, { type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: `/x/f${i % 7}.ts` } }] } }));
  const tp = join(home, "big.jsonl");
  await writeFile(tp, lines.join("\n"));
  const a = parseTranscript(lines.join("\n"));
  const b = await parseTranscriptFile(tp);
  assert.deepEqual([...b.files], [...a.files]);
  assert.equal(b.lastAssistant, "step 1999");
  assert.equal(b.files.size, 7);
});

test("B29 a forked session restores working state like resume", async () => {
  const tp = join(home, "fork.jsonl");
  await writeFile(tp, L({ type: "user", cwd: "/f/app", message: { content: "Refactor billing" } }));
  await hooks.sessionEnd({ session_id: "parent1", transcript_path: tp, cwd: "/f/app" });
  const out = JSON.parse(await hooks.sessionStart({ session_id: "child1", source: "fork", cwd: "/f/app" }));
  assert.match(out.hookSpecificOutput.additionalContext, /Refactor billing/);
});

test("B30 status line finds the checkpoint after cd into a subfolder", async () => {
  const line = await hooks.statusLine({ session_id: "x", workspace: { current_dir: "/f/app/src/deep", project_dir: "/f/app" } }, { cacheDir: join(home, "nocache") });
  assert.match(line, /checkpoint \d+m ago/);
});
