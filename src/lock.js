// Locks for memory writes.
//  KeyedMutex: serialises async work per key inside one process.
//  fileLock:   cross-process lock (MCP server, hooks, CLI) via an exclusive-create lock file; a lock older
//              than staleMs is assumed abandoned by a crashed process and taken over.
import { mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  const token = `${process.pid}.${randomBytes(6).toString("hex")}\n`; // identifies THIS holder
  for (let attempt = 0; ; attempt++) {
    try {
      fd = openSync(file, "wx");
      writeSync(fd, token);
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
  // Heartbeat: a holder that is alive but slow (a commit over 15 s) keeps the lock fresh, so nobody mistakes it for a crashed one.
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {}
  }, Math.max(250, Math.floor(staleMs / 3)));
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      closeSync(fd);
    } catch {}
    try {
      // only remove the lock if it's still ours: if it was judged stale and re-taken, deleting it would free someone else's lock
      if (readFileSync(file, "utf8") === token) unlinkSync(file);
    } catch {}
  }
}

/** Runs fn over items with at most `limit` in flight (an unbounded Promise.all over thousands of file reads exhausts file descriptors). */
export async function forEachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
