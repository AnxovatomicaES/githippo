// Local vault (no GitHub needed) + one-command setup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, blobSha } from "../src/filestore.js";
import { MemoryIndex } from "../src/search.js";
import { hashEmbedder } from "../src/embed.js";
import { Brain } from "../src/brain.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const vault = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vault-"));
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  return { dir, store, brain: new Brain({ store, index: new MemoryIndex(store, hashEmbedder(), {}) }) };
};
const gitLog = (dir) => execFileSync("git", ["-C", dir, "log", "--format=%s"]).toString().trim().split("\n");

test("versions are git blob SHAs (identical to the GitHub API's)", () => {
  assert.equal(blobSha("hello\n"), execFileSync("git", ["hash-object", "--stdin"], { input: "hello\n" }).toString().trim());
});

test("local vault: remember, recall, dedupe, supersede, every change is a git commit", async () => {
  const { dir, brain } = await vault();
  await brain.remember("Johnny needs a wake word", { about: "Johnny", kind: "project" });
  assert.equal((await brain.remember("Johnny needs a wake word", { about: "johnny" })).status, "duplicate");
  await brain.remember("Launch is end of Q1", { about: "johnny" });
  const r = await brain.remember("Launch is end of Q2", { about: "johnny", replaces: "Launch is end of Q1" });
  assert.equal(r.status, "superseded");
  const text = await readFile(join(dir, "memory/projects/johnny.md"), "utf8");
  assert.match(text, /Launch is end of Q2[\s\S]*## History\n- ~~Launch is end of Q1~~/);
  assert.match((await brain.recall("wake word", { mode: "brief" })).hits[0].ref, /projects\/johnny\.md/);
  assert.ok(gitLog(dir).filter((m) => /memory: (remember|supersede)/.test(m)).length >= 3);
});

test("local vault: history, time travel and active days come from git", async () => {
  const { brain, store } = await vault();
  await store.write("topics/brand.md", "---\nname: brand\n---\n\n- navy\n", "new");
  const before = new Date(Date.now() + 1500).toISOString();
  await new Promise((r) => setTimeout(r, 2100));
  const v = (await store.read("topics/brand.md")).version;
  await store.write("topics/brand.md", "---\nname: brand\n---\n\n- teal\n", v);
  const tl = await brain.history("brand");
  assert.equal(tl.commits.length, 2);
  assert.match((await brain.history("brand", { at: before })).content, /navy/);
  assert.ok((await store.activeDays("2000-01-01")).length >= 1);
});

test("local vault: stale versions are rejected; edits made in Obsidian are picked up", async () => {
  const { dir, store, brain } = await vault();
  const w = await store.write("x.md", "one\n", "new");
  await store.write("x.md", "two\n", w.version);
  await assert.rejects(store.write("x.md", "three\n", w.version), /Version conflict/);
  await brain.index.sync();
  await writeFile(join(dir, "memory/x.md"), "---\nname: x\n---\n\n- edited by hand in Obsidian about pelicans\n");
  brain.index.lastSync = 0;
  assert.match((await brain.recall("pelicans", { mode: "brief" })).hits[0].ref, /^x\.md/);
});

test("two processes writing at once: nothing lost, nothing left uncommitted (20 rounds)", async () => {
  for (let round = 0; round < 20; round++) {
  const { dir } = await vault();
  const a = new FileStore({ dir, autoPush: false });
  const b = new FileStore({ dir, autoPush: false });
  await Promise.all([...Array(6)].map((_, i) => (i % 2 ? a : b).write(`n${i}.md`, `note ${i}\n`, "new")));
  assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString().trim(), "");
  const tracked = execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"]).toString().split("\n").filter((f) => /^memory\/n\d\.md$/.test(f));
  assert.equal(tracked.length, 6, "every note is in HEAD");
  }
});

test("githippo setup: one command, zero questions, no GitHub", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  const env = { PATH: "/usr/bin:/bin:" + process.env.PATH.split(":").filter((p) => !/claude/.test(p)).join(":"), HOME: home, GITHIPPO_HOME: join(home, ".githippo"), EMBEDDINGS: "none" };
  const out = execFileSync("node", [CLI, "setup"], { env, stdio: "pipe", timeout: 20000 }).toString();
  assert.match(out, /✓ memory vault/);
  assert.match(out, /✓ Claude Code {4}hooks \+ status line/);
  assert.match(out, /Done in \d+\.\d s/);
  assert.ok(existsSync(join(home, ".githippo/vault/memory/core.md")));
  const settings = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"));
  for (const e of ["PreCompact", "PostCompact", "SessionStart", "SessionEnd", "UserPromptSubmit"]) assert.ok(settings.hooks[e], e);
  assert.equal(settings.statusLine.command, "githippo statusline");
  // idempotent: running it again changes nothing important
  execFileSync("node", [CLI, "setup"], { env, stdio: "pipe" });
  const again = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"));
  assert.equal(again.hooks.PreCompact.length, 1);
  // and the MCP server starts with no configuration at all
  const init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n';
  const res = execFileSync("node", [CLI, "serve"], { env, input: init, timeout: 8000, stdio: ["pipe", "pipe", "ignore"] }).toString();
  assert.match(res, /"name":"githippo"/);
});
