// Embedding throughput on this machine: chunks/second for batch sizes and ONNX thread counts.
// Usage: node eval/embed-bench.js [--n 512]
import { importTransformers } from "../src/embed.js";
import { cpus } from "node:os";
const n = Number(process.argv.includes("--n") ? process.argv[process.argv.indexOf("--n") + 1] : 512);
const model = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const sentence = "user: I moved to Lisbon last spring and I am still looking for a good climbing gym near Alfama, any ideas? assistant: A few options come to mind";
const texts = [...Array(n)].map((_, i) => `${sentence} (${i})`.repeat(3).slice(0, 700));
const { pipeline, env } = await importTransformers();
const out = [`cores: ${cpus().length} · ${n} chunks of 700 chars`];
for (const threads of [0, cpus().length]) {
  const opts = { dtype: "q8", ...(threads ? { session_options: { intraOpNumThreads: threads } } : {}) };
  const pipe = await pipeline("feature-extraction", model, opts);
  for (const batch of [16, 64]) {
    const t0 = Date.now();
    for (let i = 0; i < texts.length; i += batch) await pipe(texts.slice(i, i + batch), { pooling: "mean", normalize: true });
    const s = (Date.now() - t0) / 1000;
    out.push(`threads ${threads || "default"} · batch ${batch}: ${(n / s).toFixed(0)} chunks/s`);
  }
  await pipe.dispose?.();
}
// tokenizer truncation check: does a 700-char chunk get cut to the model's 128-token window?
const pipe = await pipeline("feature-extraction", model, { dtype: "q8" });
const tok = pipe.tokenizer(texts[0]);
out.push(`tokens in one 700-char chunk: ${tok.input_ids.dims.at(-1)} (model window 128)`);
console.log(out.join("\n"));
