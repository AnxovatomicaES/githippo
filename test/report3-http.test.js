// Third external report: HTTP server crashes, rate limiting, OAuth refresh rotation, ACL boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers.js";
import { createHttpApp } from "../src/http.js";
import { Accounts, Acl, parseAcl } from "../src/accounts.js";

const SECRET = "s".repeat(32);
const KEY = Buffer.from("k".repeat(32));

async function start(opts = {}, { users = false } = {}) {
  const ctx = setup();
  const accounts = new Accounts({ ownerSecret: SECRET });
  const pw = users ? accounts.add("john", parseAcl("shared/:write")) : null;
  const app = createHttpApp(ctx.brain, { secret: SECRET, key: KEY, accounts, ...opts });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  return { ...ctx, app, accounts, pw, port, base: `http://127.0.0.1:${port}`, close: () => app.close() };
}
const raw = (port, text) =>
  new Promise((res) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(text));
    let data = "";
    c.on("data", (d) => (data += d));
    c.on("close", () => res(data));
    c.on("error", () => res(data));
    setTimeout(() => (c.destroy(), res(data)), 500);
  });
const healthy = async (s) => (await fetch(`${s.base}/health`)).ok;
const rpc = (s, headers = {}, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) =>
  fetch(`${s.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

test("CRITICAL: null / array / scalar JSON bodies to the OAuth endpoints never crash the server", async (t) => {
  const s = await start();
  t.after(() => s.close());
  for (const ep of ["/register", "/token", "/authorize"]) {
    for (const body of ["null", "[]", "5", '"x"', "true", "{}", '{"redirect_uris":null}', '{"redirect_uris":"x"}']) {
      const r = await fetch(`${s.base}${ep}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.ok(r.status < 500, `${ep} ${body} → ${r.status}`);
    }
  }
  assert.ok(await healthy(s));
});

test("CRITICAL: malformed request lines get a 400 and the server keeps running", async (t) => {
  const s = await start();
  t.after(() => s.close());
  for (const line of ["GET //[ HTTP/1.1", "GET http://[::1 HTTP/1.1", "GET /%E0%A4%A HTTP/1.1", "GET http://%zz/ HTTP/1.1", "GET \u0000 HTTP/1.1", "GARBAGE", "GET /" + "a".repeat(100_000) + " HTTP/1.1"]) {
    const reply = await raw(s.port, `${line}\r\nHost: x\r\n\r\n`);
    assert.ok(!reply || /^HTTP\/1\.1 (400|404|414|431)/.test(reply), `${JSON.stringify(line.slice(0, 30))} → ${reply.slice(0, 30)}`);
    assert.ok(await healthy(s), `still healthy after ${JSON.stringify(line.slice(0, 30))}`);
  }
});

test("odd paths are 404/400, never 5xx; POST /health with a large body is answered, not reset", async (t) => {
  const s = await start();
  t.after(() => s.close());
  for (const p of ["//mcp", "/mcp/../x", "/mcp%2f", "/MCP", "/.well-known/oauth-protected-resource/%00", "/mcp//", "/health/", "/authorize?client_id[]=x", "/authorize?%", "/token", "/register"]) {
    const reply = await raw(s.port, `GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.ok(!/^HTTP\/1\.1 5/.test(reply), `${p} → ${reply.slice(0, 20)}`);
  }
  const r = await fetch(`${s.base}/health`, { method: "POST", body: "x".repeat(3_000_000) });
  assert.equal(r.status, 200);
  assert.ok(await healthy(s));
});

test("rate limits key on the socket address: rotating X-Forwarded-For doesn't help (unless TRUST_PROXY, then the proxy's right-most entry)", async (t) => {
  const a = await start({ ratePerMinute: 3 });
  t.after(() => a.close());
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await rpc(a, { "x-forwarded-for": `10.0.0.${i}` })).status);
  assert.ok(codes.includes(429), `spoofed XFF must not reset the limit: ${codes}`);

  const b = await start({ ratePerMinute: 3, trustProxy: true });
  t.after(() => b.close());
  const same = [];
  for (let i = 0; i < 8; i++) same.push((await rpc(b, { "x-forwarded-for": `1.1.1.${i}, 9.9.9.9` })).status); // client rotates the left; proxy appended 9.9.9.9
  assert.ok(same.includes(429), "same proxy-observed client is limited");
  const different = [];
  for (let i = 0; i < 4; i++) different.push((await rpc(b, { "x-forwarded-for": `1.1.1.1, 8.8.8.${i}` })).status);
  assert.ok(!different.includes(429), "different proxy-observed clients get their own bucket");
});

test("a JSON-RPC batch costs one unit per call and is capped", async (t) => {
  const s = await start({ ratePerMinute: 10, maxBatch: 25 });
  t.after(() => s.close());
  const batch = (n) => [...Array(n)].map((_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }));
  assert.notEqual((await rpc(s, {}, batch(8))).status, 429, "8 calls fit in 10");
  assert.equal((await rpc(s, {}, batch(8))).status, 429, "16 > 10 within a minute");
  const big = await start({ ratePerMinute: 1000, maxBatch: 25 });
  t.after(() => big.close());
  assert.equal((await rpc(big, {}, batch(26))).status, 400, "batch over the cap is refused");
  assert.equal((await rpc(big, {}, [])).status, 400, "empty batch is invalid");
  assert.equal((await rpc(big, {}, [null])).status, 400, "non-object call is invalid");
});

test("repeated failed logins from one address are throttled before any credential work", async (t) => {
  const s = await start({ ratePerMinute: 1000 });
  t.after(() => s.close());
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await fetch(`${s.base}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" })).status);
  assert.equal(codes[0], 401);
  assert.ok(codes.includes(429), "throttled after 30 failures");
  assert.equal((await rpc(s)).status, 429, "even the right secret waits out the throttle (same address)");
});

// ---------- OAuth refresh rotation ----------
async function signIn(s, redirect = "http://localhost:9/cb") {
  const reg = await (await fetch(`${s.base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json();
  const verifier = "v".repeat(50);
  const chal = createHash("sha256").update(verifier).digest("base64url");
  const page = await (await fetch(`${s.base}/authorize?response_type=code&client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${chal}&code_challenge_method=S256`)).text();
  const loc = (await fetch(`${s.base}/authorize`, { method: "POST", body: new URLSearchParams({ req: page.match(/name="req" value="([^"]+)"/)[1], action: "allow", username: "john", password: s.pw }), redirect: "manual" })).headers.get("location");
  const code = new URL(loc).searchParams.get("code");
  const exchange = () => fetch(`${s.base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }) }).then((r) => r.json());
  return { code, exchange, tokens: await exchange(), reg };
}
const refresh = (s, t) => fetch(`${s.base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t }) }).then((r) => r.json());
const useAccess = (s, t) => fetch(`${s.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((r) => r.status);

test("refresh tokens are single use; presenting an old one revokes the whole sign-in", async (t) => {
  const s = await start({}, { users: true });
  t.after(() => s.close());
  const { tokens: t0 } = await signIn(s);
  const t1 = await refresh(s, t0.refresh_token);
  assert.ok(t1.access_token && t1.refresh_token && t1.refresh_token !== t0.refresh_token, "rotation issues a new refresh token");
  assert.equal(await useAccess(s, t1.access_token), 200);
  const replay = await refresh(s, t0.refresh_token); // an attacker (or a buggy client) replays the spent token
  assert.equal(replay.error, "invalid_grant");
  assert.match(replay.error_description, /already used/);
  assert.equal((await refresh(s, t1.refresh_token)).error, "invalid_grant", "the newest refresh token died with the family");
  assert.equal(await useAccess(s, t1.access_token), 401, "so did its access token");
  assert.equal(await useAccess(s, t0.access_token), 401);
});

test("a reused authorization code revokes the tokens it already produced", async (t) => {
  const s = await start({}, { users: true });
  t.after(() => s.close());
  const { tokens, exchange } = await signIn(s);
  assert.equal(await useAccess(s, tokens.access_token), 200);
  assert.equal((await exchange()).error, "invalid_grant");
  assert.equal(await useAccess(s, tokens.access_token), 401);
  assert.equal((await refresh(s, tokens.refresh_token)).error, "invalid_grant");
});

test("reuse detection survives a restart (state file)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-"));
  const stateFile = join(dir, "state.json");
  const s1 = await start({ stateFile }, { users: true });
  const { tokens: t0 } = await signIn(s1);
  const t1 = await refresh(s1, t0.refresh_token);
  assert.ok(t1.access_token);
  await new Promise((r) => setTimeout(r, 500)); // state is flushed after 200 ms
  assert.ok(JSON.parse(await readFile(stateFile, "utf8")).used);
  s1.close();
  // "restart": a new server with the same signing key, users and state file
  const ctx = setup();
  const app = createHttpApp(ctx.brain, { secret: SECRET, key: KEY, accounts: s1.accounts, stateFile });
  await new Promise((r) => app.listen(0, r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const replay = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t0.refresh_token }) }).then((r) => r.json());
  assert.equal(replay.error, "invalid_grant", "the spent token is still spent after the restart");
});

// ---------- ACL boundaries ----------
test("ACL rules are folders or exact notes, never string prefixes", () => {
  const a = new Acl({ id: "ali", acl: parseAcl("shared:read,users/ali:read,people/ada.md:write,secret/:none,:read") });
  assert.ok(a.canRead("shared/x.md"));
  assert.ok(!a.canRead("shared-secret/plan.md") || a.canRead("shared-secret/plan.md") === a.canRead("zzz/other.md"), "falls through to the catch-all, not to the shared rule");
  const b = new Acl({ id: "ali", acl: parseAcl("shared:read,users/ali:read,people/ada.md:write") });
  assert.ok(!b.canRead("shared-secret/plan.md"), "'shared:read' is the folder shared/");
  assert.ok(!b.canRead("users/alice/x.md"), "'users/ali:read' is the folder users/ali/");
  assert.ok(b.canWrite("people/ada.md") && !b.canRead("people/ada.md.bak.md") && !b.canRead("people/adam.md"), "an exact-note rule matches only that note");
  assert.ok(b.canWrite("users/ali/inbox.md"), "your own home stays writable even if a rule says read");
  assert.ok(!new Acl({ id: "ali", acl: parseAcl(":read") }).canRead("users/alice/x.md"), "a catch-all never opens another user's private folder");
});
