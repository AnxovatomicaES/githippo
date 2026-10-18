// Contextual retrieval (step 3, after Anthropic's published technique): a small model writes one short
// sentence situating each chunk in its note; it's prepended before indexing, so keyword search and
// embeddings both see it. Stored in the vault as .githippo/context.json (synced by git, keyed by chunk hash).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONTEXT_PROMPT = (note, chunk) => `<document>
${note}
</document>
Here is the chunk we want to situate within the whole document
<chunk>
${chunk}
</chunk>
Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.`;

// Lives INSIDE the memory folder (memory/.githippo/context.json) so git commits it: these cost API money to
// generate. (v3.7.0-3.7.3 wrote it one level up, outside the committed folder; that location is still read.)
export const contextFile = (base) => join(base, ".githippo", "context.json");

export function loadContexts(base) {
  for (const f of [contextFile(base), join(dirname(base), ".githippo", "context.json")]) {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {}
  }
  return {};
}

export async function contextualize({ brain, llm, vaultDir, limit = Infinity, log = () => {} }) {
  await brain.index.sync({ maxAgeMs: 0 });
  const base = brain.store.base || vaultDir; // the memory folder of a local vault
  const ctx = loadContexts(base);
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
  mkdirSync(join(base, ".githippo"), { recursive: true });
  writeFileSync(contextFile(base), JSON.stringify(ctx, null, 1));
  if (done) await brain.store.commit?.([".githippo/context.json"], "memory: contextualize chunks", "contextualize");
  return { added: done, total: Object.keys(ctx).length };
}
