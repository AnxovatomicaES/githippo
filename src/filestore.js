// Local vault: memory as Markdown files in a folder that is also a git repo (~/.githippo/vault by default).
// No GitHub account, repo or token needed. Versions are git blob SHAs, the same values the GitHub API
// uses, so a vault can move between local and remote without any conversion. If a git remote is set,
// commits are pushed in the background with the user's existing git credentials (gh, SSH, keychain).
import { lstat, mkdir, open as openFile, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { KeyedMutex, withFileLock } from "./lock.js";
import { join, dirname, sep } from "node:path";
import { MemoryError, MAX_FILE_BYTES, normalizePath, sameVersion } from "./store.js";

/** The real git directory (in a linked worktree, .git is a FILE pointing elsewhere), or null if this isn't a repository. */
export function gitDirOf(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Name of an unfinished git operation in this repository (merge, rebase, bisect…, or a detached HEAD), or null. */
export function gitBusyState(dir, gitDir = gitDirOf(dir)) {
  if (!gitDir) return null;
  for (const [f, name] of [["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"], ["sequencer", "cherry-pick sequence"]]) {
    if (existsSync(join(gitDir, f))) return name;
  }
  try {
    if (!readFileSync(join(gitDir, "HEAD"), "utf8").startsWith("ref: ")) return "detached HEAD (check out a branch)";
  } catch {}
  return null;
}

/** An unresolved merge/rebase leaves these in a file; their contents are not facts. */
export const hasConflictMarkers = (c) => /^<{7}( |$)/m.test(c) && /^={7}$/m.test(c) && /^>{7}( |$)/m.test(c);

export const blobSha = (content) => {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
};

/**
 * Environment for every git process githippo starts. Note paths come from users and models, so they are literal
 * (a `[s]ecret` in a path must not glob onto a note the caller can't read); nothing may stop to ask for a password on
 * a terminal nobody is watching (the MCP server pushes in the background); ssh must fail instead of prompting.
 */
export const gitEnv = (env = process.env) => ({ ...env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" });
/** Vault commits are made by githippo, not by whatever signing or hook setup the user's global git config has (GIT_SIGN=1 opts in to signing). */
const COMMIT_AS_GITHIPPO = ["-c", "user.name=githippo", "-c", "user.email=githippo@localhost", "-c", "commit.gpgsign=false"];

const run = (cwd, args, timeout = 10_000) =>
  new Promise((resolve) =>
    execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 32 << 20, env: gitEnv() }, (err, stdout, stderr) =>
      resolve({ ok: !err, raw: String(stdout), out: String(stdout).trim(), err: String(stderr).trim() }),
    ),
  );

export class FileStore {
  constructor({ dir, root = "memory", source = "githippo", autoPush = true, pushGuard = null } = {}) {
    if (!dir) throw new MemoryError("VAULT_DIR is not set.");
    Object.assign(this, { dir, source, autoPush, pushGuard }); // pushGuard(store) → false vetoes a push (see remote.js)
    this.root = root.replace(/^\/+|\/+$/g, "");
    this.base = this.root ? join(dir, this.root) : dir;
    this.repo = `local:${dir}`;
    this.meta = new Map(); // path -> { mtimeMs, size, sha }
    this.queue = Promise.resolve(); // serialises git commits within this process
    this.mutex = new KeyedMutex(); // serialises writes to the same file within this process
  }

  /** Read-check-write of one file must be atomic: in-process mutex + cross-process lock file in .git. */
  locked(path, fn) {
    return this.mutex.run(path, () => withFileLock(this.lockDir(), path, fn));
  }

  /** The real git directory (cached once found): in a linked worktree .git is a file, and the state lives elsewhere. */
  realGitDir() {
    return (this.gitDirCache ||= gitDirOf(this.dir));
  }

  /** Locks live inside the git directory (never committed); outside a repository, in .githippo. */
  lockDir() {
    const g = this.realGitDir();
    return g ? join(g, "githippo-locks") : join(this.dir, ".githippo", "locks");
  }

  abs(p) {
    return join(this.base, p);
  }

  /**
   * False when `f` is a symlink or resolves outside the vault. A collaborator (or a compromised remote) can push a
   * symlink named like a note; without this, recall would read whatever it points at, and a write would go through it.
   * Missing files and errors count as inside: the caller's own read or write reports those.
   */
  async inside(f) {
    try {
      if ((await lstat(f)).isSymbolicLink()) return false;
      this.realBase ??= await realpath(this.base);
      const real = await realpath(f);
      return real === this.realBase || real.startsWith(this.realBase + sep);
    } catch {
      return true;
    }
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
        // an existing .gitignore (an Obsidian vault being adopted) is added to, never replaced
        const ignorePath = join(this.dir, ".gitignore");
        const have = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
        const want = [".obsidian/workspace*", ".DS_Store", "*.tmp"].filter((l) => !have.split("\n").includes(l));
        if (want.length) await writeFile(ignorePath, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${want.join("\n")}\n`);
        await this.git(["add", ".gitignore"]);
        await this.git([...COMMIT_AS_GITHIPPO, "commit", "-q", "--no-verify", "-m", "githippo: new memory vault"]);
        this.gitOk = undefined;
      }
    }
    return this;
  }

  /** Changes whenever any process commits to the vault: lets every server notice other writers at once. */
  stateToken() {
    try {
      const head = readFileSync(join(this.dir, ".git", "HEAD"), "utf8").trim();
      const ref = head.startsWith("ref: ") ? head.slice(5) : null;
      if (!ref) return head;
      const refFile = join(this.dir, ".git", ref);
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim();
      return `${statSync(join(this.dir, ".git", "packed-refs")).mtimeMs}`;
    } catch {
      return null;
    }
  }

  async read(path, ref) {
    const p = normalizePath(path);
    if (ref && ref !== "HEAD") {
      const r = await this.git(["show", `${ref}:${this.root ? `${this.root}/` : ""}${p}`]);
      return r.ok ? { path: p, content: r.raw, version: blobSha(r.raw) } : null;
    }
    const f = this.abs(p);
    if (!(await this.inside(f))) return null; // a symlink is not a note
    let content;
    for (let attempt = 0; ; attempt++) {
      try {
        const buf = await readFile(f);
        // A note in another encoding (Latin-1 from an old editor…) can't be decoded without replacing bytes with U+FFFD, and the next
        // append or edit would write that damage back over the user's file. So such a note is reported, never read or rewritten.
        if (!isUtf8(buf)) throw new MemoryError(`${p} isn't valid UTF-8 text, so githippo won't read or rewrite it (that would replace the bytes it can't decode). Convert it to UTF-8 first.`);
        content = buf.toString("utf8");
        break;
      } catch (e) {
        if (["ENOENT", "EISDIR", "ENOTDIR"].includes(e.code)) return null; // genuinely not a file
        // out of file descriptors (EMFILE/ENFILE): wait for others to close theirs; anything else is a real error
        if (["EMFILE", "ENFILE"].includes(e.code) && attempt < 10) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    return { path: p, content, version: blobSha(content) };
  }

  async list(prefix = "") {
    const out = [];
    const skipped = [];
    const walk = async (dir, rel) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.isSymbolicLink()) continue; // symlinks are never notes (and one to a FIFO would hang the listing)
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (e.name.endsWith(".md") && r.startsWith(prefix)) {
          const full = join(dir, e.name);
          // A file can vanish or be replaced between readdir and stat (an editor's temp-file save, a sync tool, a git
          // checkout, a deletion). That used to throw out of the whole listing, failing every recall and write.
          for (let attempt = 0; ; attempt++) {
            try {
              const st = await stat(full);
              let m = this.meta.get(r);
              if (!m || m.mtimeMs !== st.mtimeMs || m.size !== st.size) {
                m = { mtimeMs: st.mtimeMs, size: st.size, sha: blobSha(await readFile(full, "utf8")) };
                this.meta.set(r, m);
              }
              out.push({ path: r, size: st.size, version: m.sha });
              break;
            } catch (err) {
              if (["ENOENT", "ENOTDIR", "EISDIR"].includes(err.code)) break; // gone already: not part of the vault any more
              if (["EMFILE", "ENFILE"].includes(err.code) && attempt < 10) {
                await new Promise((res) => setTimeout(res, 20 * (attempt + 1)));
                continue;
              }
              if (["EMFILE", "ENFILE"].includes(err.code)) throw err;
              skipped.push(`${r}: ${err.code || err.message}`); // unreadable (permissions…): skipped and reported, never fatal
              break;
            }
          }
        }
      }
    };
    await walk(this.base, "");
    if (skipped.length) console.error(`[githippo] ${skipped.length} note(s) couldn't be read and were skipped: ${skipped.slice(0, 3).join(" | ")}`);
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
      // never commit (or push) conflict markers: they would be indexed and recalled as facts
      const conflicted = await this.conflictedFiles();
      if (conflicted.length) {
        this.pendingCommit = true;
        console.error(`[githippo] not committing: unresolved conflicts in ${conflicted.slice(0, 3).join(", ")}. Resolve them in git.`);
        return;
      }
      const locked = (r) => /index\.lock|Unable to create|cannot lock ref|another git process/i.test(r.err);
      const started = Date.now();
      for (let attempt = 0; attempt < 25; attempt++) {
        // checked first, so every retry path passes through it: never hold the caller more than ~3 s; the file
        // is already safely on disk, and a background timer commits it as soon as git is free
        if (attempt > 0 && Date.now() - started > 3000) {
          this.pendingCommit = true;
          this.scheduleCommitRetry(summary, op);
          break;
        }
        const add = await this.git(["add", "-A", "--", scope]);
        if (!add.ok && locked(add)) {
          await new Promise((res) => setTimeout(res, 40 + Math.random() * 120 * (1 + attempt / 4)));
          continue;
        }
        // GIT_SIGN=1: sign with the user's own git identity and signing key (GPG or SSH), so tampering is detectable
        const sign = process.env.GIT_SIGN === "1" ? ["commit", "-q", "-S"] : [...COMMIT_AS_GITHIPPO, "commit", "-q", "--no-verify"];
        const c = await this.git([...sign, "-m", `${summary}\n\nMemory-Op: ${op}\nMemory-Source: ${this.source}`, "--", scope]);
        if (c.ok || /nothing to commit|no changes added/i.test(c.out + c.err)) {
          this.pendingCommit = false;
          break; // done, or another process committed it for us
        }
        if (!locked(c)) {
          console.error(`[githippo] git commit failed: ${c.err.split("\n")[0]}`);
          break;
        }
        if (attempt === 24) {
          // git is busy for a long time (e.g. the user is running git): the file is safely on disk; keep
          // trying to commit in the background instead of waiting for the next write
          this.pendingCommit = true;
          this.scheduleCommitRetry(summary, op);
          break;
        }
        await new Promise((res) => setTimeout(res, 40 + Math.random() * 120 * (1 + attempt / 4)));
      }
      if (this.autoPush) this.schedulePush();
    });
    return this.queue;
  }

  scheduleCommitRetry(summary, op, tries = 0) {
    clearTimeout(this.commitRetry);
    if (tries > 60) return;
    this.commitRetry = setTimeout(async () => {
      const add = await this.git(["add", "-A", "--", this.root || "."]);
      const c = add.ok ? await this.git([...COMMIT_AS_GITHIPPO, "commit", "-q", "--no-verify", "-m", `${summary}\n\nMemory-Op: ${op}\nMemory-Source: ${this.source}`, "--", this.root || "."]) : add;
      if (c.ok || /nothing to commit/i.test(c.out + c.err)) this.pendingCommit = false;
      else this.scheduleCommitRetry(summary, op, tries + 1);
    }, 2000);
    this.commitRetry.unref?.();
  }

  schedulePush() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(async () => {
      const remote = await this.git(["remote"]);
      if (!remote.ok || !remote.out) return;
      if (this.pushGuard && !(await this.pushGuard(this).catch(() => true))) return;
      await this.git(["push", "-q", "origin", "HEAD"], 30_000);
    }, 4000);
    this.pushTimer.unref?.();
  }

  async write(path, content, ifVersion, op = "write") {
    if (String(content).includes("\0")) throw new MemoryError("Content contains NUL bytes; memory files are text.");
    const p = normalizePath(path);
    return this.locked(p, () => this._write(p, content, ifVersion, op));
  }

  async _write(p, content, ifVersion, op) {
    const busy = this.busyState();
    if (busy) throw new MemoryError(`The vault has an unfinished git ${busy}. Finish or abort it (git ${busy.split(" ")[0]} --abort) before saving memory.`);
    const unmerged = await this.git(["ls-files", "-u"]);
    if (unmerged.ok && unmerged.out) throw new MemoryError("The vault has unresolved merge conflicts. Resolve them in git first; githippo won't write over them.");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new MemoryError(`${p} would exceed ${MAX_FILE_BYTES} bytes. Run maintain or split it.`);
    }
    const current = await this.read(p);
    if (current && hasConflictMarkers(current.content)) throw new MemoryError(`${p} contains unresolved git conflict markers (<<<<<<<). Resolve them first.`);
    if (ifVersion === "new" && current) throw new MemoryError(`${p} already exists. Read it and pass its version.`, { current });
    if (ifVersion !== "new") {
      if (!current) throw new MemoryError(`${p} does not exist. Use if_version "new".`);
      if (!sameVersion(current.version, ifVersion)) throw new MemoryError(`Version conflict on ${p}: file changed since you read it.`, { current });
    }
    const f = this.abs(p);
    await mkdir(dirname(f), { recursive: true });
    if (!(await this.inside(dirname(f)))) throw new MemoryError(`${p} is behind a symbolic link; githippo won't write through it.`);
    // atomic + crash-safe: unique temp name, data flushed to disk, then rename over the original
    const tmp = `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fh = await openFile(tmp, "w");
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, f);
    await this.commit([p], `memory: ${op} ${p}`, op);
    return { path: p, version: blobSha(content), bytes: Buffer.byteLength(content, "utf8"), ...(this.pendingCommit ? { committed: false } : {}) };
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
    return this.locked(p, () => this._delete(p, ifVersion));
  }

  async _delete(p, ifVersion) {
    const busy = this.busyState();
    if (busy) throw new MemoryError(`The vault has an unfinished git ${busy}. Finish or abort it (git ${busy.split(" ")[0]} --abort) before changing memory.`);
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
    // %cI is the committer's local time with an offset; callers get UTC ("…Z") so timestamps compare and display unambiguously
    return r.ok && r.out ? r.out.split("\n").map((l) => { const [commit, date, message] = l.split("\t"); return { commit, date: new Date(date).toISOString(), message }; }) : [];
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
    return file.ok ? { path: p, existed: true, as_of, commit, committed_at: new Date(committed_at).toISOString(), content: file.raw } : { path: p, existed: false, as_of };
  }

  async activeDays(sinceIso) {
    if (!(await this.hasGit())) return [new Date().toISOString().slice(0, 10)];
    const r = await this.git(["log", `--since=${sinceIso}`, "--format=%cs"]);
    return r.ok ? [...new Set(r.out.split("\n").filter(Boolean))].sort() : [];
  }

  /** Pull other devices' changes (no-op without a remote). */
  async pull() {
    // a vault folder inside someone else's repository has no .git of its own: git would find the OUTER one and pull it
    if (!(await this.hasGit())) return false;
    const remote = await this.git(["remote"]);
    if (!remote.ok || !remote.out) return false;
    // Never touch an operation we didn't start: your own unfinished merge or rebase (and the edits you resolved by hand)
    // would be aborted and lost by the rollback below.
    const busy = this.busyState();
    if (busy) {
      console.error(`[githippo] not syncing: the vault has an unfinished git ${busy}. Finish or abort it yourself; githippo leaves it alone.`);
      return false;
    }
    const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).out || "main";
    const r = await this.git([...COMMIT_AS_GITHIPPO, "pull", "-q", "--rebase", "--autostash", "origin", branch], 30_000);
    const started = this.busyState(); // a rebase or merge that THIS pull started and couldn't finish
    if (!r.ok || started) {
      if (started === "rebase") await this.git(["rebase", "--abort"]);
      else if (started === "merge") await this.git(["merge", "--abort"]);
      console.error(`[githippo] sync with the remote failed and was rolled back (${r.err.split("\n")[0].slice(0, 100)}). Resolve it with git in ${this.dir}.`);
      return false;
    }
    // `pull --rebase --autostash` can exit 0 while re-applying your stash conflicted, leaving markers in your files
    const bad = await this.conflictedFiles();
    if (bad.length) {
      console.error(`[githippo] the remote changes conflict with edits you hadn't committed (${bad.slice(0, 3).join(", ")}). Your edits are safe in the git stash; resolve it in ${this.dir}. githippo won't commit these files until then.`);
      return false;
    }
    return true;
  }

  /** Files with unresolved merge conflicts (unmerged index entries, or conflict markers in changed notes). */
  async conflictedFiles() {
    const names = new Set();
    const u = await this.git(["ls-files", "-u"]);
    if (u.ok) for (const l of u.out.split("\n")) if (l.split("\t")[1]) names.add(l.split("\t")[1]);
    const scope = this.root || ".";
    for (const out of [await this.git(["diff", "--name-only", "HEAD", "--", scope]), await this.git(["ls-files", "-o", "--exclude-standard", "--", scope])]) {
      if (!out.ok) continue;
      for (const p of out.out.split("\n").filter(Boolean).slice(0, 200)) {
        if (!p.endsWith(".md")) continue;
        try {
          if (hasConflictMarkers(readFileSync(join(this.dir, p), "utf8"))) names.add(p);
        } catch {}
      }
    }
    return [...names];
  }

  /** Name of an unfinished git operation (merge, rebase, bisect…) or a detached HEAD in the vault, or null. */
  busyState() {
    return gitBusyState(this.dir, this.realGitDir());
  }
}
