// Contextual retrieval (step 3, after Anthropic's published technique): a small model writes one short
// sentence situating each chunk in its note; it's prepended before indexing, so keyword search and
// embeddings both see it. Stored in the vault as .githippo/context.json (synced by git, keyed by chunk hash).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTEXT_PROMPT = (note, chunk) => `<document>
${note}
</document>
Here is the chunk we want to situate within the whole document
<chunk>
${chunk}
</chunk>
Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.`;

export const contextFile = (vaultDir) => join(vaultDir, ".githippo", "context.json");

export function loadContexts(vaultDir) {
  try {
    return JSON.parse(readFileSync(contextFile(vaultDir), "utf8"));
  } catch {
    return {};
  }
}

export async function contextualize({ brain, llm, vaultDir, limit = Infinity, log = () => {} }) {
  await brain.index.sync({ maxAgeMs: 0 });
  const ctx = loadContexts(vaultDir);
  let done = 0;
  for (const f of brain.index.files.values()) {
    if (f.path.startsWith("sessions/") || ["index.md", "core.md"].includes(f.path)) continue;
    for (const c of f.chunks) {
      if (ctx[c.baseHash || c.hash] || done >= limit) continue;
      const text = (await llm.complete({ prompt: CONTEXT_PROMPT(f.live.slice(0, 12000), c.text), maxTokens: 120 })).trim().replace(/\s+/g, " ").slice(0, 300);
      if (text) ctx[c.baseHash || c.hash] = text;
      done++;
      if (done % 25 === 0) log(`${done} chunks`);
    }
  }
  mkdirSync(join(vaultDir, ".githippo"), { recursive: true });
  writeFileSync(contextFile(vaultDir), JSON.stringify(ctx, null, 1));
  return { added: done, total: Object.keys(ctx).length };
}
