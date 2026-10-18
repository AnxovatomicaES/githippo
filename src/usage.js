// Usage-weighted ranking: memory that keeps being used ranks a little higher; the boost fades over time.
// Counts stay on this machine (cache dir), are kept per user, and never leave it. No telemetry.
// With no usage data the ranking is exactly the same as without this module.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { hash } from "./parse.js";
import { dirname } from "node:path";

const HALF_LIFE_DAYS = 30;
const WEIGHT = 0.15; // at most ~+40% for very frequently used memory
const MAX_BOOST = 1.4;

export class Usage {
  constructor(file = null) {
    this.file = file;
    this.data = {};
    try {
      if (file) this.data = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }

  key(chunk, user) {
    return `${user || "_"}|${chunk.path}#${chunk.heading || ""}`;
  }

  boost(chunk, user, now = Date.now()) {
    const u = this.data[this.key(chunk, user)];
    if (!u) return 1;
    const days = (now - u.t) / 86_400_000;
    return Math.min(MAX_BOOST, 1 + WEIGHT * Math.log1p(u.n) * Math.pow(0.5, days / HALF_LIFE_DAYS));
  }

  /** `query` (optional) is remembered as a short hash so we can count DISTINCT questions that surfaced an item. */
  record(chunks, user, now = Date.now(), query = null) {
    const qh = query ? hash(String(query).toLowerCase().replace(/\s+/g, " ").trim()).slice(0, 8) : null;
    for (const c of chunks) {
      const k = this.key(c, user);
      const u = this.data[k] || { n: 0, t: now };
      // decay the old count before adding, so a burst long ago doesn't dominate forever
      const days = (now - u.t) / 86_400_000;
      const next = { n: u.n * Math.pow(0.5, days / HALF_LIFE_DAYS) + 1, t: now };
      const q = qh ? [...new Set([...(u.q || []), qh])].slice(-12) : u.q;
      if (q) next.q = q;
      this.data[k] = next;
    }
    this.save();
  }

  /** Decayed recall count of an entry right now. */
  count(entry, now = Date.now()) {
    return entry.n * Math.pow(0.5, (now - entry.t) / 86_400_000 / HALF_LIFE_DAYS);
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const keys = Object.keys(this.data);
      if (keys.length > 20_000) for (const k of keys.sort((a, b) => this.data[a].t - this.data[b].t).slice(0, keys.length - 20_000)) delete this.data[k];
      await mkdir(dirname(this.file), { recursive: true }).catch(() => {});
      await writeFile(this.file, JSON.stringify(this.data)).catch(() => {});
    }, 2000);
    this.timer.unref?.();
  }
}
