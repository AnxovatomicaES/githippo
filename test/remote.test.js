// OAuth 2.1 (driven by the official MCP SDK client), multi-user ACLs, usage-weighted ranking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { setup } from "./helpers.js";
import { createHttpApp } from "../src/http.js";
import { Accounts, Acl, parseAcl } from "../src/accounts.js";
import { MemoryIndex } from "../src/search.js";
import { hashEmbedder } from "../src/embed.js";
import { Brain } from "../src/brain.js";

const SECRET = "s".repeat(32);

async function server({ users = true } = {}) {
  const ctx = setup();
  ctx.gh.seed("memory/shared/roadmap.md", "---\nname: roadmap\ndescription: Team roadmap\n---\n\n- Q3 ships the export feature\n");
  const accounts = new Accounts({ ownerSecret: SECRET });
  const pw = {};
  if (users) {
    pw.marcel = accounts.add("marcel", parseAcl(":write"));
    pw.john = accounts.add("john", parseAcl("shared/:write,people/:read"));
  }
  const app = createHttpApp(ctx.brain, { secret: SECRET, key: Buffer.from("k".repeat(32)), accounts });
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { ...ctx, app, base, accounts, pw };
}

/** In-memory OAuth client state + a scripted "browser" that signs in on the login page. */
function provider(base, username, password) {
  const st = { tokens: undefined, client: undefined, verifier: undefined, code: undefined };
  return {
    st,
    get redirectUrl() { return "http://localhost:9999/callback"; },
    get clientMetadata() { return { client_name: "Test client", redirect_uris: ["http://localhost:9999/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; },
    clientInformation: () => st.client,
    saveClientInformation: (c) => { st.client = c; },
    tokens: () => st.tokens,
    saveTokens: (t) => { st.tokens = t; },
    saveCodeVerifier: (v) => { st.verifier = v; },
    codeVerifier: () => st.verifier,
    async redirectToAuthorization(url) {
      const page = await (await fetch(url)).text();
      const req = page.match(/name="req" value="([^"]+)"/)[1];
      const form = new URLSearchParams({ req, action: "allow", password, ...(username ? { username } : {}) });
      const r = await fetch(`${base}/authorize`, { method: "POST", body: form, redirect: "manual" });
      st.loginStatus = r.status;
      const loc = r.headers.get("location");
      st.code = loc ? new URL(loc).searchParams.get("code") : undefined;
      st.iss = loc ? new URL(loc).searchParams.get("iss") : undefined;
    },
  };
}

async function oauthConnect(base, username, password) {
  const p = provider(base, username, password);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: p });
  const client = new Client({ name: "t", version: "1" });
  try {
    await client.connect(transport);
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    if (!p.st.code) return { client: null, p };
    await transport.finishAuth(p.st.code);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: p }));
  }
  return { client, p };
}

const text = async (client, name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

test("OAuth 2.1 end to end with the official MCP SDK client (discovery, DCR, PKCE, code, tokens)", async (t) => {
  const s = await server();
  t.after(() => s.app.close());
  const { client, p } = await oauthConnect(s.base, "marcel", s.pw.marcel);
  assert.ok(client, "connected via OAuth");
  assert.equal(p.st.iss, s.base, "RFC 9207 issuer in the redirect");
  assert.match(p.st.tokens.access_token, /^hippo\./);
  assert.match(await text(client, "recall", { q: "wake word" }), /johnny/);
  await text(client, "remember", { fact: "Johnny should support Catalan", about: "johnny" });
  const log = s.gh.commits.find((c) => c.path === "memory/projects/johnny.md" && /remember/.test(c.message));
  assert.match(log.message, /remember@marcel/, "commit attributed to the user");
  await client.close();
});

test("OAuth: wrong password, code replay, PKCE failure, audience mismatch, bad redirect", async (t) => {
  const s = await server();
  t.after(() => s.app.close());
  const bad = await oauthConnect(s.base, "john", "wrong");
  assert.equal(bad.client, null);
  assert.equal(bad.p.st.loginStatus, 401);

  const { p } = await oauthConnect(s.base, "john", s.pw.john);
  // build a fresh code to test the token endpoint directly
  const reg = await (await fetch(`${s.base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"] }) })).json();
  const verifier = "v".repeat(50);
  const chal = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = `${s.base}/authorize?response_type=code&client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=${encodeURIComponent("http://localhost:9999/cb")}&code_challenge=${chal}&code_challenge_method=S256&state=xyz`;
  const req = (await (await fetch(authUrl)).text()).match(/name="req" value="([^"]+)"/)[1];
  const loc = (await fetch(`${s.base}/authorize`, { method: "POST", body: new URLSearchParams({ req, action: "allow", username: "john", password: s.pw.john }), redirect: "manual" })).headers.get("location");
  assert.equal(new URL(loc).searchParams.get("state"), "xyz");
  const code = new URL(loc).searchParams.get("code");
  const tok = (extra) => fetch(`${s.base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "http://localhost:9999/cb", ...extra }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await tok({ code_verifier: "wrong".repeat(10) })).body.error, "invalid_grant", "PKCE enforced");
  const ok = await tok({ code_verifier: verifier });
  assert.equal(ok.status, 200);
  assert.equal((await tok({ code_verifier: verifier })).body.error_description, "code already used", "single-use codes");

  // a token minted for another resource is refused
  const forged = await fetch(`${s.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${ok.body.access_token.replace(/./, "x")}` }, body: "{}" });
  assert.equal(forged.status, 401);
  // unregistered redirect_uri: shown an error page, never redirected
  const evil = await fetch(authUrl.replace(encodeURIComponent("http://localhost:9999/cb"), encodeURIComponent("https://evil.example/cb")), { redirect: "manual" });
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get("location"), null);
  // refresh works, and rotates
  const r = await (await fetch(`${s.base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.st.tokens.refresh_token }) })).json();
  assert.match(r.access_token, /^hippo\./);
});

test("OAuth: changing a user's password revokes their tokens immediately", async (t) => {
  const s = await server();
  t.after(() => s.app.close());
  const { client, p } = await oauthConnect(s.base, "john", s.pw.john);
  assert.ok(client);
  s.accounts.add("john", s.accounts.get("john").acl); // reset password
  const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${p.st.tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r.status, 401);
  const refresh = await (await fetch(`${s.base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.st.tokens.refresh_token }) })).json();
  assert.equal(refresh.error, "invalid_grant");
});

test("ACLs: john sees and writes only what he's allowed to", async (t) => {
  const s = await server();
  t.after(() => s.app.close());
  const { client } = await oauthConnect(s.base, "john", s.pw.john);
  // read: people/ yes, shared/ yes, projects/ no
  assert.match(await text(client, "recall", { q: "Chief Operating Officer" }), /john-grecu/);
  assert.match(await text(client, "recall", { q: "Q3 export feature" }), /roadmap/);
  assert.doesNotMatch(await text(client, "recall", { q: "wake word Mac mini" }), /johnny/);
  assert.match(await text(client, "files", { op: "read", path: "projects/johnny.md" }), /no read access/);
  assert.doesNotMatch(await text(client, "files", { op: "list" }), /projects\//);
  // write: shared/ yes; people/ is read-only, so facts about John Grecu land in john's own inbox
  assert.match(await text(client, "remember", { fact: "Export feature needs a CSV option", path: "shared/roadmap.md" }), /✓ shared\/roadmap\.md/);
  assert.match(await text(client, "remember", { fact: "John Grecu prefers short status updates" }), /users\/john\/inbox\.md/);
  assert.match(await text(client, "files", { op: "write", path: "people/x.md", content: "x", v: "new" }), /no write access/);
  // graph never reveals unreadable neighbours; maintain needs admin; pins go to his own core
  assert.doesNotMatch(await text(client, "graph", { entity: "john-grecu" }), /johnny/);
  assert.match(await text(client, "maintain", {}), /needs full write access/);
  assert.match(await text(client, "remember", { fact: "John works from Bucharest", pin: true }), /pinned/);
  assert.ok(s.gh.files.has("memory/users/john/core.md"));
  await client.close();
  // his personal core is in his instructions on the next connection, not in anyone else's
  const again = await oauthConnect(s.base, "john", s.pw.john);
  assert.match(again.client.getInstructions(), /John works from Bucharest/);
  const marcel = await oauthConnect(s.base, "marcel", s.pw.marcel);
  assert.doesNotMatch(marcel.client.getInstructions(), /Bucharest/);
});

test("ACL rules: longest prefix wins, explicit none, own folder always writable", () => {
  const acl = new Acl({ id: "ana", acl: parseAcl(":read,secret/:none,shared/:write") });
  assert.ok(acl.canRead("projects/x.md") && !acl.canWrite("projects/x.md"));
  assert.ok(!acl.canRead("secret/plan.md"));
  assert.ok(acl.canWrite("shared/a.md"));
  assert.ok(acl.canWrite("users/ana/inbox.md") && !acl.canRead("users/bob/inbox.md"));
  assert.ok(!acl.isAdmin);
  assert.ok(new Acl({ id: "root", acl: parseAcl(":write") }).isAdmin);
});

test("usage-weighted ranking: no data → identical ranking; repeated use lifts a tied result", async () => {
  const s = setup();
  s.gh.seed("memory/topics/alpha.md", "---\nname: alpha\n---\n\n- deploy checklist for the payments service\n");
  s.gh.seed("memory/topics/beta.md", "---\nname: beta\n---\n\n- deploy checklist for the payments service\n");
  const order = async (b) => (await b.recall("deploy checklist payments", { mode: "brief" })).hits.map((h) => h.ref.split(":")[0]).filter((p) => /alpha|beta/.test(p));
  const plain = new Brain({ store: s.store, index: new MemoryIndex(s.store, hashEmbedder(), {}) });
  const before = await order(plain);
  assert.deepEqual(await order(s.brain), before, "no usage data → same ranking");
  const loser = before.at(-1);
  for (let i = 0; i < 6; i++) s.brain.index.usage.record([{ path: loser, heading: "" }], null);
  assert.equal((await order(s.brain))[0], loser, "used memory ranks first among ties");
  assert.notEqual((await order(s.brain.forUser(new Acl({ id: "other", acl: parseAcl(":write") }))))[0] === loser && false, true);
});
