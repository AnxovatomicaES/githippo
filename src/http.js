// Remote transport: Streamable HTTP for claude.ai custom connectors and the
// mobile apps. Stateless: a fresh MCP server per request, shared brain/index.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { createOAuth } from "./oauth.js";
import { Acl, Accounts } from "./accounts.js";

const safeEqual = (a, b) => {
  const A = Buffer.from(a || "");
  const B = Buffer.from(b || "");
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
};

/**
 * Auth, in order of preference:
 *  1. OAuth 2.1 bearer token (claude.ai, the mobile apps, any spec-compliant MCP client): per-user + ACLs.
 *  2. Static secret in the Authorization header, for clients without OAuth: the single owner, full access.
 *  3. Secret in the URL path (/mcp/<secret>): off unless LEGACY_SECRET_URL=1, because URLs end up in logs.
 *
 * Hardening: nothing a client sends can crash the process (every request runs inside a guard, malformed request
 * lines are answered with 400, bodies are validated before use); rate limits key on the socket address (X-Forwarded-For
 * is only honoured with TRUST_PROXY=1, then its right-most entry, the one the proxy appended); a JSON-RPC batch costs
 * one unit per call and is capped; repeated failed logins from one address are throttled before any work is done.
 */
export function createHttpApp(brain, { secret, key, accounts = new Accounts({ ownerSecret: secret }), publicUrl = null, legacySecretUrl = false, maxBodyBytes = 1_000_000, ratePerMinute = 120, maxBatch = 25, trustProxy = process.env.TRUST_PROXY === "1", stateFile = null } = {}) {
  if (!secret || secret.length < 24) throw new Error("MCP_SECRET must be set (24+ chars). Try: openssl rand -hex 32");
  const oauth = createOAuth({ accounts, key: key || Buffer.from(secret), publicUrl, stateFile, trustProxy });
  const windows = new Map();
  let sweep = 0;
  /** Sliding one-minute window; returns true when `cost` more events would exceed `max`. */
  const over = (bucket, max, cost = 1) => {
    const now = Date.now();
    const w = (windows.get(bucket) || []).filter((t) => now - t < 60_000);
    for (let i = 0; i < Math.min(cost, max + 1); i++) w.push(now);
    windows.set(bucket, w);
    if (++sweep % 500 === 0) for (const [k, v] of windows) if (!v.length || now - v.at(-1) > 60_000) windows.delete(k);
    return w.length > max;
  };
  const clientIp = (req) => {
    if (trustProxy) {
      const last = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean).at(-1);
      if (last) return last;
    }
    return req.socket.remoteAddress || "unknown";
  };
  const send = (res, status, body, headers = {}) => {
    if (res.headersSent) return res.end();
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const rpcError = (res, status, code, message) => send(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
  /** Read the request body up to a limit; null means it was too large. */
  const readBody = async (req) => {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > maxBodyBytes) return null;
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return rpcError(res, 400, -32600, "Bad request target");
    }
    const ip = clientIp(req);
    if (url.pathname === "/health") {
      req.resume(); // discard any body so the client isn't reset
      return send(res, 200, { ok: true });
    }
    if (over(`ip|${ip}`, ratePerMinute * 5)) return send(res, 429, { error: "rate limited" }, { "Retry-After": "60" });
    accounts.refresh?.();
    if (await oauth.handle(req, res, url, { ip })) return;
    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!m) {
      req.resume();
      return send(res, 404, { error: "not found" });
    }
    // too many recent failures from this address: refuse before doing any credential work
    if (over(`fail|${ip}`, 30, 0)) return send(res, 429, { error: "too many failed attempts" }, { "Retry-After": "60" });
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    let user = oauth.verifyBearer(req);
    if (!user && !accounts.multiUser && (safeEqual(bearer, secret) || (legacySecretUrl && safeEqual(m[1], secret)))) user = accounts.get("owner") || { id: "owner", acl: [{ path: "", access: "write" }] };
    if (!user) {
      over(`fail|${ip}`, 30, 1);
      req.resume();
      return send(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": oauth.challenge(req) });
    }
    // every authenticated request costs one unit (before the method check, so GETs count too)
    if (over(`user|${user.id}|${ip}`, ratePerMinute, 1)) return send(res, 429, { error: "rate limited" }, { "Retry-After": "60" });
    if (req.method !== "POST") {
      req.resume();
      return rpcError(res, 405, -32000, "Method not allowed.");
    }

    const text = await readBody(req);
    if (text === null) {
      res.setHeader("Connection", "close");
      return send(res, 413, { error: "payload too large" });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return rpcError(res, 400, -32700, "Parse error");
    }
    // JSON-RPC: one request object, or a non-empty batch of them
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.some((c) => !c || typeof c !== "object" || Array.isArray(c))) return rpcError(res, 400, -32600, "Invalid Request");
    if (calls.length > maxBatch) return rpcError(res, 400, -32600, `Batch too large (max ${maxBatch})`);
    // a batch of N calls costs N (one was already counted above)
    if (calls.length > 1 && over(`user|${user.id}|${ip}`, ratePerMinute, calls.length - 1)) return send(res, 429, { error: "rate limited" }, { "Retry-After": "60" });

    // Every request runs as its user: their ACL, their core memory, commits attributed to them.
    const acl = new Acl(user);
    // The unrestricted view is for the single-owner server only. In a multi-user vault even an account called "owner" gets its ACL view:
    // a catch-all rule never opens another user's folder, and read-only carve-outs (isAdmin ignores them) must still apply.
    const view = brain.forUser(!accounts.multiUser && acl.isAdmin && user.id === "owner" ? null : acl);
    // Instructions (which carry core memory) are only sent in the initialize response: load core then, fresh.
    if (calls.some((c) => c.method === "initialize")) await view.loadCore().catch(() => {});
    const server = buildServer(view);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[githippo] request failed:", e?.message || e);
      try {
        if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
        else res.destroy();
      } catch {}
    });
  });
  // a malformed request line or header never reaches the handler: answer it and move on
  server.on("clientError", (err, socket) => {
    if (socket.writable && !socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  server.requestTimeout = 30_000; // slow-loris: a request must complete within 30 s
  server.headersTimeout = 15_000;
  return server;
}
