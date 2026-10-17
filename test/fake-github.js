// In-memory fake of the GitHub contents, trees and commits APIs.
import { createHash } from "node:crypto";

export function fakeGitHub() {
  const files = new Map(); // repo path -> { content(b64), sha }
  const commits = []; // { sha, date, path, content(b64)|null, message }
  let n = 0;
  const sha40 = (p) => createHash("sha1").update(`${p}${n}${Math.random()}`).digest("hex");
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body });

  const commit = (path, content, message) => {
    clock += 86_400_000;
    commits.unshift({ sha: `c${++n}${sha40("c").slice(0, 30)}`, date: new Date(clock).toISOString(), path, content, message });
  };

  const fetchImpl = async (url, { method, body }) => {
    const u = new URL(url);
    const rest = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const b = body ? JSON.parse(body) : {};
    if (rest.startsWith("/git/trees/")) {
      return json(200, { tree: [...files].map(([path, f]) => ({ path, type: "blob", size: f.content.length, sha: f.sha })) });
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
      if (f && b.sha !== f.sha) return json(409, { message: "sha mismatch" });
      if (!f && b.sha) return json(422, { message: "sha given for new file" });
      n++;
      const sha = sha40(p);
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
    const sha = sha40(path);
    files.set(path, { content, sha });
    commit(path, content, `seed ${path}`);
  };
  const text = (path) => Buffer.from(files.get(path).content, "base64").toString("utf8");
  return { files, commits, fetchImpl, seed, text };
}
