// Regressions for the second external test report (one test per finding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers.js";
import { FileStore } from "../src/filestore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { Accounts, parseAcl } from "../src/accounts.js";
import { createHttpApp } from "../src/http.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const vault = async () => { const dir = await mkdtemp(join(tmpdir(), "r2-")); const store = await new FileStore({ dir, autoPush: false }).ensure(); return { dir, store, brain: new Brain({ store, index: new MemoryIndex(store, null, {}) }) }; };
const cli = (args, env = {}) => { try { return { code: 0, out: execFileSync("node", [CLI, ...args], { env: { ...process.env, ...env }, stdio: "pipe" }).toString() }; } catch (e) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) }; } };

test("HIGH revoking a user takes effect on the running server's next request", async (t) => {
  const h = await mkdtemp(join(tmpdir(), "rev-"));
  const file = join(h, "users.json");
  const acc = new Accounts({ ownerSecret: "s".repeat(32), file });
  const pw = acc.add("john", parseAcl("shared/:write"));
  acc.save();
  const { brain } = setup();
  const app = createHttpApp(brain, { secret: "s".repeat(32), key: Buffer.from("k".repeat(32)), accounts: Accounts.load({ env: {}, file }) });
  await new Promise((r) => app.listen(0, r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"] }) })).json();
  const verifier = "v".repeat(50);
  const chal = createHash("sha256").update(verifier).digest("base64url");
  const page = await (await fetch(`${base}/authorize?response_type=code&client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=${encodeURIComponent("http://localhost:9/cb")}&code_challenge=${chal}&code_challenge_method=S256`)).text();
  const req = page.match(/name="req" value="([^"]+)"/)[1];
  const loc = (await fetch(`${base}/authorize`, { method: "POST", body: new URLSearchParams({ req, action: "allow", username: "john", password: pw }), redirect: "manual" })).headers.get("location");
  const tok = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(loc).searchParams.get("code"), client_id: reg.client_id, redirect_uri: "http://localhost:9/cb", code_verifier: verifier }) })).json();
  const call = () => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((r) => r.status);
  assert.equal(await call(), 200);
  await new Promise((r) => setTimeout(r, 20)); // distinct mtime
  const disk = Accounts.load({ env: {}, file });
  disk.remove("john");
  disk.save();
  assert.equal(await call(), 401, "token rejected without a restart");
  const refreshed = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }) })).json();
  assert.equal(refreshed.error, "invalid_grant");
});

test("MEDIUM PreCompact's compaction text never contains raw secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-"));
  process.env.GITHIPPO_HOME = dir;
  const { preCompact } = await import("../src/hooks.js");
  const tp = join(dir, "t.jsonl");
  await writeFile(tp, JSON.stringify({ type: "user", cwd: "/x/app", message: { content: "Deploy with sk-ant-api03-" + "z".repeat(30) } }));
  const out = await preCompact({ session_id: "s", transcript_path: tp, cwd: "/x/app" });
  assert.doesNotMatch(out, /sk-ant-api03-z/);
  assert.match(out, /redacted:anthropic_key/);
});

test("MEDIUM users add needs an id and an explicit --acl; list survives bad entries", async () => {
  const h = await mkdtemp(join(tmpdir(), "u-"));
  const env = { GITHIPPO_HOME: h };
  assert.equal(cli(["users", "add", "bob"], env).code, 1, "no implicit admin");
  assert.equal(cli(["users", "add"], env).code, 1, "no id → usage");
  assert.equal(cli(["users", "add", "--acl", ":read"], env).code, 1, "flag isn't an id");
  await writeFile(join(h, "users.json"), JSON.stringify({ users: [{ id: undefined }, { id: "ok", hash: "x", acl: [] }, null] }));
  const l = cli(["users", "list"], env);
  assert.equal(l.code, 0);
  assert.match(l.out, /^ok\b/m);
});

test("MEDIUM a second server sees the first one's writes immediately (no stale misses or duplicates)", async () => {
  const { dir, brain: a } = await vault();
  const s2 = new FileStore({ dir, autoPush: false });
  const b = new Brain({ store: s2, index: new MemoryIndex(s2, null, {}) });
  await b.recall("anything");
  await a.remember("Priya owns the warehouse migration", { about: "Priya Raman", kind: "person" });
  assert.ok((await b.recall("warehouse migration owner", { mode: "brief" })).hits.length);
  assert.equal((await b.remember("Priya owns the warehouse migration", { about: "Priya Raman" })).status, "duplicate");
});

test("MEDIUM the same fact about two entities is saved for both", async () => {
  const { brain } = await vault();
  await brain.remember("Prefers written RFCs over meetings", { about: "Sam Okafor", kind: "person" });
  const r = await brain.remember("Prefers written RFCs over meetings", { about: "Priya Raman", kind: "person" });
  assert.equal(r.status, "saved");
  assert.equal(r.path, "people/priya-raman.md");
  // but a fact headed for the inbox that another note already knows is still a duplicate
  await brain.remember("Likes jazz while coding");
  assert.equal((await brain.remember("Likes jazz while coding")).status, "duplicate");
});

test("LOW readable errors, no stack traces; --help exits 0", async () => {
  const env = { GITHIPPO_HOME: await mkdtemp(join(tmpdir(), "e-")) };
  for (const args of [["users", "add", "x", "--acl", "shared/:superuser"], ["import", "/nope.jsonl"]]) {
    const r = cli(args, env);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.err, /\n\s+at /, args.join(" "));
    assert.match(r.err, /^githippo \w+: /);
  }
  assert.match(cli(["import", "/nope.jsonl"], env).err, /file not found: \/nope\.jsonl/);
  for (const h of ["--help", "-h", "help"]) assert.equal(cli([h]).code, 0, h);
});

test("LOW control characters (NUL etc.) are never stored", async () => {
  const { brain, store } = await vault();
  const r = await brain.remember("Johnny\u0000 has a\u0007 bell", { about: "Johnny" });
  assert.doesNotMatch((await store.read(r.path)).content, /[\u0000\u0007]/);
});

test("LOW a write made while git is busy for long still gets committed without another write", async () => {
  const { dir, store } = await vault();
  await writeFile(join(dir, ".git", "index.lock"), "");
  setTimeout(() => execFileSync("rm", ["-f", join(dir, ".git", "index.lock")]), 8000);
  const t0 = Date.now();
  const r = await store.write("x.md", "- held lock\n", "new");
  assert.ok(Date.now() - t0 < 5000, `write blocked for ${Date.now() - t0} ms`);
  assert.equal(r.committed, false, "the write says it isn't committed yet");
  const log = () => execFileSync("git", ["-C", dir, "log", "--format=%s"]).toString();
  for (let i = 0; i < 15 && !log().includes("memory: write x.md"); i++) await new Promise((res) => setTimeout(res, 1000));
  assert.match(log(), /memory: write x\.md/);
});

test("LOW plain checkpoint resumes the most recent session, not just 'default'", async () => {
  const { brain } = await vault();
  await brain.checkpoint({ session: "old", task: "Old work" });
  await new Promise((r) => setTimeout(r, 15));
  await brain.checkpoint({ session: "deck", task: "Build the deck" });
  const r = await brain.checkpoint({});
  assert.equal(r.status, "resume");
  assert.match(r.checkpoint, /Build the deck/);
  assert.match(r.checkpoint, /other sessions: old/);
});
