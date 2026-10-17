// In-memory store with the same interface as GitHubMemoryStore. Powers `githippo demo`
// (try it with no repo and no token) and offline use.
import { MemoryError, normalizePath, sameVersion } from "./store.js";
import { createHash } from "node:crypto";

export class InMemoryStore {
  constructor() {
    this.files = new Map();
    this.log = [];
    this.n = 0;
  }
  sha(c) {
    return createHash("sha1").update(`${c}${++this.n}`).digest("hex");
  }
  commit(path, content, op) {
    this.log.unshift({ path, content, op, date: new Date(Date.now() + this.log.length).toISOString(), sha: this.sha("c") });
  }
  async read(path) {
    const p = normalizePath(path);
    const f = this.files.get(p);
    return f ? { path: p, content: f.content, version: f.version } : null;
  }
  async list(prefix = "") {
    return [...this.files].filter(([p]) => p.startsWith(prefix)).map(([path, f]) => ({ path, size: f.content.length, version: f.version })).sort((a, b) => a.path.localeCompare(b.path));
  }
  async write(path, content, ifVersion, op = "write") {
    const p = normalizePath(path);
    const cur = this.files.get(p);
    if (ifVersion === "new" && cur) throw new MemoryError(`${p} already exists.`, { current: { path: p, ...cur } });
    if (ifVersion !== "new" && (!cur || !sameVersion(cur.version, ifVersion))) throw new MemoryError(`Version conflict on ${p}.`, { current: cur && { path: p, ...cur } });
    const version = this.sha(content);
    this.files.set(p, { content, version });
    this.commit(p, content, op);
    return { path: p, version, bytes: Buffer.byteLength(content) };
  }
  async append(path, text, v, op) {
    const cur = await this.read(path);
    return this.write(path, cur ? `${cur.content.replace(/\n*$/, "\n")}${text}` : text, v, op);
  }
  async replace(path, oldStr, newStr, v) {
    const cur = await this.read(path);
    if (!cur || cur.content.split(oldStr).length !== 2) throw new MemoryError("old_str must match exactly once.");
    return this.write(path, cur.content.replace(oldStr, () => newStr), v, "edit");
  }
  async delete(path, v) {
    const p = normalizePath(path);
    const cur = this.files.get(p);
    if (!cur || !sameVersion(cur.version, v)) throw new MemoryError(`Version conflict on ${p}.`);
    this.files.delete(p);
    this.commit(p, null, "delete");
    return { path: p, deleted: true };
  }
  async history(path) {
    return this.log.filter((c) => c.path === path).map((c) => ({ commit: c.sha, date: c.date, message: `memory: ${c.op} ${path}` }));
  }
  async at(path, iso) {
    const c = this.log.find((x) => x.path === path && x.date <= new Date(iso).toISOString());
    return c?.content ? { path, existed: true, as_of: iso, commit: c.sha, content: c.content } : { path, existed: false, as_of: iso };
  }
  async activeDays(since) {
    return [...new Set(this.log.filter((c) => c.date >= since).map((c) => c.date.slice(0, 10)))].sort();
  }
}
