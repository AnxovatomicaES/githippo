// Embedding providers. All return L2-normalised Float32Arrays.
//  - local:  paraphrase-multilingual-MiniLM-L12-v2 via transformers.js (private, no API key)
//  - voyage: Voyage AI API (lighter on RAM, needs VOYAGE_API_KEY)
//  - none:   keyword-only retrieval

// Score thresholds differ wildly between models (e5 rates unrelated text ~0.72; MiniLM ~0.09),
// so each profile is calibrated on real sentence pairs (see docs/calibration.md).
//   dup: same fact reworded · related: same subject, maybe updated · strong: confident routing · floor: weakest useful hit
export const PROFILES = {
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": { dup: 0.92, related: 0.55, conflict: 0.8, strong: 0.4, floor: 0.25, calibrated: true },
  // e5: only score ranges were measured (docs/calibration.md), not pair thresholds, and they barely separate. Not recommended.
  "Xenova/multilingual-e5-small": { dup: 0.96, related: 0.86, conflict: 0.9, strong: 0.8, floor: 0.76, calibrated: false },
  "Xenova/multilingual-e5-base": { dup: 0.96, related: 0.86, conflict: 0.9, strong: 0.8, floor: 0.75, calibrated: false },
  hash: { dup: 0.93, related: 0.7, conflict: 0.7, strong: 0.45, floor: 0.3, calibrated: false }, // offline/test stand-in
  default: { dup: 0.92, related: 0.6, conflict: 0.82, strong: 0.45, floor: 0.3, calibrated: false },
};
export const DEFAULT_LOCAL_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME_DIR } from "./config.js";

// The local embedding runtime is ~500 MB, so it is NOT part of the install. It's fetched once, in the
// background, into ~/.githippo/runtime; until it's there, recall quietly runs on keyword search.
export const RUNTIME_DIR = join(HOME_DIR, "runtime");
export const RUNTIME_PKG = "@huggingface/transformers@4.3.1";

export async function importTransformers() {
  try {
    return await import("@huggingface/transformers"); // dev checkout / user installed it themselves
  } catch {}
  try {
    const req = createRequire(join(RUNTIME_DIR, "package.json"));
    return await import(pathToFileURL(req.resolve("@huggingface/transformers")).href);
  } catch {}
  ensureRuntime();
  throw new Error("local embeddings are being set up in the background (one time); keyword search until then");
}

/** Starts a detached one-time install of the embedding runtime. Never blocks, never runs twice at once. */
export function ensureRuntime({ wait = false } = {}) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const lock = join(RUNTIME_DIR, ".installing");
  const started = existsSync(lock) ? Number(readFileSync(lock, "utf8")) || 0 : 0;
  if (!wait && Date.now() - started < 10 * 60_000) return null;
  writeFileSync(lock, String(Date.now()));
  if (!existsSync(join(RUNTIME_DIR, "package.json"))) writeFileSync(join(RUNTIME_DIR, "package.json"), '{"private":true}\n');
  const log = openSync(join(RUNTIME_DIR, "install.log"), "a");
  const child = spawn("npm", ["i", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", RUNTIME_DIR, RUNTIME_PKG], {
    detached: !wait,
    stdio: ["ignore", log, log],
    shell: process.platform === "win32",
  });
  if (wait) return new Promise((r) => child.on("exit", (code) => { writeFileSync(lock, "0"); r(code === 0); }));
  child.unref();
  return null;
}

const normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

export function localEmbedder(model = DEFAULT_LOCAL_MODEL) {
  // B17: cache the loading promise, so concurrent first calls share one model load. A failed load can be retried.
  let loading;
  const load = () =>
    (loading ??= importTransformers()
      .then(({ pipeline }) => pipeline("feature-extraction", model, { dtype: "q8" }))
      .catch((e) => {
        loading = undefined;
        throw e;
      }));
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
