// Start-up cost. Claude Code runs `githippo hook prompt` before every prompt and `githippo statusline` constantly; loading the MCP SDK and
// zod for those (via server.js) was ~85 ms of a ~125 ms start. These tests keep the cheap commands cheap by looking at what they LOAD,
// which is deterministic, instead of timing them, which is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const CLI = join(SRC, "cli.js");
const REGISTER = pathToFileURL(fileURLToPath(new URL("./fixtures/trace-register.mjs", import.meta.url))).href;

const loaded = async (args, input = "{}") => {
  const home = await mkdtemp(join(tmpdir(), "r6-"));
  const trace = join(home, "trace.txt");
  await writeFile(trace, "");
  const env = { PATH: process.env.PATH, HOME: home, GITHIPPO_HOME: join(home, "g"), VAULT_DIR: join(home, "vault"), STORE: "local", EMBEDDINGS: "none", TRACE_FILE: trace };
  const r = spawnSync(process.execPath, ["--import", REGISTER, CLI, ...args], { env, input, encoding: "utf8", timeout: 60_000 });
  const modules = (await readFile(trace, "utf8")).split("\n").filter(Boolean);
  return { r, modules, heavy: modules.filter((m) => /node_modules\/(@modelcontextprotocol|zod)\//.test(m) || /\/src\/(server|http)\.js$/.test(m)) };
};

test("cli.js has no static import of the server, the HTTP app or the MCP SDK", async () => {
  const src = await readFile(CLI, "utf8");
  const statics = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)";?$/gm)].map((m) => m[1]);
  const heavy = statics.filter((s) => /^\.\/(server|http)\.js$/.test(s) || s.startsWith("@modelcontextprotocol/"));
  assert.deepEqual(heavy, [], `these must be imported inside the commands that use them: ${heavy.join(", ")}`);
});

test("the hooks, the status line and --version never load the MCP SDK, zod, the server or the HTTP app", async () => {
  const prompt = JSON.stringify({ session_id: "t", prompt: "what did we decide about the billing rewrite?", cwd: "/x/app" });
  const cases = {
    statusline: await loaded(["statusline"], JSON.stringify({ session_id: "t", workspace: { current_dir: "/x/app" } })),
    "hook prompt": await loaded(["hook", "prompt"], prompt),
    "hook session-start": await loaded(["hook", "session-start"], JSON.stringify({ session_id: "t", source: "startup", cwd: "/x/app" })),
    "--version": await loaded(["--version"], ""),
  };
  for (const [name, { modules, heavy }] of Object.entries(cases)) {
    assert.ok(modules.length > 0, `${name}: the trace recorded nothing, so this test would pass for the wrong reason`);
    assert.deepEqual(heavy, [], `${name} loaded: ${heavy.map((h) => h.split("/").slice(-3).join("/")).join(", ")}`);
  }
  assert.ok(cases["hook prompt"].modules.some((m) => m.endsWith("/src/hooks.js")), "control: the trace does see the modules a hook really needs");
});

test("the commands that need the server still load it (so the checks above are real)", async () => {
  const bench = await loaded(["bench"], "");
  assert.equal(bench.r.status, 0, bench.r.stderr);
  assert.match(bench.r.stdout, /tools: 8/);
  assert.match(bench.r.stdout, /hook start-up: ~\d+ ms, status line: ~\d+ ms \(node alone: ~\d+ ms\)/, "bench reports start-up time");
  assert.ok(bench.heavy.some((m) => /@modelcontextprotocol/.test(m)), "bench uses the SDK");
  assert.ok(bench.heavy.some((m) => /\/src\/server\.js$/.test(m)));
});

test("the lazy imports behave: serve over stdio, precompact and session-end hooks, init and doctor still work", async () => {
  const home = await mkdtemp(join(tmpdir(), "r6b-"));
  const env = { PATH: process.env.PATH, HOME: home, GITHIPPO_HOME: join(home, "g"), VAULT_DIR: join(home, "vault"), STORE: "local", EMBEDDINGS: "none" };
  const run = (args, input = "") => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8", timeout: 60_000 });
  assert.equal(run(["init"]).status, 0);
  const doc = run(["doctor"]);
  assert.match(doc.stdout, /indexed \d+ files/);
  // a precompact hook (the one that needs a brain, so it loads the server lazily) saves a checkpoint to the vault
  const tx = join(home, "t.jsonl");
  await writeFile(tx, `${JSON.stringify({ type: "user", cwd: "/x/app", message: { role: "user", content: "Ship the billing rewrite" } })}\n`);
  const pre = run(["hook", "precompact"], JSON.stringify({ session_id: "abc12345", transcript_path: tx, cwd: "/x/app" }));
  assert.equal(pre.status, 0);
  const list = spawnSync("git", ["-C", join(home, "vault"), "log", "--format=%s"], { encoding: "utf8" }).stdout;
  assert.match(list, /precompact sessions\//, "the checkpoint reached the vault through the lazily loaded brain");
  // and the MCP server answers over stdio
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "serve"], env, stderr: "ignore" }));
  assert.equal((await client.listTools()).tools.length, 8);
  await client.close();
});

// Windows-style paths, checked on every platform (the Windows CI job is informational only; see docs/platforms.md)
test("hooks understand Windows paths: project name, changed files, steering", async () => {
  const home = await mkdtemp(join(tmpdir(), "r6w-"));
  const script = `process.env.GITHIPPO_HOME = ${JSON.stringify(home)};
    const h = await import(${JSON.stringify(pathToFileURL(join(SRC, "hooks.js")).href)});
    const win = "C:\\\\Users\\\\me\\\\My App";
    const ck = ["## Files changed", "- C:\\\\Users\\\\me\\\\app\\\\src\\\\a.js (2 edits)", "- /home/me/app/b.js", "- C:/Users/me/app/c.js"].join("\\n");
    console.log(JSON.stringify({
      seg: [h.lastSegment("C:\\\\Users\\\\me\\\\app"), h.lastSegment("/home/me/app/"), h.lastSegment("D:/work/proj"), h.lastSegment("")],
      keyWin: h.projectKey("C:\\\\Users\\\\me\\\\app").split("-")[0],
      keyPosix: h.projectKey("/home/me/app").split("-")[0],
      keyDiffers: h.projectKey("C:\\\\a\\\\app") !== h.projectKey("C:\\\\b\\\\app"),
      files: h.checkpointFiles(ck, "C:\\\\Users\\\\me\\\\app"),
      filesPosix: h.checkpointFiles(ck, "/home/me/app"),
      steer: h.steering({ todos: [], files: new Map([["C:\\\\Users\\\\me\\\\app\\\\src\\\\a.js", 2]]), errors: [], prompts: [] }),
    }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.seg, ["app", "app", "proj", ""]);
  assert.equal(out.keyWin, "app", "a Windows cwd is named by its last folder, not by the whole path");
  assert.equal(out.keyPosix, "app");
  assert.ok(out.keyDiffers, "two folders called app still get different keys");
  assert.deepEqual(out.files, ["C:\\Users\\me\\app\\src\\a.js"]);
  assert.deepEqual(out.filesPosix, ["/home/me/app/b.js"]);
  assert.match(out.steer, /Files changed: src\/a\.js/);
});
