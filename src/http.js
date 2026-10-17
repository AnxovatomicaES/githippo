// Remote transport: Streamable HTTP for claude.ai custom connectors and the
// mobile apps. Stateless: a fresh MCP server per request, shared brain/index.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";

const safeEqual = (a, b) => {
  const A = Buffer.from(a || "");
  const B = Buffer.from(b || "");
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
};

export function createHttpApp(brain, { secret, maxBodyBytes = 1_000_000, ratePerMinute = 120 } = {}) {
  if (!secret || secret.length < 24) throw new Error("MCP_SECRET must be set (24+ chars). Try: openssl rand -hex 32");
  const hits = new Map();
  let coreAt = 0;
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
    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!m) return send(res, 404, { error: "not found" });
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!safeEqual(m[1], secret) && !safeEqual(bearer, secret)) return send(res, 401, { error: "unauthorized" });
    // B18: the left-most X-Forwarded-For entry is client-controlled; the right-most was added by our proxy.
    const ip = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean).at(-1) || req.socket.remoteAddress;
    if (limited(ip)) return send(res, 429, { error: "rate limited" });
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
    // Keep pinned core fresh for new connections (it's baked into the instructions).
    if (body?.method === "initialize" && Date.now() - coreAt > 60_000) {
      coreAt = Date.now();
      await brain.loadCore().catch(() => {});
    }
    const server = buildServer(brain);
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
