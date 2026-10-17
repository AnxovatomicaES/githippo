// Embedding providers. All return L2-normalised Float32Arrays.
//  - local:  multilingual-e5-small via transformers.js (private, no API key)
//  - voyage: Voyage AI API (lighter on RAM, needs VOYAGE_API_KEY)
//  - none:   keyword-only retrieval

const normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

export function localEmbedder(model = "Xenova/multilingual-e5-small") {
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
