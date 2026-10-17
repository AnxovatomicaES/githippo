// GitHub-backed memory store. Every write is a commit; the blob SHA is the
// version token, so concurrent sessions can't silently overwrite each other.

export class MemoryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MemoryError";
    Object.assign(this, details);
  }
}

export const MAX_FILE_BYTES = 64 * 1024;

export function normalizePath(input) {
  if (typeof input !== "string" || !input.trim()) throw new MemoryError("Path is required.");
  const p = input.trim().replace(/^\/+/, "");
  if (p.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new MemoryError(`Invalid path: ${input}`);
  }
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) {
    throw new MemoryError(`Path may only contain letters, digits, '.', '_', '-', '/': ${input}`);
  }
  if (!p.endsWith(".md")) throw new MemoryError(`Memory files must end in .md: ${input}`);
  return p;
}

/** Versions may be passed as short handles (first 7+ chars of the blob SHA). */
export const sameVersion = (full, given) =>
  typeof given === "string" && given.length >= 7 && full.startsWith(given);
export const short = (v) => (v ? v.slice(0, 8) : v);

const b64encode = (s) => Buffer.from(s, "utf8").toString("base64");
const b64decode = (s) => Buffer.from(s, "base64").toString("utf8");

export class GitHubMemoryStore {
  constructor({ token, repo, branch = "main", root = "memory", source = "githippo", fetchImpl = fetch }) {
    if (!token) throw new MemoryError("GITHUB_TOKEN is not set.");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new MemoryError("MEMORY_REPO must look like owner/name.");
    Object.assign(this, { token, repo, branch, source, fetch: fetchImpl });
    this.root = root.replace(/^\/+|\/+$/g, "");
  }

  repoPath(p) {
    return this.root ? `${this.root}/${p}` : p;
  }

  enc(p) {
    return encodeURIComponent(this.repoPath(p)).replace(/%2F/g, "/");
  }

  async api(method, url, body) {
    const res = await this.fetch(`https://api.github.com/repos/${this.repo}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // B8: a 404 on a write means a wrong MEMORY_REPO or a token without access, not "missing file".
    if (res.status === 404 && method !== "GET") {
      throw new MemoryError(`GitHub says ${this.repo} doesn't exist or this token can't write to it. Check MEMORY_REPO and the token's repository access.`, { status: 404 });
    }
    if (res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    // B9: a brand-new repo with no commits answers 409 "Git Repository is empty" to tree/commit reads.
    if (res.status === 409 && method === "GET" && /empty/i.test(data.message || "")) return null;
    if (!res.ok) {
      throw new MemoryError(`GitHub ${method} ${url} failed (${res.status}): ${data.message || "unknown"}`, {
        status: res.status,
      });
    }
    return data;
  }

  async read(path, ref = this.branch) {
    const p = normalizePath(path);
    const data = await this.api("GET", `/contents/${this.enc(p)}?ref=${encodeURIComponent(ref)}`);
    if (!data) return null;
    if (Array.isArray(data) || data.type !== "file") throw new MemoryError(`${p} is not a file.`);
    return { path: p, content: b64decode(data.content || ""), version: data.sha };
  }

  /** Lists memory files with their blob SHA (used for incremental indexing). */
  async list(prefix = "") {
    const tree = await this.api("GET", `/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    if (!tree) return [];
    const base = this.root ? `${this.root}/` : "";
    const want = prefix.replace(/^\/+/, "");
    return tree.tree
      .filter((e) => e.type === "blob" && e.path.startsWith(base) && e.path.endsWith(".md"))
      .map((e) => ({ path: e.path.slice(base.length), size: e.size, version: e.sha }))
      .filter((e) => e.path.startsWith(want))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  commitMessage(summary, op) {
    return `${summary}\n\nMemory-Op: ${op}\nMemory-Source: ${this.source}`;
  }

  async write(path, content, ifVersion, op = "write") {
    const p = normalizePath(path);
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new MemoryError(`${p} would exceed ${MAX_FILE_BYTES} bytes. Run memory_consolidate or split it.`);
    }
    const current = await this.read(p);
    if (ifVersion === "new" && current) {
      throw new MemoryError(`${p} already exists. Read it and pass its version.`, { current });
    }
    if (ifVersion !== "new") {
      if (!current) throw new MemoryError(`${p} does not exist. Use if_version "new".`);
      if (!sameVersion(current.version, ifVersion)) {
        throw new MemoryError(`Version conflict on ${p}: file changed since you read it.`, { current });
      }
    }
    const res = await this.api("PUT", `/contents/${this.enc(p)}`, {
      message: this.commitMessage(`memory: ${op} ${p}`, op),
      content: b64encode(content),
      branch: this.branch,
      ...(current ? { sha: current.version } : {}),
    });
    return { path: p, version: res.content.sha, bytes: Buffer.byteLength(content, "utf8") };
  }

  async append(path, text, ifVersion, op = "append") {
    const p = normalizePath(path);
    if (ifVersion === "new") return this.write(p, text, "new", op);
    const current = await this.read(p);
    if (!current) throw new MemoryError(`${p} does not exist. Use if_version "new".`);
    const sep = !current.content || current.content.endsWith("\n") ? "" : "\n";
    return this.write(p, current.content + sep + text, ifVersion, op);
  }

  async replace(path, oldStr, newStr, ifVersion) {
    const p = normalizePath(path);
    const current = await this.read(p);
    if (!current) throw new MemoryError(`${p} does not exist.`);
    const count = current.content.split(oldStr).length - 1;
    if (count !== 1) {
      throw new MemoryError(`old_str matched ${count} times in ${p}; it must match exactly once.`, { current });
    }
    return this.write(p, current.content.replace(oldStr, () => newStr), ifVersion, "edit");
  }

  async delete(path, ifVersion) {
    const p = normalizePath(path);
    const current = await this.read(p);
    if (!current) throw new MemoryError(`${p} does not exist.`);
    if (!sameVersion(current.version, ifVersion)) {
      throw new MemoryError(`Version conflict on ${p}: re-read before deleting.`, { current });
    }
    await this.api("DELETE", `/contents/${this.enc(p)}`, {
      message: this.commitMessage(`memory: delete ${p}`, "delete"),
      sha: current.version,
      branch: this.branch,
    });
    return { path: p, deleted: true };
  }

  /** Distinct days with any memory commit since a date: the clock that decay runs on (idea from claude-memory-system). */
  async activeDays(sinceIso) {
    const days = new Set();
    for (let page = 1; page <= 5; page++) {
      const q = `sha=${encodeURIComponent(this.branch)}&since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`;
      const commits = (await this.api("GET", `/commits?${q}`)) || [];
      for (const c of commits) days.add((c.commit.committer?.date || c.commit.author?.date || "").slice(0, 10));
      if (commits.length < 100) break;
    }
    days.delete("");
    return [...days].sort();
  }

  /** Commit log for one file, newest first. */
  async history(path, limit = 20) {
    const p = normalizePath(path);
    const q = `path=${this.enc(p)}&sha=${encodeURIComponent(this.branch)}&per_page=${Math.min(limit, 100)}`;
    const commits = (await this.api("GET", `/commits?${q}`)) || [];
    return commits.map((c) => ({
      commit: c.sha,
      date: c.commit.committer?.date || c.commit.author?.date,
      message: c.commit.message.split("\n")[0],
    }));
  }

  /** The file as it existed at a point in time (time travel). */
  async at(path, isoDate) {
    const p = normalizePath(path);
    const until = new Date(isoDate);
    if (Number.isNaN(until.getTime())) throw new MemoryError(`Invalid date: ${isoDate}`);
    const q = `path=${this.enc(p)}&sha=${encodeURIComponent(this.branch)}&until=${until.toISOString()}&per_page=1`;
    const [commit] = (await this.api("GET", `/commits?${q}`)) || [];
    if (!commit) return { path: p, existed: false, as_of: until.toISOString() };
    const file = await this.read(p, commit.sha);
    if (!file) return { path: p, existed: false, as_of: until.toISOString() };
    return {
      path: p,
      existed: true,
      as_of: until.toISOString(),
      commit: commit.sha,
      committed_at: commit.commit.committer?.date,
      content: file.content,
    };
  }
}
