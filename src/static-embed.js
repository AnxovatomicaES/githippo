// Static embeddings (Model2Vec, https://github.com/MinishLab/model2vec): a distilled lookup table, no
// neural network at inference. A text's vector is the mean of its tokens' rows, then L2-normalised.
// Loaded once in the embedding worker; weights downloaded once into ~/.githippo/runtime/static/<model>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HUB = "https://huggingface.co";

async function fetchOnce(url, file) {
  if (existsSync(file)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Minimal safetensors reader: 8-byte header length, JSON header, raw little-endian tensors. */
export function readSafetensors(buf) {
  const n = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + n).toString("utf8"));
  const base = 8 + n;
  const out = {};
  for (const [name, t] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    const [a, b] = t.data_offsets;
    const raw = buf.subarray(base + a, base + b);
    let data;
    if (t.dtype === "F32") data = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    else if (t.dtype === "F16") {
      const u = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      data = new Float32Array(u.length);
      for (let i = 0; i < u.length; i++) {
        const h = u[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
        data[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
      }
    } else throw new Error(`unsupported dtype ${t.dtype}`);
    out[name] = { data, shape: t.shape };
  }
  return out;
}

export async function loadStaticModel(model, { runtimeDir, importTransformers }) {
  const dir = join(runtimeDir, "static", model.replace(/[^\w.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  for (const f of ["model.safetensors", "tokenizer.json", "config.json"]) await fetchOnce(`${HUB}/${model}/resolve/main/${f}`, join(dir, f));
  const tensors = readSafetensors(readFileSync(join(dir, "model.safetensors")));
  const t = tensors.embeddings || Object.values(tensors)[0];
  const [vocab, dim] = t.shape;
  const weights = tensors.weights?.data || null; // some Model2Vec models carry per-token weights
  const { PreTrainedTokenizer } = await importTransformers();
  const tokenizer = new PreTrainedTokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")), {});
  const unk = tokenizer.model?.tokens_to_ids?.get?.("[UNK]");
  return {
    dim,
    embed(texts) {
      return texts.map((text) => {
        const ids = tokenizer.encode(String(text), { add_special_tokens: false });
        const v = new Float32Array(dim);
        let n = 0;
        for (const id of ids) {
          if (id === unk || id >= vocab) continue;
          const w = weights ? weights[id] : 1;
          const row = id * dim;
          for (let j = 0; j < dim; j++) v[j] += w * t.data[row + j];
          n += w;
        }
        let norm = 0;
        for (let j = 0; j < dim; j++) norm += (v[j] /= n || 1) ** 2;
        norm = Math.sqrt(norm) || 1;
        for (let j = 0; j < dim; j++) v[j] /= norm;
        return v;
      });
    },
  };
}
