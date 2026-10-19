// Users and per-folder access control for multi-user (remote) vaults.
//
// users.json (or USERS_JSON env on hosts without a disk):
//   { "users": [ { "id": "marcel", "hash": "scrypt$…", "acl": [ { "path": "", "access": "write" } ] },
//                { "id": "john",   "hash": "scrypt$…", "acl": [ { "path": "shared/", "access": "write" },
//                                                                { "path": "people/", "access": "read" } ] } ] }
//
// Rules: longest matching path prefix wins; access is none | read | write; everything else is denied.
// Every user can always read and write their own users/<id>/ folder (personal inbox, sessions, core).
// With no users configured, a single "owner" with full access logs in with MCP_SECRET.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryError, normalizePath } from "./store.js";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const LEVEL = { none: 0, read: 1, write: 2 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt") return false;
  const want = Buffer.from(hash, "base64url");
  const got = scryptSync(String(password), Buffer.from(salt, "base64url"), want.length, { N: +N, r: +r, p: +p });
  return got.length === want.length && timingSafeEqual(got, want);
}

const safeEqual = (a, b) => {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
};

/**
 * A rule path is a FOLDER ("shared/", also written "shared") or one exact note ("people/ada.md"), never a bare
 * string prefix: "shared:read" must not open "shared-secret/", and "users/ali:read" must not open "users/alice/".
 */
const normRule = (path) => {
  let s = String(path || "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (s && !s.endsWith("/") && !s.endsWith(".md")) s += "/";
  return s;
};
/**
 * The path as a permission check may read it, or null (= deny) if it contains anything a filesystem or a trim() could
 * interpret differently: control or invisible characters, non-space whitespace (tab, NBSP…), backslashes, "."/".."
 * segments, or segments with leading/trailing spaces.
 */
export function canonAclPath(path) {
  const s = String(path ?? "");
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(s) || /\p{Zs}/u.test(s.replace(/ /g, ""))) return null;
  const p = s.replace(/^\/+/, "");
  for (const seg of p.split("/")) if (seg === "." || seg === ".." || seg !== seg.trim()) return null;
  return p;
}
// macOS and Windows filesystems treat Users/ and users/ as the same folder, and Unicode forms as the same name
const fold = (s) => s.normalize("NFC").toLowerCase();

export const ruleMatches = (rulePath, p) => rulePath === "" || (rulePath.endsWith("/") ? p.startsWith(rulePath) : p === rulePath);

export class Acl {
  constructor(user) {
    this.user = user.id;
    // the user's own home folder is always writable; listed first so it wins a tie with an equal-length rule
    this.rules = [
      { path: `users/${user.id}/`, access: "write" },
      ...(user.acl || []).map((r) => ({ path: normRule(r.path), access: r.access })),
    ].sort((a, b) => b.path.length - a.path.length);
    this.isAdmin = this.level("") === LEVEL.write && this.rules.every((r) => r.access !== "none" || r.path.startsWith("users/"));
  }

  level(path) {
    const p = canonAclPath(path);
    if (p === null) return 0;
    const key = fold(p);
    // Another user's users/<id>/ folder is private: only a rule that names users/ explicitly can open it,
    // never a catch-all like ":read".
    const me = fold(`users/${this.user}/`);
    const othersPrivate = key.startsWith("users/") && !key.startsWith(me);
    for (const r of this.rules) {
      if (!ruleMatches(fold(r.path), key)) continue; // the winning rule is chosen case-insensitively…
      if (othersPrivate && !fold(r.path).startsWith("users/")) return 0;
      const lvl = LEVEL[r.access] ?? 0;
      // …a deny always applies, but a grant only applies to the exact spelling it names ("Users/bob" is not "users/bob")
      if (lvl > 0 && !ruleMatches(r.path, p)) return 0;
      return lvl;
    }
    return 0;
  }

  canRead(path) {
    return this.level(path) >= LEVEL.read;
  }

  canWrite(path) {
    return this.level(path) >= LEVEL.write;
  }

  home(file) {
    return `users/${this.user}/${file}`;
  }
}

export const ALLOW_ALL = Object.freeze({ user: null, isAdmin: true, canRead: () => true, canWrite: () => true, home: (f) => f });

export class Accounts {
  constructor({ users = [], ownerSecret = "", file = null } = {}) {
    this.file = file;
    this.ownerSecret = ownerSecret;
    this.users = new Map(users.map((u) => [u.id, u]));
  }

  static load({ env = process.env, file } = {}) {
    let users = [];
    let loadError = null;
    try {
      users = JSON.parse(env.USERS_JSON || readFileSync(file, "utf8")).users || [];
    } catch (e) {
      if (env.USERS_JSON || e.code !== "ENOENT") loadError = e.message; // a missing file is fine; a broken one must not be "fixed" by overwriting it
    }
    const a = new Accounts({ users: users.filter((u) => u && typeof u.id === "string" && ID_RE.test(u.id)), ownerSecret: env.MCP_SECRET, file });
    a.fromEnv = !!env.USERS_JSON;
    a.loadError = loadError;
    a.mtime = a.fileMtime();
    return a;
  }

  fileMtime() {
    try {
      return this.file ? statSync(this.file).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  /** Re-read the users file if it changed, so removing or resetting a user takes effect on the next request. */
  refresh() {
    if (this.fromEnv || !this.file) return;
    const m = this.fileMtime();
    if (m === this.mtime) return;
    this.mtime = m;
    try {
      const users = JSON.parse(readFileSync(this.file, "utf8")).users || [];
      this.users = new Map(users.filter((u) => u && typeof u.id === "string" && ID_RE.test(u.id)).map((u) => [u.id, u]));
    } catch {}
  }

  get multiUser() {
    return this.users.size > 0;
  }

  /** Changing a user's password or ACL changes this, which invalidates their tokens. */
  version(user) {
    return createHash("sha256").update(JSON.stringify([user.id, user.hash || "", user.acl || []])).digest("base64url").slice(0, 12);
  }

  get(id) {
    if (!this.multiUser) return id === "owner" && this.ownerSecret ? { id: "owner", acl: [{ path: "", access: "write" }] } : null;
    return this.users.get(id) || null;
  }

  verify(id, password) {
    if (!this.multiUser) return id === "owner" && safeEqual(password, this.ownerSecret) ? this.get("owner") : null;
    const u = this.users.get(String(id || "").toLowerCase());
    // always run scrypt so response time doesn't reveal which usernames exist
    const ok = verifyPassword(password, u?.hash || "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    return u && ok ? u : null;
  }

  add(id, acl) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new MemoryError("User ids are lowercase letters, digits, '.', '_' or '-' (max 40).");
    for (const r of acl) if (!(r.access in LEVEL)) throw new MemoryError(`Unknown access "${r.access}" (use none, read or write).`);
    const password = randomBytes(18).toString("base64url");
    this.users.set(id, { id, hash: hashPassword(password), acl });
    return password;
  }

  remove(id) {
    return this.users.delete(id);
  }

  save() {
    if (!this.file) throw new MemoryError("No users file to save to.");
    // a users file that failed to parse (a trailing comma…) is NOT empty: overwriting it would delete every other user
    if (this.loadError) throw new MemoryError(`${this.file} could not be read (${this.loadError}). Fix it, or restore ${this.file}.bak, before changing users; nothing was written.`);
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      copyFileSync(this.file, `${this.file}.bak`); // one step of undo
    } catch {}
    writeFileSync(this.file, JSON.stringify({ users: [...this.users.values()] }, null, 2), { mode: 0o600 });
  }
}

/** "shared/:write,people/:read,:none" → ACL rules. An empty path means the whole vault. */
export function parseAcl(spec) {
  return String(spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(":");
      return { path: s.slice(0, i).replace(/^\/+/, ""), access: s.slice(i + 1) };
    });
}

/** A store view that enforces an ACL and attributes every commit to the user. */
export class AclStore {
  constructor(store, acl) {
    this.base = store;
    this.acl = acl;
    this.repo = store.repo;
  }

  deny(path, what) {
    throw new MemoryError(`${this.acl.user} has no ${what} access to ${path}.`);
  }

  /** The one canonical note path used for BOTH the permission check and the store call. */
  canon(path) {
    return normalizePath(path);
  }

  async read(path, ref) {
    const p = this.canon(path);
    if (!this.acl.canRead(p)) this.deny(p, "read");
    return this.base.read(p, ref);
  }

  async list(prefix = "") {
    const pre = canonAclPath(prefix);
    if (pre === null) throw new MemoryError(`Invalid path: ${JSON.stringify(prefix)}`);
    return (await this.base.list(pre)).filter((f) => this.acl.canRead(f.path));
  }

  op(op) {
    return `${op}@${this.acl.user}`;
  }

  async write(path, content, v, op = "write") {
    const p = this.canon(path);
    if (!this.acl.canWrite(p)) this.deny(p, "write");
    return this.base.write(p, content, v, this.op(op));
  }

  async append(path, text, v, op = "append") {
    const p = this.canon(path);
    if (!this.acl.canWrite(p)) this.deny(p, "write");
    return this.base.append(p, text, v, this.op(op));
  }

  async replace(path, a, b, v) {
    const p = this.canon(path);
    if (!this.acl.canWrite(p)) this.deny(p, "write");
    return this.base.replace(p, a, b, v);
  }

  async delete(path, v) {
    const p = this.canon(path);
    if (!this.acl.canWrite(p)) this.deny(p, "write");
    return this.base.delete(p, v);
  }

  async history(path, limit) {
    const p = this.canon(path);
    if (!this.acl.canRead(p)) this.deny(p, "read");
    return this.base.history(p, limit);
  }

  async at(path, iso) {
    const p = this.canon(path);
    if (!this.acl.canRead(p)) this.deny(p, "read");
    return this.base.at(p, iso);
  }

  activeDays(since) {
    return this.base.activeDays(since);
  }
}
