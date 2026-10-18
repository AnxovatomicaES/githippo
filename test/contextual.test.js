// Step 3: contextual retrieval (stored context is prepended before indexing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/filestore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { contextualize, CONTEXT_PROMPT } from "../src/contextualize.js";

test("contextualize stores one situating sentence per chunk and recall uses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-"));
  const store = await new FileStore({ dir, autoPush: false }).ensure();
  await store.write("projects/q.md", "---\nname: q\ntitle: Q\ndescription: Quarterly numbers\n---\n\n- Revenue grew 3% over the previous quarter\n", "new");
  const prompts = [];
  const llm = { complete: async ({ prompt }) => (prompts.push(prompt), "This chunk is from ACME Corp's Q2 2026 earnings review.") };
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  assert.equal((await brain.recall("ACME earnings", { mode: "brief" })).hits.length, 0, "not findable before");
  const r = await contextualize({ brain, llm, vaultDir: dir });
  assert.equal(r.added, 1);
  assert.match(prompts[0], /<document>[\s\S]*Revenue grew 3%[\s\S]*<chunk>/);
  const fresh = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  const hits = (await fresh.recall("ACME earnings", { mode: "brief" })).hits;
  assert.ok(hits.some((h) => h.ref.startsWith("projects/q.md")), "context makes the chunk findable");
  assert.equal((await contextualize({ brain: fresh, llm, vaultDir: dir })).added, 0, "idempotent");
  assert.equal(typeof CONTEXT_PROMPT("a", "b"), "string");
});
