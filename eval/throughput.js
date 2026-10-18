// Throughput and memory of the configured embedder: EMBEDDINGS=local|static node eval/throughput.js
import { createEmbedder } from "../src/embed.js";
const emb = createEmbedder(process.env);
const texts = [...Array(1000)].map((_, i) => `user: I moved to Lisbon last spring and I'm looking for a climbing gym near Alfama (${i}). assistant: A few options come to mind near the river`.slice(0, 700));
let t = Date.now();
await emb.embed(texts.slice(0, 16));
const load = Date.now() - t;
t = Date.now();
await emb.embed(texts);
const s = (Date.now() - t) / 1000;
console.log(`throughput · ${emb.id}: ${(texts.length / s).toFixed(0)} chunks/s · first call (load) ${load} ms · worker RSS ${await emb.workerRssMB?.()} MB`);
emb.stop?.();
