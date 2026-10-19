// Per-model settings for local embedding models: the prompt prefixes a model was trained with, the precision to load, and the vector length.
// The model itself is not needed (it is hundreds of MB): the quality numbers are in docs/benchmarks.md and docs/calibration.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsFor, dimsFor, MODEL_SETTINGS, PROFILES, localEmbedder, DEFAULT_LOCAL_MODEL } from "../src/embed.js";

const GEMMA = "onnx-community/embeddinggemma-300m-ONNX";

test("settingsFor: EmbeddingGemma gets its trained prefixes and q4, e5 keeps its own, everything else none", () => {
  assert.deepEqual(settingsFor(GEMMA), MODEL_SETTINGS[GEMMA]);
  assert.equal(settingsFor(GEMMA).query, "task: search result | query: ");
  assert.equal(settingsFor(GEMMA).document, "title: none | text: ");
  assert.equal(settingsFor(GEMMA).dtype, "q4");
  assert.equal(settingsFor(GEMMA).sentenceEmbedding, true, "its graph pools and projects itself");
  assert.deepEqual(settingsFor("Xenova/multilingual-e5-small"), { query: "query: ", document: "passage: " });
  assert.deepEqual(settingsFor(DEFAULT_LOCAL_MODEL), {}, "the default model needs no prefix and runs the plain pipeline");
});

test("every model with settings has a calibrated profile, and the thresholds are ordered", () => {
  for (const model of Object.keys(MODEL_SETTINGS)) {
    const p = PROFILES[model];
    assert.ok(p?.calibrated, `${model} has a calibrated profile`);
    assert.ok(p.floor < p.strong && p.strong < p.related && p.related < p.dup, `${model}: floor < strong < related < dup`);
    assert.ok(p.related < p.conflict && p.conflict < p.dup + 0.1, `${model}: conflict sits between related and duplicate`);
  }
});

test("a shorter vector is a different index: the embedder id says so, and GITHIPPO_EMBED_DIMS is honoured", () => {
  const before = process.env.GITHIPPO_EMBED_DIMS;
  try {
    delete process.env.GITHIPPO_EMBED_DIMS;
    assert.equal(dimsFor(GEMMA), undefined);
    assert.equal(localEmbedder(GEMMA).id, `local:${GEMMA}`);
    process.env.GITHIPPO_EMBED_DIMS = "256";
    assert.equal(dimsFor(GEMMA), 256);
    assert.equal(localEmbedder(GEMMA).id, `local:${GEMMA}@256`, "cached 768-long vectors can't be mixed with 256-long ones");
    assert.equal(dimsFor(DEFAULT_LOCAL_MODEL), undefined, "a model that isn't trained for truncation is never cut (it would lose most of its quality)");
    assert.equal(localEmbedder(DEFAULT_LOCAL_MODEL).id, `local:${DEFAULT_LOCAL_MODEL}`);
  } finally {
    if (before === undefined) delete process.env.GITHIPPO_EMBED_DIMS;
    else process.env.GITHIPPO_EMBED_DIMS = before;
  }
});
