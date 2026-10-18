// Binary vector cache. The JSON cache was 162 MB at 50,000 chunks, took 6 s to write (blocking the event loop)
// and 1.1 s to parse. This format is a small header, the keys, then raw little-endian Float32 rows:
//   "GHV2" | uint32 count | uint32 dims | uint32 keyBytes | keys joined by "\n" (padded to 4 bytes) | count×dims float32
// 77 MB at 50,000 × 384, built with memcpy-speed typed-array copies, read back as zero-copy row views.

export function encodeVectors(map) {
  const entries = [...map].filter(([, v]) => v && v.length);
  const dims = entries.length ? entries[0][1].length : 0;
  const rows = entries.filter(([, v]) => v.length === dims);
  const keys = Buffer.from(rows.map(([k]) => k).join("\n"), "utf8");
  const pad = (4 - (keys.length % 4)) % 4;
  const head = Buffer.alloc(16);
  head.write("GHV2", 0, "latin1");
  head.writeUInt32LE(rows.length, 4);
  head.writeUInt32LE(dims, 8);
  head.writeUInt32LE(keys.length, 12);
  const data = Buffer.alloc(rows.length * dims * 4);
  const f = new Float32Array(data.buffer, data.byteOffset, rows.length * dims);
  rows.forEach(([, v], i) => f.set(v, i * dims));
  return Buffer.concat([head, keys, Buffer.alloc(pad), data]);
}

/** Throws "corrupt vector cache" for anything that isn't exactly what encodeVectors wrote (truncated, wrong magic…). */
export function decodeVectors(buf) {
  const bad = () => new Error("corrupt vector cache");
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "GHV2") throw bad();
  const count = buf.readUInt32LE(4);
  const dims = buf.readUInt32LE(8);
  const klen = buf.readUInt32LE(12);
  const start = 16 + klen + ((4 - (klen % 4)) % 4);
  if (buf.length !== start + count * dims * 4) throw bad();
  const keys = count ? buf.toString("utf8", 16, 16 + klen).split("\n") : [];
  if (keys.length !== count) throw bad();
  // one aligned copy, then each row is a view into it (no per-vector allocation)
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + buf.length));
  const out = new Map();
  keys.forEach((k, i) => out.set(k, all.subarray(i * dims, (i + 1) * dims)));
  return out;
}
