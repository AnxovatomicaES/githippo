// One source of truth for "what version is this?": every file that carries one, read and written in one place.
//   node scripts/versions.mjs            → check: exits 1 and lists the mismatches
//   node scripts/versions.mjs 3.8.1      → bump everything to 3.8.1 (then run the check)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const json = (f) => JSON.parse(read(f));
const TAG = /githippo#v(\d+\.\d+\.\d+)/g;
const PINNED = ["README.md", "INSTALL_FOR_AGENTS.md", ".mcp.json", "hooks/hooks.json", "docs/prior-art.md"];

export function collect() {
  const v = {
    "package.json": json("package.json").version,
    "package-lock.json": json("package-lock.json").version,
    "package-lock.json (root package)": json("package-lock.json").packages?.[""]?.version,
    "manifest.json": json("manifest.json").version,
    ".claude-plugin/plugin.json": json(".claude-plugin/plugin.json").version,
    ".claude-plugin/marketplace.json": json(".claude-plugin/marketplace.json").plugins[0].version,
    "src/version.js VERSION": read("src/version.js").match(/VERSION = "([^"]+)"/)?.[1],
    "install.sh VERSION": read("install.sh").match(/VERSION="v([^"]+)"/)?.[1]?.replace(/^v/, ""),
  };
  // every occurrence is its own entry: keying by file alone let a stale tag hide behind a correct one later in the same file
  for (const f of PINNED) if (existsSync(join(ROOT, f))) [...read(f).matchAll(TAG)].forEach((m, i) => (v[`${f} (pinned tag #${i + 1})`] = m[1]));
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) v["git tag"] = process.env.GITHUB_REF_NAME.replace(/^v/, "");
  return v;
}

export function check() {
  const v = collect();
  const want = v["package.json"];
  return { want, bad: Object.entries(v).filter(([, x]) => x !== want), all: v };
}

export function bump(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  const edit = (f, fn) => writeFileSync(join(ROOT, f), fn(read(f)));
  const setJson = (f, fn) => {
    const j = json(f);
    fn(j);
    writeFileSync(join(ROOT, f), `${JSON.stringify(j, null, 2)}\n`);
  };
  setJson("package.json", (j) => (j.version = version));
  setJson("package-lock.json", (j) => {
    j.version = version;
    if (j.packages?.[""]) j.packages[""].version = version;
  });
  setJson("manifest.json", (j) => (j.version = version));
  setJson(".claude-plugin/plugin.json", (j) => (j.version = version));
  setJson(".claude-plugin/marketplace.json", (j) => (j.plugins[0].version = version));
  edit("src/version.js", (s) => s.replace(/VERSION = "[^"]+"/, `VERSION = "${version}"`));
  edit("install.sh", (s) => s.replace(/VERSION="v?[^"]+"/, `VERSION="v${version}"`));
  for (const f of PINNED) if (existsSync(join(ROOT, f))) edit(f, (s) => s.replace(TAG, `githippo#v${version}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2]) bump(process.argv[2]);
  const { want, bad } = check();
  if (bad.length) {
    console.error(`version mismatch (package.json says ${want}):\n${bad.map(([f, x]) => `  ${f}: ${x}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`all versions agree: ${want}`);
}
