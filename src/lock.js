// Locks for memory writes.
//  KeyedMutex: serialises async work per key inside one process.
//  fileLock:   cross-process lock (MCP server, hooks, CLI) via an exclusive-create lock file; a lock older
//              than staleMs is assumed abandoned by a crashed process and taken over.
import { mkdirSync, openSync, closeSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }
  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => this.tails.get(key) === tail && this.tails.delete(key));
    return next;
  }
}

export async function withFileLock(dir, key, fn, { staleMs = 15_000, timeoutMs = 30_000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.lock`);
  const t0 = Date.now();
  let fd;
  for (let attempt = 0; ; attempt++) {
    try {
      fd = openSync(file, "wx");
      writeSync(fd, `${process.pid}\n`);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) {
          unlinkSync(file); // abandoned by a crashed process
          continue;
        }
      } catch {}
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for the memory lock on ${key}`);
      await new Promise((r) => setTimeout(r, Math.min(200, 5 * 2 ** Math.min(attempt, 5)) + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
      unlinkSync(file);
    } catch {}
  }
}
