// Child process that holds the embedding model. The parent kills it when idle, so the operating system
// reclaims all of its memory (an in-process "unload" only gave back ~140 of ~480 MB, measured in CI).
import { importTransformers, hashEmbedder, settingsFor, RUNTIME_DIR } from "./embed.js";
import { loadStaticModel } from "./static-embed.js";

const model = process.env.GITHIPPO_EMBED_MODEL;
let extractor;
const load = async () => {
  if (process.env.GITHIPPO_EMBED_IMPL === "hash") return (extractor ??= hashEmbedder());
  if (process.env.GITHIPPO_EMBED_IMPL === "static") return (extractor ??= await loadStaticModel(model, { runtimeDir: RUNTIME_DIR, importTransformers }));
  const cfg = settingsFor(model);
  if (!extractor && cfg.sentenceEmbedding) {
    // the graph pools and projects itself (EmbeddingGemma): tokenize, run, read sentence_embedding
    const { AutoModel, AutoTokenizer } = await importTransformers();
    const tokenizer = await AutoTokenizer.from_pretrained(model);
    const net = await AutoModel.from_pretrained(model, { dtype: cfg.dtype || "q8" });
    extractor = {
      async embed(texts) {
        const out = [];
        for (let i = 0; i < texts.length; i += 16) {
          const inputs = await tokenizer(texts.slice(i, i + 16), { padding: true, truncation: true, max_length: 512 });
          const { sentence_embedding } = await net(inputs);
          out.push(...sentence_embedding.tolist());
        }
        return out;
      },
    };
  }
  if (!extractor) {
    const { pipeline } = await importTransformers();
    const pipe = await pipeline("feature-extraction", model, { dtype: cfg.dtype || "q8" });
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

let reranker;
process.on("message", async (m) => {
  try {
    if (m.type === "stats") return process.send({ id: m.id, rssMB: Math.round(process.memoryUsage().rss / 1e6) });
    if (m.type === "rerank") {
      // cross-encoder: reads question and candidate together, scores relevance
      if (!reranker) {
        const { pipeline } = await importTransformers();
        reranker = await pipeline("text-classification", process.env.RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2", { dtype: "q8" });
      }
      const scores = [];
      for (const t of m.texts) {
        const [r] = await reranker({ text: m.query, text_pair: t }, { top_k: 1, function_to_apply: "none" });
        scores.push(r.score);
      }
      return process.send({ id: m.id, scores });
    }
    const ex = await load();
    const vecs = await ex.embed(m.texts, m.kind);
    process.send({ id: m.id, vecs: vecs.map((v) => Array.from(v)) });
  } catch (e) {
    process.send({ id: m.id, error: e.message });
  }
});
process.on("disconnect", () => process.exit(0));
