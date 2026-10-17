// Quality floor: CI fails if retrieval or write-side quality regresses on the labelled set. This runs in
// keyword mode (deterministic, no model download), so it covers what keyword search is responsible for;
// cross-language quality needs the model and is tracked by the eval workflow (results in issue #3).
// Floors sit a little under today's measured values, not at them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEval } from "../eval/run.js";

test("quality floor (keyword + graph, no embeddings)", async () => {
  const r = await runEval({ embeddings: "none" });
  for (const t of ["exact", "code", "entity", "graph"]) assert.ok(r.byType[t].hit1 >= 90, `${t} hit@1 ${r.byType[t].hit1}%`);
  assert.ok(r.byType.paraphrase.hit5 >= 60, `paraphrase hit@5 ${r.byType.paraphrase.hit5}%`);
  const mono = ["exact", "code", "entity", "graph", "paraphrase"].map((t) => r.byType[t]);
  const hit5 = (100 * mono.reduce((s, m) => s + (m.hit5 * m.n) / 100, 0)) / mono.reduce((s, m) => s + m.n, 0);
  assert.ok(hit5 >= 85, `same-language hit@5 ${hit5.toFixed(1)}%`);
  assert.ok(r.routing.accuracy >= 66, `routing ${r.routing.accuracy}%`);
  assert.ok(r.dedupe.accuracy >= 80, `dedupe ${r.dedupe.accuracy}%`);
});
