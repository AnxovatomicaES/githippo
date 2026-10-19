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
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryError } from "./store.js";

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
    const p = String(path || "").replace(/^\/+/, "");
    // Another user's users/<id>/ folder is private: only a rule that names users/ explicitly can open it,
    // never a catch-all like ":read".
    const othersPrivate = p.startsWith("users/") && !p.startsWith(`users/${this.user}/`);
    for (const r of this.rules) {
      if (!ruleMatches(r.path, p)) continue;
      if (othersPrivate && !r.path.startsWith("users/")) return 0;
      return LEVEL[r.access] ?? 0;
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
    try {
      users = JSON.parse(env.USERS_JSON || readFileSync(file, "utf8")).users || [];
    } catch {}
    const a = new Accounts({ users: users.filter((u) => u && typeof u.id === "string" && ID_RE.test(u.id)), ownerSecret: env.MCP_SECRET, file });
    a.fromEnv = !!env.USERS_JSON;
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
    mkdirSync(dirname(this.file), { recursive: true });
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

  async read(path, ref) {
    if (!this.acl.canRead(path)) this.deny(path, "read");
    return this.base.read(path, ref);
  }

  async list(prefix = "") {
    return (await this.base.list(prefix)).filter((f) => this.acl.canRead(f.path));
  }

  op(op) {
    return `${op}@${this.acl.user}`;
  }

  async write(path, content, v, op = "write") {
    if (!this.acl.canWrite(path)) this.deny(path, "write");
    return this.base.write(path, content, v, this.op(op));
  }

  async append(path, text, v, op = "append") {
    if (!this.acl.canWrite(path)) this.deny(path, "write");
    return this.base.append(path, text, v, this.op(op));
  }

  async replace(path, a, b, v) {
    if (!this.acl.canWrite(path)) this.deny(path, "write");
    return this.base.replace(path, a, b, v);
  }

  async delete(path, v) {
    if (!this.acl.canWrite(path)) this.deny(path, "write");
    return this.base.delete(path, v);
  }

  async history(path, limit) {
    if (!this.acl.canRead(path)) this.deny(path, "read");
    return this.base.history(path, limit);
  }

  async at(path, iso) {
    if (!this.acl.canRead(path)) this.deny(path, "read");
    return this.base.at(path, iso);
  }

  activeDays(since) {
    return this.base.activeDays(since);
  }
}
