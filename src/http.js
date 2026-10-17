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
 */
export function createHttpApp(brain, { secret, key, accounts = new Accounts({ ownerSecret: secret }), publicUrl = null, legacySecretUrl = false, maxBodyBytes = 1_000_000, ratePerMinute = 120 } = {}) {
  if (!secret || secret.length < 24) throw new Error("MCP_SECRET must be set (24+ chars). Try: openssl rand -hex 32");
  const oauth = createOAuth({ accounts, key: key || Buffer.from(secret), publicUrl });
  const hits = new Map();
  let sweep = 0;
  const limited = (ip) => {
    const now = Date.now();
    const w = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    w.push(now);
    hits.set(ip, w);
    // B18: forget idle clients so the map can't grow without bound
    if (++sweep % 500 === 0) for (const [k, v] of hits) if (!v.length || now - v.at(-1) > 60_000) hits.delete(k);
    return w.length > ratePerMinute;
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (await oauth.handle(req, res, url)) return;
    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!m) return send(res, 404, { error: "not found" });
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    let user = oauth.verifyBearer(req);
    if (!user && !accounts.multiUser && (safeEqual(bearer, secret) || (legacySecretUrl && safeEqual(m[1], secret)))) user = accounts.get("owner") || { id: "owner", acl: [{ path: "", access: "write" }] };
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": oauth.challenge(req) });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    // B18: the left-most X-Forwarded-For entry is client-controlled; the right-most was added by our proxy.
    const ip = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean).at(-1) || req.socket.remoteAddress;
    if (limited(`${user.id}|${ip}`)) return send(res, 429, { error: "rate limited" });
    if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });

    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > maxBodyBytes) return send(res, 413, { error: "payload too large" });
      chunks.push(c);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    // Every request runs as its user: their ACL, their core memory, commits attributed to them.
    const acl = new Acl(user);
    const view = brain.forUser(acl.isAdmin && user.id === "owner" ? null : acl);
    // Instructions (which carry core memory) are only sent in the initialize response: load core then, fresh.
    if (body?.method === "initialize" || (Array.isArray(body) && body.some((m) => m?.method === "initialize"))) await view.loadCore().catch(() => {});
    const server = buildServer(view);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("[githippo] request failed:", e);
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
}
