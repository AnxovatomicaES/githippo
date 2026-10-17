// OAuth 2.1 authorization server + resource-server checks for remote githippo (MCP authorization spec):
//   RFC 9728 protected-resource metadata · RFC 8414 AS metadata · RFC 7591 dynamic client registration ·
//   authorization code + PKCE (S256 only) · RFC 8707 resource indicators (audience-bound tokens) ·
//   refresh-token rotation.
// Stateless by design (hosts like Render restart at will): client ids, codes and tokens are HMAC-signed
// blobs, so nothing needs storing. Codes are single-use (in-memory replay set, 60 s lifetime). Tokens are
// bound to the user's current password+ACL version, so changing either revokes them immediately.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const b64 = (b) => Buffer.from(b).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 60;
const REQ_TTL = 600;

export function signingKey(env = process.env) {
  if (env.OAUTH_SIGNING_KEY) return Buffer.from(env.OAUTH_SIGNING_KEY);
  if (!env.MCP_SECRET) throw new Error("Set MCP_SECRET (or OAUTH_SIGNING_KEY) to enable OAuth.");
  return Buffer.from(hkdfSync("sha256", env.MCP_SECRET, "githippo", "oauth-signing-v1", 32));
}

export function createOAuth({ accounts, key, publicUrl = null, loginRatePerMin = 10 }) {
  const sign = (kind, payload) => {
    const body = b64(JSON.stringify({ k: kind, ...payload }));
    return `hippo.${body}.${b64(createHmac("sha256", key).update(`${kind}.${body}`).digest())}`;
  };
  const open = (kind, token) => {
    const [pfx, body, sig] = String(token || "").split(".");
    if (pfx !== "hippo" || !body || !sig) return null;
    const want = createHmac("sha256", key).update(`${kind}.${body}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString());
      return p.k === kind && (!p.exp || p.exp > now()) ? p : null;
    } catch {
      return null;
    }
  };

  const usedCodes = new Map();
  const logins = new Map();
  const base = (req) => (publicUrl || `${req.headers["x-forwarded-proto"]?.split(",")[0] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`).replace(/\/+$/, "");
  const resourceOf = (req) => `${base(req)}/mcp`;

  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", ...extra });
    res.end(JSON.stringify(body));
  };
  const oauthError = (res, status, error, error_description) => json(res, status, { error, error_description });
  const readBody = async (req) => {
    let s = "";
    for await (const c of req) {
      s += c;
      if (s.length > 64_000) break;
    }
    if (/json/.test(req.headers["content-type"] || "")) {
      try {
        return JSON.parse(s);
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(s));
  };
  const validRedirect = (u) => {
    try {
      const x = new URL(u);
      if (x.hash) return false;
      return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname));
    } catch {
      return false;
    }
  };
  const tooManyLogins = (ip) => {
    const t = Date.now();
    const w = (logins.get(ip) || []).filter((x) => t - x < 60_000);
    w.push(t);
    logins.set(ip, w);
    if (logins.size > 5000) for (const [k, v] of logins) if (!v.length || t - v.at(-1) > 60_000) logins.delete(k);
    return w.length > loginRatePerMin;
  };
  const issue = (user, cid, aud, scope) => {
    const uv = accounts.version(user);
    return {
      access_token: sign("access", { sub: user.id, cid, aud, scope, uv, exp: now() + ACCESS_TTL }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: sign("refresh", { sub: user.id, cid, aud, scope, uv, jti: b64(randomBytes(9)), exp: now() + REFRESH_TTL }),
      scope,
    };
  };

  async function handle(req, res, url) {
    const path = url.pathname;
    if (req.method === "OPTIONS" && /^\/(\.well-known|register|token)/.test(path)) {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version" });
      res.end();
      return true;
    }
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, { resource: resourceOf(req), authorization_servers: [base(req)], scopes_supported: ["memory"], bearer_methods_supported: ["header"], resource_name: "githippo memory" });
      return true;
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      const b = base(req);
      json(res, 200, {
        issuer: b,
        authorization_endpoint: `${b}/authorize`,
        token_endpoint: `${b}/token`,
        registration_endpoint: `${b}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["memory"],
      });
      return true;
    }
    if (path === "/register" && req.method === "POST") {
      const b = await readBody(req);
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
      if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https (or http on localhost)"), true;
      const name = String(b.client_name || "MCP client").replace(/[<>&"']/g, "").slice(0, 80);
      const client_id = sign("client", { r: uris, n: name, iat: now() });
      json(res, 201, { client_id, client_id_issued_at: now(), client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
      return true;
    }
    if (path === "/authorize" && req.method === "GET") {
      const q = Object.fromEntries(url.searchParams);
      const client = open("client", q.client_id);
      // never redirect to an unverified URI: errors before validation are shown, not redirected
      if (!client) return page(res, 400, "Unknown application", "This sign-in link isn't valid. Start again from your app."), true;
      if (!client.r.includes(q.redirect_uri)) return page(res, 400, "Unknown redirect", "This sign-in link isn't valid. Start again from your app."), true;
      const back = (error) => redirect(res, q.redirect_uri, { error, state: q.state, iss: base(req) });
      if (q.response_type !== "code") return back("unsupported_response_type"), true;
      if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request"), true;
      const resource = q.resource || resourceOf(req);
      if (resource.replace(/\/+$/, "") !== resourceOf(req)) return back("invalid_target"), true;
      const reqToken = sign("req", { cid: q.client_id, uri: q.redirect_uri, chal: q.code_challenge, st: q.state || "", res: resource, sc: "memory", exp: now() + REQ_TTL });
      loginPage(res, client.n, new URL(q.redirect_uri).host, reqToken, accounts.multiUser);
      return true;
    }
    if (path === "/authorize" && req.method === "POST") {
      const b = await readBody(req);
      const r = open("req", b.req);
      if (!r) return page(res, 400, "This sign-in expired", "Go back to your app and connect again."), true;
      if (b.action !== "allow") return redirect(res, r.uri, { error: "access_denied", state: r.st, iss: base(req) }), true;
      const ip = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean).at(-1) || req.socket.remoteAddress;
      if (tooManyLogins(ip)) return page(res, 429, "Too many attempts", "Wait a minute and try again."), true;
      const user = accounts.verify(accounts.multiUser ? b.username : "owner", b.password);
      if (!user) return loginPage(res, open("client", r.cid)?.n || "MCP client", new URL(r.uri).host, b.req, accounts.multiUser, "Wrong username or password."), true;
      const code = sign("code", { cid: r.cid, uri: r.uri, chal: r.chal, res: r.res, sc: r.sc, sub: user.id, jti: b64(randomBytes(12)), exp: now() + CODE_TTL });
      redirect(res, r.uri, { code, state: r.st, iss: base(req) });
      return true;
    }
    if (path === "/token" && req.method === "POST") {
      const b = await readBody(req);
      if (b.grant_type === "authorization_code") {
        const c = open("code", b.code);
        if (!c) return oauthError(res, 400, "invalid_grant", "code is invalid or expired"), true;
        if (usedCodes.has(c.jti)) return oauthError(res, 400, "invalid_grant", "code already used"), true;
        if (b.client_id !== c.cid || b.redirect_uri !== c.uri) return oauthError(res, 400, "invalid_grant", "client_id or redirect_uri mismatch"), true;
        if (b64(createHash("sha256").update(String(b.code_verifier || "")).digest()) !== c.chal) return oauthError(res, 400, "invalid_grant", "PKCE verification failed"), true;
        if (b.resource && b.resource.replace(/\/+$/, "") !== c.res.replace(/\/+$/, "")) return oauthError(res, 400, "invalid_target", "resource mismatch"), true;
        usedCodes.set(c.jti, c.exp);
        for (const [k, exp] of usedCodes) if (exp < now()) usedCodes.delete(k);
        const user = accounts.get(c.sub);
        if (!user) return oauthError(res, 400, "invalid_grant", "user no longer exists"), true;
        json(res, 200, issue(user, c.cid, c.res, c.sc));
        return true;
      }
      if (b.grant_type === "refresh_token") {
        const t = open("refresh", b.refresh_token);
        const user = t && accounts.get(t.sub);
        if (!t || !user || accounts.version(user) !== t.uv || (b.client_id && b.client_id !== t.cid)) return oauthError(res, 400, "invalid_grant", "refresh token is invalid, expired or revoked"), true;
        json(res, 200, issue(user, t.cid, t.aud, t.scope));
        return true;
      }
      oauthError(res, 400, "unsupported_grant_type", "use authorization_code or refresh_token");
      return true;
    }
    return false;
  }

  /** Resource-server check for /mcp. Returns the user or null. */
  function verifyBearer(req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const t = open("access", token);
    if (!t || t.aud.replace(/\/+$/, "") !== resourceOf(req)) return null;
    const user = accounts.get(t.sub);
    return user && accounts.version(user) === t.uv ? user : null;
  }

  const challenge = (req) => `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource/mcp", scope="memory"`;

  return { handle, verifyBearer, challenge, resourceOf };
}

function redirect(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  res.writeHead(302, { Location: u.toString(), "Cache-Control": "no-store" });
  res.end();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const STYLE = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark;--bg:#faf8ff;--fg:#1e1b4b;--muted:#6b6b80;--card:#fff;--line:#ddd6fe;--accent:#7c3aed}@media (prefers-color-scheme:dark){:root{--bg:#0f0a24;--fg:#f5f3ff;--muted:#a1a1aa;--card:#1a1040;--line:#4c1d95;--accent:#a78bfa}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{width:min(380px,92vw);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}label{display:block;font-size:14px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);font-size:16px}.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:11px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:15px;cursor:pointer}button.go{background:var(--accent);border-color:var(--accent);color:#fff}.err{color:#ef4444}</style>`;

function page(res, status, title, text) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
  res.end(`<!doctype html><title>${esc(title)}</title>${STYLE}<main><h1>${esc(title)}</h1><p>${esc(text)}</p></main>`);
}

function loginPage(res, client, host, reqToken, multiUser, error = "") {
  res.writeHead(error ? 401 : 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*" });
  res.end(`<!doctype html><title>Connect to githippo</title>${STYLE}<main><h1>🦛 Connect ${esc(client)}</h1><p>${esc(client)} (${esc(host)}) wants to read and write your githippo memory.</p>${error ? `<p class="err">${esc(error)}</p>` : ""}<form method="post" action="/authorize"><input type="hidden" name="req" value="${esc(reqToken)}">${multiUser ? `<label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>` : ""}<label for="p">${multiUser ? "Password" : "Access secret (MCP_SECRET)"}</label><input id="p" name="password" type="password" autocomplete="current-password" required ${multiUser ? "" : "autofocus"}><div class="row"><button name="action" value="deny" formnovalidate>Deny</button><button class="go" name="action" value="allow">Allow</button></div></form></main>`);
}
