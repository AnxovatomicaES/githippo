import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setup } from "./helpers.js";
import { createHttpApp } from "../src/http.js";

const SECRET = "s".repeat(32);

async function start() {
  const ctx = setup();
  await ctx.brain.loadCore();
  const app = createHttpApp(ctx.brain, { secret: SECRET });
  await new Promise((r) => app.listen(0, r));
  return { ...ctx, app, base: `http://127.0.0.1:${app.address().port}` };
}

test("auth: rejects missing/wrong secret", async () => {
  const { app, base } = await start();
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/mcp/${"x".repeat(32)}`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  app.close();
});

test("remote round trip: core in instructions, compact tools, guard", async () => {
  const { app, base, gh } = await start();
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`)));
  assert.match(client.getInstructions(), /CORE MEMORY[\s\S]*Marcel, CTO/);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["recall", "remember", "forget", "graph", "history", "checkpoint", "maintain", "files"]);
  assert.ok(tools.every((t) => !t.inputSchema.$schema));

  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  assert.match(await call("remember", { fact: "Johnny should support Spanish and English", about: "johnny" }), /^✓ projects\/johnny\.md/);
  assert.match(gh.text("memory/projects/johnny.md"), /Spanish and English/);
  assert.match(await call("recall", { q: "languages Johnny supports" }), /Spanish and English/);
  assert.match(await call("graph", { entity: "johnny" }), /johnny -sponsor→ john-grecu/);
  assert.match(await call("remember", { fact: "card 4111 1111 1111 1111" }), /^ERROR: Blocked by compliance guard: payment_card/);
  assert.match(await call("files", { op: "list" }), /core\.md [0-9a-f]{8}/);
  await client.close();
  app.close();
});
