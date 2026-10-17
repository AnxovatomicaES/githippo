// In-memory fake of the GitHub contents, trees and commits APIs.
import { createHash } from "node:crypto";

import { gzipSync } from "node:zlib";

/** Builds a gzipped ustar archive like GitHub's /tarball endpoint (with a top-level "owner-repo-sha/" dir). */
function tarball(files) {
  const blocks = [];
  const header = (name, size, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const [path, f] of files) {
    const body = Buffer.from(f.content, "base64");
    const name = `a-b-abc1234/${path}`;
    if (name.length > 100) {
      const rec = `path=${name}\n`;
      const pax = Buffer.from(`${String(rec.length + String(rec.length).length + 1)} ${rec}`);
      blocks.push(header("././@PaxHeader", pax.length, "x"), pad(pax));
    }
    blocks.push(header(name, body.length), pad(body));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function fakeGitHub() {
  const files = new Map(); // repo path -> { content(b64), sha }
  const commits = []; // { sha, date, path, content(b64)|null, message }
  let n = 0;
  // real git blob SHAs, like GitHub, so tarball contents map back to versions
  const sha40 = (p, content) => (content !== undefined ? createHash("sha1").update(`blob ${Buffer.from(content, "base64").length}\0`).update(Buffer.from(content, "base64")).digest("hex") : createHash("sha1").update(`${p}${n}${Math.random()}`).digest("hex"));
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const json = (status, body, headers = {}) => ({ status, ok: status < 400, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

  const commit = (path, content, message) => {
    clock += 86_400_000;
    commits.unshift({ sha: `c${++n}${sha40("c").slice(0, 30)}`, date: new Date(clock).toISOString(), path, content, message });
  };

  const fetchImpl = async (url, { method, body, headers: reqHeaders = {} } = {}) => {
    const u = new URL(url);
    const rest = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const b = body ? JSON.parse(body) : {};
    if (rest.startsWith("/git/trees/")) {
      const tree = [...files].map(([path, f]) => ({ path, type: "blob", size: f.content.length, sha: f.sha }));
      const etag = `"${createHash("sha1").update(JSON.stringify(tree)).digest("hex")}"`;
      const inm = reqHeaders["If-None-Match"];
      if (inm === etag) return json(304, null, { etag });
      return json(200, { tree }, { etag });
    }
    if (rest.startsWith("/tarball/")) {
      const buf = tarball(files);
      return { status: 200, ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), headers: { get: () => null } };
    }
    if (rest === "/commits") {
      const path = u.searchParams.get("path");
      const until = u.searchParams.get("until");
      const since = u.searchParams.get("since");
      let list = path ? commits.filter((c) => c.path === decodeURIComponent(path)) : [...commits];
      if (until) list = list.filter((c) => c.date <= until);
      if (since) list = list.filter((c) => c.date >= since);
      list = list.slice(0, Number(u.searchParams.get("per_page") || 30));
      return json(200, list.map((c) => ({ sha: c.sha, commit: { message: c.message, committer: { date: c.date } } })));
    }
    const p = decodeURIComponent(rest.replace("/contents/", ""));
    const f = files.get(p);
    if (method === "GET") {
      const ref = u.searchParams.get("ref");
      if (ref && ref.startsWith("c")) {
        const c = commits.find((x) => x.sha === ref);
        const at = commits.filter((x) => x.path === p && commits.indexOf(x) >= commits.indexOf(c))[0];
        return at?.content ? json(200, { type: "file", content: at.content, sha: `old-${at.sha}` }) : json(404, {});
      }
      return f ? json(200, { type: "file", content: f.content, sha: f.sha }) : json(404, {});
    }
    if (method === "PUT") {
      if (f && !b.sha) return json(422, { message: "Invalid request. \"sha\" wasn't supplied." });
      if (f && b.sha !== f.sha) return json(409, { message: "sha mismatch" });
      if (!f && b.sha) return json(422, { message: "sha given for new file" });
      n++;
      const sha = sha40(p, b.content);
      files.set(p, { content: b.content, sha });
      commit(p, b.content, b.message);
      return json(200, { content: { sha } });
    }
    if (method === "DELETE") {
      files.delete(p);
      commit(p, null, b.message);
      return json(200, {});
    }
    return json(400, {});
  };

  const seed = (path, text) => {
    const content = Buffer.from(text).toString("base64");
    n++;
    const sha = sha40(path, content);
    files.set(path, { content, sha });
    commit(path, content, `seed ${path}`);
  };
  const text = (path) => Buffer.from(files.get(path).content, "base64").toString("utf8");
  return { files, commits, fetchImpl, seed, text };
}
