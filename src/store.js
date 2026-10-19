// GitHub-backed memory store. Every write is a commit; the blob SHA is the
// version token, so concurrent sessions can't silently overwrite each other.
import { isUtf8 } from "node:buffer";

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
  // Refuse, never repair: a permission check and the filesystem must read the exact same path. (This used to trim
  // spaces after the ACL had already looked at the untrimmed text, so " users/bob/x.md" slipped through.)
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) || /\p{Zs}/u.test(input.replace(/ /g, ""))) {
    throw new MemoryError(`Unsupported whitespace or control characters in path: ${JSON.stringify(input)}`);
  }
  const p = input.replace(/^\/+/, "");
  const segs = p.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "" || s !== s.trim())) {
    throw new MemoryError(`Invalid path: ${JSON.stringify(input)}`);
  }
  // refused: control characters, backslashes and characters that no common filesystem accepts everywhere,
  // hidden (dot-leading) names, and over-long names. Everything else is fine: "my notes.md", "café.md", "笔记.md".
  if (/[\u0000-\u001f\u007f\\<>:"|?*]/.test(p) || segs.some((s) => s.startsWith(".") || Buffer.byteLength(s) > 255)) {
    throw new MemoryError(`Unsupported file name (no control characters, backslashes or < > : " | ? *, no hidden names, 255 bytes max): ${input}`);
  }
  if (!p.endsWith(".md")) throw new MemoryError(`Memory files must end in .md: ${input}`);
  return p;
}

/** Versions may be passed as short handles (first 7+ chars of the blob SHA). */
export const sameVersion = (full, given) =>
  typeof given === "string" && given.length >= 7 && full.startsWith(given);
export const short = (v) => (v ? v.slice(0, 8) : v);

import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const blobSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

/** Minimal tar reader (ustar + pax long names), enough for GitHub's repository tarballs. */
export function* untar(buf) {
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    const name = longName || (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const body = buf.subarray(off + 512, off + 512 + size);
    longName = null;
    if (type === "x") {
      const m = body.toString("utf8").match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
    } else if (type === "0" || type === "\0") yield { name, body };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

const b64encode = (s) => Buffer.from(s, "utf8").toString("base64");
const b64decode = (s, p = "this note") => {
  const buf = Buffer.from(s, "base64");
  // see FileStore.read: decoding a non-UTF-8 note would replace bytes, and the next append would write the damage back
  if (!isUtf8(buf)) throw new MemoryError(`${p} isn't valid UTF-8 text, so githippo won't read or rewrite it (that would replace the bytes it can't decode). Convert it to UTF-8 first.`);
  return buf.toString("utf8");
};

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

  async api(method, url, body, { conditional = false } = {}) {
    // Conditional GETs: an unchanged tree answers 304, which is fast and free under GitHub's rate limit.
    this.etags ??= new Map();
    const cached = conditional ? this.etags.get(url) : null;
    const res = await this.fetch(`https://api.github.com/repos/${this.repo}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cached ? { "If-None-Match": cached.etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 304 && cached) return cached.data;
    if ((res.status === 403 || res.status === 429) && res.headers?.get?.("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      throw new MemoryError(`GitHub rate limit reached; resets at ${new Date(reset).toISOString().slice(11, 16)} UTC.`, { status: res.status });
    }
    // B8: a 404 on a write means a wrong MEMORY_REPO or a token without access, not "missing file".
    if (res.status === 404 && method !== "GET") {
      throw new MemoryError(`GitHub says ${this.repo} doesn't exist or this token can't write to it. Check MEMORY_REPO and the token's repository access.`, { status: 404 });
    }
    if (res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    // B9: a brand-new repo with no commits answers 409 "Git Repository is empty" to tree/commit reads.
    if (res.status === 409 && method === "GET" && /empty/i.test(data.message || "")) return null;
    if (conditional && res.ok && res.headers?.get?.("etag")) this.etags.set(url, { etag: res.headers.get("etag"), data });
    if (!res.ok) {
      throw new MemoryError(`GitHub ${method} ${url} failed (${res.status}): ${data.message || "unknown"}`, {
        status: res.status,
      });
    }
    return data;
  }

  /**
   * Cold start for big vaults: one tarball download instead of one API call per file. Contents are kept by
   * blob SHA, so readVersion() can serve any file whose version matches without another request.
   */
  async prefetch() {
    const res = await this.fetch(`https://api.github.com/repos/${this.repo}/tarball/${encodeURIComponent(this.branch)}`, {
      headers: { Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) return 0;
    this.blobs ??= new Map();
    let n = 0;
    for (const { name, body } of untar(gunzipSync(Buffer.from(await res.arrayBuffer())))) {
      if (!name.endsWith(".md")) continue;
      if (isUtf8(body)) this.blobs.set(blobSha(body), body.toString("utf8")); // a non-UTF-8 note isn't cached: reading it through the API reports it
      n++;
    }
    return n;
  }

  /** read() when the caller already knows the version it wants (index sync): served from the prefetch if possible. */
  async readVersion(path, version) {
    const hit = this.blobs?.get(version);
    if (hit !== undefined) {
      this.blobs.delete(version);
      return { path: normalizePath(path), content: hit, version };
    }
    return this.read(path);
  }

  async read(path, ref = this.branch) {
    const p = normalizePath(path);
    const data = await this.api("GET", `/contents/${this.enc(p)}?ref=${encodeURIComponent(ref)}`);
    if (!data) return null;
    if (Array.isArray(data) || data.type !== "file") throw new MemoryError(`${p} is not a file.`);
    // The contents API returns an empty body for files over 1 MB. Treating that as "empty note" would let append() replace
    // the whole note with one line, so refuse instead.
    if (data.encoding === "none" || (data.size > 0 && !data.content)) {
      throw new MemoryError(`${p} is ${data.size} bytes, too large to read through the GitHub API (1 MB limit), so githippo won't edit it. Split the note, or use a local vault.`);
    }
    return { path: p, content: b64decode(data.content || "", p), version: data.sha };
  }

  /** Lists memory files with their blob SHA (used for incremental indexing). */
  async list(prefix = "") {
    const tree = await this.api("GET", `/git/trees/${encodeURIComponent(this.branch)}?recursive=1`, null, { conditional: true });
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
    if (String(content).includes("\0")) throw new MemoryError("Content contains NUL bytes; memory files are text.");
    const p = normalizePath(path);
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new MemoryError(`${p} would exceed ${MAX_FILE_BYTES} bytes. Run memory_consolidate or split it.`);
    }
    // Fast path (one API call): with a full version or "new", let GitHub enforce it; it answers 409/422 if
    // the file changed or already exists, and only then do we read to report the conflict.
    const full = ifVersion === "new" || /^[0-9a-f]{40}$/.test(ifVersion || "");
    let current = full ? undefined : await this.read(p);
    if (!full) {
      if (!current) throw new MemoryError(`${p} does not exist. Use if_version "new".`);
      if (!sameVersion(current.version, ifVersion)) throw new MemoryError(`Version conflict on ${p}: file changed since you read it.`, { current });
    }
    try {
      const res = await this.api("PUT", `/contents/${this.enc(p)}`, {
        message: this.commitMessage(`memory: ${op} ${p}`, op),
        content: b64encode(content),
        branch: this.branch,
        ...(ifVersion === "new" ? {} : { sha: current ? current.version : ifVersion }),
      });
      return { path: p, version: res.content.sha, bytes: Buffer.byteLength(content, "utf8") };
    } catch (e) {
      if (!(e instanceof MemoryError) || ![409, 422].includes(e.status)) throw e;
      current = await this.read(p);
      if (ifVersion === "new" && current) throw new MemoryError(`${p} already exists. Read it and pass its version.`, { current });
      if (!current) throw new MemoryError(`${p} does not exist. Use if_version "new".`);
      throw new MemoryError(`Version conflict on ${p}: file changed since you read it.`, { current });
    }
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
