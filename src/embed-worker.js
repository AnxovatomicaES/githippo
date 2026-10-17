// Child process that holds the embedding model. The parent kills it when idle, so the operating system
// reclaims all of its memory (an in-process "unload" only gave back ~140 of ~480 MB, measured in CI).
import { importTransformers, hashEmbedder } from "./embed.js";

const model = process.env.GITHIPPO_EMBED_MODEL;
let extractor;
const load = async () => {
  if (process.env.GITHIPPO_EMBED_IMPL === "hash") return (extractor ??= hashEmbedder());
  if (!extractor) {
    const { pipeline } = await importTransformers();
    const pipe = await pipeline("feature-extraction", model, { dtype: "q8" });
    extractor = {
      async embed(texts) {
        const out = [];
        for (let i = 0; i < texts.length; i += 16) {
          const res = await pipe(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
          out.push(...res.tolist());
        }
        return out;
      },
    };
  }
  return extractor;
};

process.on("message", async (m) => {
  try {
    if (m.type === "stats") return process.send({ id: m.id, rssMB: Math.round(process.memoryUsage().rss / 1e6) });
    const ex = await load();
    const vecs = await ex.embed(m.texts, m.kind);
    process.send({ id: m.id, vecs: vecs.map((v) => Array.from(v)) });
  } catch (e) {
    process.send({ id: m.id, error: e.message });
  }
});
process.on("disconnect", () => process.exit(0));
