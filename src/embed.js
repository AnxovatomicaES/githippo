// Embedding providers. All return L2-normalised Float32Arrays.
//  - local:  paraphrase-multilingual-MiniLM-L12-v2 via transformers.js (private, no API key)
//  - voyage: Voyage AI API (lighter on RAM, needs VOYAGE_API_KEY)
//  - none:   keyword-only retrieval

// Score thresholds differ wildly between models (e5 rates unrelated text ~0.72; MiniLM ~0.09),
// so each profile is calibrated on real sentence pairs (see docs/calibration.md).
//   dup: same fact reworded · related: same subject, maybe updated · strong: confident routing · floor: weakest useful hit
export const PROFILES = {
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": { dup: 0.92, related: 0.55, conflict: 0.8, strong: 0.4, floor: 0.25, calibrated: true },
  "Xenova/multilingual-e5-small": { dup: 0.96, related: 0.86, conflict: 0.9, strong: 0.8, floor: 0.76, calibrated: true },
  "Xenova/multilingual-e5-base": { dup: 0.96, related: 0.86, conflict: 0.9, strong: 0.8, floor: 0.75, calibrated: true },
  hash: { dup: 0.93, related: 0.7, conflict: 0.7, strong: 0.45, floor: 0.3, calibrated: false }, // offline/test stand-in
  default: { dup: 0.92, related: 0.6, conflict: 0.82, strong: 0.45, floor: 0.3, calibrated: false },
};
export const DEFAULT_LOCAL_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

const normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

export function localEmbedder(model = DEFAULT_LOCAL_MODEL) {
  let extractor;
  const load = async () => {
    if (!extractor) {
      const { pipeline } = await import("@huggingface/transformers");
      extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
    }
    return extractor;
  };
  // e5 models expect role prefixes.
  const prefix = (kind) => (/e5/i.test(model) ? (kind === "query" ? "query: " : "passage: ") : "");
  return {
    id: `local:${model}`,
    profile: PROFILES[model] || PROFILES.default,
    async embed(texts, kind = "document") {
      const ex = await load();
      const out = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16).map((t) => prefix(kind) + t);
        const res = await ex(batch, { pooling: "mean", normalize: true });
        out.push(...res.tolist().map(normalize));
      }
      return out;
    },
  };
}

export function voyageEmbedder(apiKey, model = "voyage-3.5-lite", fetchImpl = fetch) {
  if (!apiKey) throw new Error("VOYAGE_API_KEY is required for EMBEDDINGS=voyage");
  return {
    id: `voyage:${model}`,
    profile: PROFILES.default,
    async embed(texts, kind = "document") {
      const out = [];
      for (let i = 0; i < texts.length; i += 64) {
        const res = await fetchImpl("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: texts.slice(i, i + 64), model, input_type: kind }),
        });
        if (!res.ok) throw new Error(`Voyage embeddings failed (${res.status})`);
        const data = await res.json();
        out.push(...data.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding)));
      }
      return out;
    },
  };
}

/** Deterministic hashed bag-of-words embedder for tests and offline use. */
export function hashEmbedder(dims = 256) {
  return {
    id: `hash:${dims}`,
    profile: PROFILES.hash,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dims);
        for (const tok of t.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || []) {
          let h = 2166136261;
          for (const c of tok) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
          v[Math.abs(h) % dims] += 1;
        }
        return normalize(v);
      });
    },
  };
}

export function createEmbedder(env = process.env) {
  const p = (env.EMBEDDINGS || "local").toLowerCase();
  if (p === "none") return null;
  if (p === "voyage") return voyageEmbedder(env.VOYAGE_API_KEY, env.VOYAGE_MODEL);
  if (p === "hash") return hashEmbedder();
  return localEmbedder(env.LOCAL_EMBED_MODEL);
}

export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
