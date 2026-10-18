// MCP elicitation: the user confirms sensitive memory writes. Driven by the official MCP SDK client, with the
// same capability shape Claude Code declares (`elicitation: {}`).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { setup } from "./helpers.js";
import { buildServer } from "../src/server.js";

afterEach(() => delete process.env.GITHIPPO_CONFIRM);

async function connect({ capabilities = { elicitation: {} }, answer = { action: "accept", content: { approve: true } } } = {}) {
  const s = setup();
  const server = buildServer(s.brain);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" }, { capabilities });
  const asked = [];
  if (capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return typeof answer === "function" ? answer(req.params) : answer;
    });
  }
  await client.connect(b);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  return { ...s, client, call, asked };
}

test("external-source facts ask the user; approving saves, declining/dismissing doesn't", async () => {
  const yes = await connect();
  assert.match(await yes.call("remember", { fact: "Porcupine is a wake word engine", about: "johnny", source: "external" }), /^✓ projects\/johnny\.md/);
  assert.equal(yes.asked.length, 1);
  assert.match(yes.asked[0].message, /EXTERNAL source[\s\S]*Porcupine/);
  assert.equal(yes.asked[0].requestedSchema.properties.approve.type, "boolean");
  assert.match(yes.gh.text("memory/projects/johnny.md"), /src:external/);

  for (const [answer, why] of [[{ action: "decline" }, /declined/], [{ action: "cancel" }, /dismissed/], [{ action: "accept", content: { approve: false } }, /chose not to/]]) {
    const no = await connect({ answer });
    const out = await no.call("remember", { fact: "Some web claim about Johnny", about: "johnny", source: "external" });
    assert.match(out, new RegExp(`^✗ not saved: you .*${why.source}`));
    assert.doesNotMatch(no.gh.text("memory/projects/johnny.md"), /web claim/);
  }
});

test("pin and forget ask too, and forget shows the exact line", async () => {
  const c = await connect();
  assert.match(await c.call("remember", { fact: "Always answer in British English", pin: true }), /^📌 pinned/);
  assert.match(c.asked[0].message, /PIN[\s\S]*British English/);
  assert.match(await c.call("forget", { text: "Approves budget for infrastructure projects" }), /^✗ people\/john-grecu\.md/);
  assert.match(c.asked[1].message, /REMOVE this fact from people\/john-grecu\.md[\s\S]*Approves budget/);
  assert.doesNotMatch(c.gh.text("memory/people/john-grecu.md"), /Approves budget/);

  const n = await connect({ answer: { action: "decline" } });
  assert.match(await n.call("forget", { text: "Approves budget for infrastructure projects" }), /^not removed: you declined/);
  assert.match(n.gh.text("memory/people/john-grecu.md"), /Approves budget/, "still there");
  assert.match(await n.call("remember", { fact: "Pinned thing", pin: true }), /^✗ not saved/);
  assert.doesNotMatch(n.gh.text("memory/core.md"), /Pinned thing/);
});

test("ordinary facts are never interrupted; forget of a missing fact isn't asked about", async () => {
  const c = await connect();
  await c.call("remember", { fact: "Johnny should support Catalan", about: "johnny" });
  await c.call("remember", { fact: "Johnny from the user", about: "johnny", source: "user" });
  assert.match(await c.call("forget", { text: "a fact that does not exist anywhere" }), /ERROR: No exact matching line/);
  assert.equal(c.asked.length, 0);
});

test("clients that can't ask: auto proceeds (still marked [external]); strict refuses; off never asks", async () => {
  const a = await connect({ capabilities: {} });
  assert.match(await a.call("remember", { fact: "Web fact about Johnny", about: "johnny", source: "external" }), /^✓/);
  assert.match((await a.call("recall", { q: "Web fact" })), /\[external\]/);

  process.env.GITHIPPO_CONFIRM = "strict";
  const s = await connect({ capabilities: {} });
  assert.match(await s.call("remember", { fact: "Another web fact", about: "johnny", source: "external" }), /not saved: this needs your confirmation.*can't ask/);
  assert.match(await s.call("remember", { fact: "Pin me", pin: true }), /not saved/);
  const withForm = await connect(); // strict + a capable client: asks and obeys
  assert.match(await withForm.call("remember", { fact: "Confirmed web fact", about: "johnny", source: "external" }), /^✓/);

  process.env.GITHIPPO_CONFIRM = "off";
  const off = await connect();
  await off.call("remember", { fact: "Quiet web fact", about: "johnny", source: "external" });
  assert.equal(off.asked.length, 0);
});

test("both capability shapes work: {} (Claude Code) and { form: {} }", async () => {
  for (const capabilities of [{ elicitation: {} }, { elicitation: { form: {} } }]) {
    const c = await connect({ capabilities });
    assert.match(await c.call("remember", { fact: "Shape test fact", about: "johnny", source: "external" }), /^✓/);
    assert.equal(c.asked.length, 1);
  }
});

test("a pending question never blocks other memory writes", async () => {
  let release;
  const gateOpen = new Promise((r) => (release = r));
  const c = await connect({ answer: async () => (await gateOpen, { action: "accept", content: { approve: true } }) });
  const pending = c.call("remember", { fact: "Slow external fact", about: "johnny", source: "external" });
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  assert.match(await c.brain.remember("Fast ordinary fact", { about: "johnny" }).then(() => "ok"), /ok/);
  assert.ok(Date.now() - t0 < 1500, "another write completed while the question was open");
  release();
  assert.match(await pending, /^✓/);
});
