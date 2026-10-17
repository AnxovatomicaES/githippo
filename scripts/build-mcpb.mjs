// Builds dist/githippo-<version>.mcpb (Claude Desktop extension) with production dependencies only,
// validates the manifest with Anthropic's mcpb CLI, and prints the SHA-256 the MCP Registry needs.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== pkg.version) throw new Error(`manifest.json ${manifest.version} ≠ package.json ${pkg.version}`);

rmSync("build", { recursive: true, force: true });
mkdirSync("build", { recursive: true });
for (const f of ["src", "manifest.json", "LICENSE", "README.md"]) cpSync(f, `build/${f}`, { recursive: true });
cpSync("assets/icon.png", "build/icon.png");
const { devDependencies, scripts, files, ...prod } = pkg;
writeFileSync("build/package.json", JSON.stringify({ ...prod, type: "module" }, null, 2));
run("npm", ["install", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], "build");
run("npx", ["mcpb", "validate", "build/manifest.json"], ".");
mkdirSync("dist", { recursive: true });
const out = `dist/githippo-${pkg.version}.mcpb`;
run("npx", ["mcpb", "pack", "build", out], ".");
const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync(`${out}.sha256`, `${sha}\n`);
console.log(JSON.stringify({ file: out, bytes: statSync(out).size, sha256: sha }));
