// Measures the local model's memory footprint: loaded, then after idle unload. Run with --expose-gc.
import { localEmbedder } from "../src/embed.js";
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
const base = mb();
const e = localEmbedder();
await e.embed(["warm up the model with a sentence"], "document");
const loaded = mb();
await new Promise((r) => setTimeout(r, Number(process.env.EMBED_IDLE_MS) + 1500));
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 500));
console.log(`RSS before model ${base} MB · model loaded ${loaded} MB · after idle unload ${mb()} MB (still loaded: ${e.loaded})`);
