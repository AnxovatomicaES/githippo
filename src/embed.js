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
  // static (Model2Vec) profiles, from eval/calibrate.js runs in CI (same pair method as docs/calibration.md):
  //  potion-base-8M: duplicates 0.81-1.00, updated 0.51-0.93, same topic 0.23-0.46, unrelated -0.08-0.03
  //  potion-multilingual-128M: duplicates 0.90-1.00, updated 0.47-0.91, same topic 0.22-0.71, unrelated -0.14-0.05
  "minishlab/potion-base-8M": { dup: 0.95, related: 0.5, conflict: 0.8, strong: 0.35, floor: 0.15, calibrated: true },
  "minishlab/potion-multilingual-128M": { dup: 0.93, related: 0.5, conflict: 0.8, strong: 0.4, floor: 0.15, calibrated: true },
  hash: { dup: 0.93, related: 0.7, conflict: 0.7, strong: 0.45, floor: 0.3, calibrated: false }, // offline/test stand-in
  default: { dup: 0.92, related: 0.6, conflict: 0.82, strong: 0.45, floor: 0.3, calibrated: false },
};
export const DEFAULT_LOCAL_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DEFAULT_STATIC_MODEL = "minishlab/potion-multilingual-128M";

import { fork, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOME_DIR } from "./config.js";

// The local embedding runtime is ~500 MB, so it is NOT part of the install. It's fetched once, in the
// background, into ~/.githippo/runtime; until it's there, recall quietly runs on keyword search.
export const RUNTIME_DIR = join(HOME_DIR, "runtime");

/**
 * The environment for child processes that don't need our credentials. applyFileConfig() copies config.json keys (GITHUB_TOKEN,
 * ANTHROPIC_API_KEY, MCP_SECRET…) into process.env for the rest of the program; `npm i` (and the install scripts of everything
 * it fetches) and the embedding worker must not inherit them.
 */
export const cleanEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/TOKEN|SECRET|API_?KEY|PASSWORD|CREDENTIAL/i.test(k)));
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
export function ensureRuntime({ wait = false, force = false } = {}) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const lock = join(RUNTIME_DIR, ".installing");
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  const holder = () => {
    try {
      const [pid, t] = readFileSync(lock, "utf8").trim().split(/\s+/).map(Number);
      return { pid, t };
    } catch {
      return null;
    }
  };
  // One installer at a time: the lock is created exclusively (two processes can't both win it), holds the installer's
  // pid, and counts as abandoned once that process is gone or it's 15 minutes old. (It used to be check-then-write,
  // so setup's background warm and a second process each ran their own ~500 MB `npm i`.)
  const tryLock = () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, "wx");
        writeSync(fd, `${process.pid} ${Date.now()}`);
        closeSync(fd);
        return true;
      } catch (e) {
        if (e.code !== "EEXIST") return true; // can't lock for some other reason: carry on rather than block
        const h = holder();
        if (h && alive(h.pid) && Date.now() - h.t < 15 * 60_000) return false;
        try {
          unlinkSync(lock);
        } catch {}
      }
    }
    return false;
  };
  if (!tryLock()) {
    if (!wait) return null;
    return (async () => {
      // someone else is installing: wait for them instead of starting a second install
      const until = Date.now() + 15 * 60_000;
      for (let h = holder(); h && alive(h.pid) && Date.now() < until; h = holder()) await new Promise((r) => setTimeout(r, 1000));
      return true;
    })();
  }
  const release = () => {
    try {
      unlinkSync(lock);
    } catch {}
  };
  // A failed install (offline, no npm, a registry error) used to be retried on every embed attempt, i.e. every recall. A
  // failure is stamped when we see npm exit badly (the server, which stays alive, always does; a short-lived command may
  // exit before npm does and then just retries next time). We hold the lock, so nothing is installing: inside the hour, back
  // off and let the log say why. `githippo warm` passes force to try again on purpose.
  const failedFile = join(RUNTIME_DIR, ".failed");
  if (!force) {
    try {
      if (Date.now() - Number(readFileSync(failedFile, "utf8")) < 60 * 60_000) {
        release();
        return wait ? Promise.resolve(false) : null;
      }
    } catch {}
  }
  const failed = () => {
    try {
      writeFileSync(failedFile, String(Date.now()));
    } catch {}
  };
  if (!existsSync(join(RUNTIME_DIR, "package.json"))) writeFileSync(join(RUNTIME_DIR, "package.json"), '{"private":true}\n');
  const log = openSync(join(RUNTIME_DIR, "install.log"), "a");
  const child = spawn("npm", ["i", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", RUNTIME_DIR, RUNTIME_PKG], {
    detached: !wait,
    env: cleanEnv(),
    stdio: ["ignore", log, log],
    shell: process.platform === "win32",
  });
  // no npm on PATH (or it can't start): without a listener, Node turns the 'error' event into a crash
  child.on("error", (e) => {
    try {
      writeFileSync(join(RUNTIME_DIR, "install.log"), `could not run npm: ${e.message}\n`, { flag: "a" });
    } catch {}
    failed();
    release();
  });
  child.on("exit", (code) => {
    if (code === 0) {
      try {
        unlinkSync(failedFile);
      } catch {}
    } else failed();
  });
  if (child.pid) {
    try {
      writeFileSync(lock, `${child.pid} ${Date.now()}`); // from now on the lock lives and dies with the npm process, even if we exit first
    } catch {}
  }
  if (wait) {
    return new Promise((r) => {
      child.on("error", () => r(false));
      child.on("exit", (code) => {
        release();
        r(code === 0);
      });
    });
  }
  child.unref();
  return null;
}

const normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

/**
 * Local embeddings in a child process. The model loads on the first query and the child exits after
 * EMBED_IDLE_MS (default 10 min) without use, so an idle githippo uses ~50 MB instead of ~500 MB. The next
 * query restarts it (model cached on disk). If the child dies, the next call starts a new one.
 */
export function localEmbedder(model = DEFAULT_LOCAL_MODEL, { impl } = {}) {
  const prefix = (kind) => (/e5/i.test(model) ? (kind === "query" ? "query: " : "passage: ") : "");
  const idleMs = Number(process.env.EMBED_IDLE_MS || 600_000);
  let child = null;
  let seq = 0;
  let idleTimer;
  const pending = new Map();
  const failAll = (msg) => {
    for (const { reject } of pending.values()) reject(new Error(msg));
    pending.clear();
  };
  const start = () => {
    child = fork(fileURLToPath(new URL("./embed-worker.js", import.meta.url)), [], {
      env: { ...cleanEnv(), GITHIPPO_EMBED_MODEL: model, ...(impl ? { GITHIPPO_EMBED_IMPL: impl } : {}) },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const me = child;
    me.on("error", (e) => failAll(`embedding worker failed to start: ${e.message}`));
    // An open IPC channel keeps the parent alive; only hold it while a request is in flight, so CLI
    // commands (eval, warm, demo) exit as soon as they're done instead of waiting for the idle timeout.
    me.unref();
    me.channel?.unref();
    me.on("message", (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (!pending.size) me.channel?.unref();
      m.error ? p.reject(new Error(m.error)) : p.resolve(m);
    });
    me.on("exit", () => {
      if (child === me) child = null;
      failAll("embedding worker exited");
    });
  };
  const call = (msg) => {
    if (!child) start();
    clearTimeout(idleTimer);
    if (idleMs > 0) {
      idleTimer = setTimeout(() => child?.kill(), idleMs);
      idleTimer.unref?.();
    }
    const id = ++seq;
    child.channel?.ref();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ id, ...msg });
    });
  };
  return {
    id: `${impl || "local"}:${model}`,
    get loaded() {
      return !!child;
    },
    profile: PROFILES[model] || PROFILES.default,
    async embed(texts, kind = "document") {
      const r = await call({ texts: texts.map((t) => prefix(kind) + t), kind });
      return r.vecs.map(normalize);
    },
    async rerank(query, texts) {
      return (await call({ type: "rerank", query, texts })).scores;
    },
    async workerRssMB() {
      return child ? (await call({ type: "stats" })).rssMB : 0;
    },
    stop() {
      child?.kill();
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
  const p = String(env.EMBEDDINGS || "local").toLowerCase();
  if (!["none", "local", "static", "voyage", "hash"].includes(p)) throw new Error(`EMBEDDINGS must be none, local, static, voyage or hash (got "${env.EMBEDDINGS}")`);
  if (p === "none") return null;
  if (p === "voyage") return voyageEmbedder(env.VOYAGE_API_KEY, env.VOYAGE_MODEL);
  if (p === "hash") return hashEmbedder();
  // static: Model2Vec lookup-table embeddings, much faster on CPU; profile uncalibrated unless measured
  if (p === "static") return localEmbedder(env.STATIC_EMBED_MODEL || DEFAULT_STATIC_MODEL, { impl: "static" });
  return localEmbedder(env.LOCAL_EMBED_MODEL);
}

export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
