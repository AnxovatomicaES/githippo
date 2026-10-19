// Ranking under usage learning, and the scale benchmark's own smoke test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { buildVault, runScale } from "../eval/scale-context.js";

async function brainFor(md) {
  const store = new InMemoryStore();
  for (const [p, c] of Object.entries(md)) await store.write(p, c, "new", "seed");
  const index = new MemoryIndex(store, null, {});
  await index.sync({ maxAgeMs: 0 });
  return new Brain({ store, index });
}

test("usage learning only breaks near-ties: it can't push a clear winner out of first place (rank-1 accuracy fell from 100% to ~35% after a few dozen queries)", async () => {
  const { md, questions } = buildVault(150, { queries: 40, seed: 3 });
  const brain = await brainFor(md);
  const needles = questions.filter((q) => q.type === "needle");
  for (let pass = 1; pass <= 2; pass++) {
    let right = 0;
    for (const { q, path } of needles) {
      await brain.recall(q); // the pack Claude reads: this is what records usage for the chunks it surfaced
      const brief = await brain.recall(q, { mode: "brief" });
      if (brief.hits[0]?.ref.split(":")[0] === path) right++;
    }
    assert.ok(right / needles.length >= 0.95, `pass ${pass}: the right note ranked first for ${right} of ${needles.length} rare-codename questions`);
  }
  assert.ok(Object.keys(brain.index.usage.data).length > 20, "control: usage was actually recorded, so the test exercises the boost");
});

test("scale benchmark (smoke): the pack stays near its budget and the planted facts are found, at 200 notes", async () => {
  const [row] = await runScale({ sizes: [200], queries: 20, seed: 5 });
  assert.ok(row.pack_tokens_mean <= 1000, `a pack averaged ${row.pack_tokens_mean} tokens (default budget 1000)`);
  assert.ok(row.brief_tokens_mean < row.pack_tokens_mean);
  assert.ok(row.savings_vs_everything > 5, `loading everything is only ${row.savings_vs_everything}x bigger`);
  for (const kind of ["named", "needle"]) assert.ok(row[kind].fact_in_pack >= 0.9, `${kind}: the fact reached the pack ${row[kind].fact_in_pack * 100}% of the time`);
  assert.ok(row.needle.hit1 >= 0.9, `needle hit@1 ${row.needle.hit1}`);
});
