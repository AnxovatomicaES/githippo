// Memory footprint of local embeddings: githippo's own process, the model worker while loaded, and
// after the worker exits on idle (EMBED_IDLE_MS). Run with --expose-gc.
import { localEmbedder } from "../src/embed.js";
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
const e = localEmbedder();
await e.embed(["warm up the model with a sentence"], "document");
const worker = await e.workerRssMB();
const main = mb();
await new Promise((r) => setTimeout(r, Number(process.env.EMBED_IDLE_MS) + 1500));
globalThis.gc?.();
console.log(`githippo process ${main} MB + model worker ${worker} MB while in use · after idle: githippo ${mb()} MB, worker running: ${e.loaded}`);
