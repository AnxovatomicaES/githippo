// Quality floor: CI fails if retrieval or write-side quality regresses on the labelled set (keyword mode,
// deterministic, no model download). Floors sit a little under today's measured values, not at them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEval } from "../eval/run.js";

test("quality floor (keyword + graph, no embeddings)", async () => {
  const r = await runEval({ embeddings: "none" });
  assert.ok(r.retrieval.hit5 >= 65, `hit@5 ${r.retrieval.hit5}% < 65%`);
  assert.ok(r.retrieval.hit1 >= 55, `hit@1 ${r.retrieval.hit1}% < 55%`);
  for (const t of ["exact", "code", "entity", "graph"]) assert.ok(r.byType[t].hit1 >= 90, `${t} hit@1 ${r.byType[t].hit1}%`);
  assert.ok(r.routing.accuracy >= 66, `routing ${r.routing.accuracy}%`);
  assert.ok(r.dedupe.accuracy >= 80, `dedupe ${r.dedupe.accuracy}%`);
});
