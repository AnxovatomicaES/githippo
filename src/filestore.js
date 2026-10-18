// Local vault: memory as Markdown files in a folder that is also a git repo (~/.githippo/vault by default).
// No GitHub account, repo or token needed. Versions are git blob SHAs, the same values the GitHub API
// uses, so a vault can move between local and remote without any conversion. If a git remote is set,
// commits are pushed in the background with the user's existing git credentials (gh, SSH, keychain).
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { MemoryError, MAX_FILE_BYTES, normalizePath, sameVersion } from "./store.js";

export const blobSha = (content) => {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
};

const run = (cwd, args, timeout = 10_000) =>
  new Promise((resolve) =>
    execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, raw: String(stdout), out: String(stdout).trim(), err: String(stderr).trim() }),
    ),
  );

export class FileStore {
  constructor({ dir, root = "memory", source = "githippo", autoPush = true } = {}) {
    if (!dir) throw new MemoryError("VAULT_DIR is not set.");
    Object.assign(this, { dir, source, autoPush });
    this.root = root.replace(/^\/+|\/+$/g, "");
    this.base = this.root ? join(dir, this.root) : dir;
    this.repo = `local:${dir}`;
    this.meta = new Map(); // path -> { mtimeMs, size, sha }
    this.queue = Promise.resolve(); // serialises git commits within this process
  }

  abs(p) {
    return join(this.base, p);
  }

  async git(args, timeout) {
    return run(this.dir, args, timeout);
  }

  async hasGit() {
    return (this.gitOk ??= existsSync(join(this.dir, ".git")) && (await this.git(["rev-parse", "--git-dir"])).ok);
  }

  /** Creates the vault (and a git repo) if needed. Safe to call repeatedly. */
  async ensure() {
    await mkdir(this.base, { recursive: true });
    if (!existsSync(join(this.dir, ".git"))) {
      const r = await this.git(["init", "-q", "-b", "main"]);
      if (r.ok) {
        await writeFile(join(this.dir, ".gitignore"), ".obsidian/workspace*\n.DS_Store\n*.tmp\n");
        await this.git(["add", ".gitignore"]);
        await this.git(["-c", "user.name=githippo", "-c", "user.email=githippo@localhost", "commit", "-q", "-m", "githippo: new memory vault"]);
        this.gitOk = undefined;
      }
    }
    return this;
  }

  async read(path, ref) {
    const p = normalizePath(path);
    if (ref && ref !== "HEAD") {
      const r = await this.git(["show", `${ref}:${this.root ? `${this.root}/` : ""}${p}`]);
      return r.ok ? { path: p, content: r.raw, version: blobSha(r.raw) } : null;
    }
    const f = this.abs(p);
    let content;
    try {
      content = await readFile(f, "utf8");
    } catch {
      return null;
    }
    return { path: p, content, version: blobSha(content) };
  }

  async list(prefix = "") {
    const out = [];
    const walk = async (dir, rel) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (e.name.endsWith(".md") && r.startsWith(prefix)) {
          const full = join(dir, e.name);
          const st = await stat(full);
          let m = this.meta.get(r);
          if (!m || m.mtimeMs !== st.mtimeMs || m.size !== st.size) {
            m = { mtimeMs: st.mtimeMs, size: st.size, sha: blobSha(await readFile(full, "utf8")) };
            this.meta.set(r, m);
          }
          out.push({ path: r, size: st.size, version: m.sha });
        }
      }
    };
    await walk(this.base, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Commits pending changes under the memory folder. Several processes (MCP server, hooks) may commit at
   * once; git's index.lock makes one of them fail, so both steps retry with jittered backoff. The whole
   * folder is staged each time, so a change another process left uncommitted is swept into the next commit
   * (files are written by atomic rename, so there's never a half-written file to sweep).
   */
  async commit(paths, summary, op) {
    if (!(await this.hasGit())) return;
    const scope = this.root || ".";
    this.queue = this.queue.then(async () => {
      const locked = (r) => /index\.lock|Unable to create|cannot lock ref|another git process/i.test(r.err);
      for (let attempt = 0; attempt < 25; attempt++) {
        const add = await this.git(["add", "-A", "--", scope]);
        if (!add.ok && locked(add)) {
          await new Promise((res) => setTimeout(res, 40 + Math.random() * 120 * (1 + attempt / 4)));
          continue;
        }
        // GIT_SIGN=1: sign with the user's own git identity and signing key (GPG or SSH), so tampering is detectable
        const sign = process.env.GIT_SIGN === "1" ? ["commit", "-q", "-S"] : ["-c", "user.name=githippo", "-c", "user.email=githippo@localhost", "commit", "-q"];
        const c = await this.git([...sign, "-m", `${summary}\n\nMemory-Op: ${op}\nMemory-Source: ${this.source}`, "--", scope]);
        if (c.ok || /nothing to commit|no changes added/i.test(c.out + c.err)) break; // done, or another process committed it for us
        if (!locked(c)) {
          console.error(`[githippo] git commit failed: ${c.err.split("\n")[0]}`);
          break;
        }
        await new Promise((res) => setTimeout(res, 40 + Math.random() * 120 * (1 + attempt / 4)));
      }
      if (this.autoPush) this.schedulePush();
    });
    return this.queue;
  }

  schedulePush() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(async () => {
      const remote = await this.git(["remote"]);
      if (remote.ok && remote.out) await this.git(["push", "-q", "origin", "HEAD"], 30_000);
    }, 4000);
    this.pushTimer.unref?.();
  }

  async write(path, content, ifVersion, op = "write") {
    const p = normalizePath(path);
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new MemoryError(`${p} would exceed ${MAX_FILE_BYTES} bytes. Run maintain or split it.`);
    }
    const current = await this.read(p);
    if (ifVersion === "new" && current) throw new MemoryError(`${p} already exists. Read it and pass its version.`, { current });
    if (ifVersion !== "new") {
      if (!current) throw new MemoryError(`${p} does not exist. Use if_version "new".`);
      if (!sameVersion(current.version, ifVersion)) throw new MemoryError(`Version conflict on ${p}: file changed since you read it.`, { current });
    }
    const f = this.abs(p);
    await mkdir(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content); // atomic: readers never see a half-written file
    await rename(tmp, f);
    await this.commit([p], `memory: ${op} ${p}`, op);
    return { path: p, version: blobSha(content), bytes: Buffer.byteLength(content, "utf8") };
  }

  async append(path, text, ifVersion, op = "append") {
    const p = normalizePath(path);
    if (ifVersion === "new") return this.write(p, text, "new", op);
    const cur = await this.read(p);
    if (!cur) throw new MemoryError(`${p} does not exist. Use if_version "new".`);
    const sep = !cur.content || cur.content.endsWith("\n") ? "" : "\n";
    return this.write(p, cur.content + sep + text, ifVersion, op);
  }

  async replace(path, oldStr, newStr, ifVersion) {
    const p = normalizePath(path);
    const cur = await this.read(p);
    if (!cur) throw new MemoryError(`${p} does not exist.`);
    const count = cur.content.split(oldStr).length - 1;
    if (count !== 1) throw new MemoryError(`old_str matched ${count} times in ${p}; it must match exactly once.`, { current: cur });
    return this.write(p, cur.content.replace(oldStr, () => newStr), ifVersion, "edit");
  }

  async delete(path, ifVersion) {
    const p = normalizePath(path);
    const cur = await this.read(p);
    if (!cur) throw new MemoryError(`${p} does not exist.`);
    if (!sameVersion(cur.version, ifVersion)) throw new MemoryError(`Version conflict on ${p}: re-read before deleting.`, { current: cur });
    await rm(this.abs(p));
    this.meta.delete(p);
    await this.commit([p], `memory: delete ${p}`, "delete");
    return { path: p, deleted: true };
  }

  relPath(p) {
    return this.root ? `${this.root}/${normalizePath(p)}` : normalizePath(p);
  }

  async history(path, limit = 20) {
    if (!(await this.hasGit())) return [];
    const r = await this.git(["log", `-n${Math.min(limit, 100)}`, "--format=%H%x09%cI%x09%s", "--", this.relPath(path)]);
    return r.ok && r.out ? r.out.split("\n").map((l) => { const [commit, date, message] = l.split("\t"); return { commit, date, message }; }) : [];
  }

  async at(path, isoDate) {
    const p = normalizePath(path);
    const until = new Date(isoDate);
    if (Number.isNaN(until.getTime())) throw new MemoryError(`Invalid date: ${isoDate}`);
    const as_of = until.toISOString();
    if (!(await this.hasGit())) return { path: p, existed: false, as_of };
    const r = await this.git(["log", "-1", `--before=${as_of}`, "--format=%H%x09%cI", "--", this.relPath(p)]);
    if (!r.ok || !r.out) return { path: p, existed: false, as_of };
    const [commit, committed_at] = r.out.split("\t");
    const file = await this.git(["show", `${commit}:${this.relPath(p)}`]);
    return file.ok ? { path: p, existed: true, as_of, commit, committed_at, content: file.raw } : { path: p, existed: false, as_of };
  }

  async activeDays(sinceIso) {
    if (!(await this.hasGit())) return [new Date().toISOString().slice(0, 10)];
    const r = await this.git(["log", `--since=${sinceIso}`, "--format=%cs"]);
    return r.ok ? [...new Set(r.out.split("\n").filter(Boolean))].sort() : [];
  }

  /** Pull other devices' changes (no-op without a remote). */
  async pull() {
    const remote = await this.git(["remote"]);
    if (!remote.ok || !remote.out) return false;
    const r = await this.git(["pull", "-q", "--rebase", "--autostash", "origin", "main"], 30_000);
    return r.ok;
  }
}
