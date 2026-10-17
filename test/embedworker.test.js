// The model runs in a child process that exits when idle and restarts on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localEmbedder, hashEmbedder, cosine } from "../src/embed.js";

test("embedding worker: same vectors as in-process, exits when idle, restarts on demand, survives a crash", async () => {
  process.env.GITHIPPO_EMBED_IMPL = "hash";
  process.env.EMBED_IDLE_MS = "300";
  const e = localEmbedder("test-model");
  const [a] = await e.embed(["wake word for the Mac mini"]);
  const [b] = await hashEmbedder().embed(["wake word for the Mac mini"]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6, "worker returns the same vectors");
  assert.equal(e.loaded, true);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(e.loaded, false, "worker exited after idle");
  const [c] = await e.embed(["wake word for the Mac mini"]);
  assert.ok(Math.abs(cosine(a, c) - 1) < 1e-6, "restarted on demand");
  e.stop(); // simulate a crash: the next call must start a fresh worker
  await new Promise((r) => setTimeout(r, 100));
  const [d] = await e.embed(["still works"]);
  assert.equal(d.length, a.length);
  e.stop();
  delete process.env.GITHIPPO_EMBED_IMPL;
  delete process.env.EMBED_IDLE_MS;
});
