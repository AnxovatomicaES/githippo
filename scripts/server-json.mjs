// Writes server.json for the official MCP Registry from package.json + the built bundle's SHA-256.
// CI runs this after building, so the hash always matches the file actually attached to the release.
import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const v = pkg.version;
const sha = readFileSync(`dist/githippo-${v}.mcpb.sha256`, "utf8").trim();
const server = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.AnxovatomicaES/githippo",
  title: "githippo",
  description: "Long-term memory for Claude: Markdown in a git repo you own. Survives context compaction.",
  version: v,
  websiteUrl: "https://github.com/AnxovatomicaES/githippo",
  repository: { url: "https://github.com/AnxovatomicaES/githippo", source: "github", id: "1423318417" },
  icons: [{ src: "https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/assets/icon.png", mimeType: "image/png", sizes: ["512x512"] }],
  packages: [
    {
      registryType: "mcpb",
      identifier: `https://github.com/AnxovatomicaES/githippo/releases/download/v${v}/githippo-${v}.mcpb`,
      version: v,
      fileSha256: sha,
      transport: { type: "stdio" },
      environmentVariables: [
        { name: "VAULT_DIR", description: "Memory vault folder (a git repo). Default: ~/.githippo/vault", format: "filepath", isRequired: false },
        { name: "EMBEDDINGS", description: "local (default), voyage or none", isRequired: false, default: "local" },
      ],
    },
  ],
};
if (server.description.length > 100) throw new Error(`description is ${server.description.length} chars (max 100)`);
writeFileSync("server.json", JSON.stringify(server, null, 2) + "\n");
console.log(`server.json → ${server.packages[0].identifier} (${sha.slice(0, 12)}…)`);
