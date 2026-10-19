import { fakeGitHub } from "./fake-github.js";
import { GitHubMemoryStore } from "../src/store.js";
import { MemoryIndex } from "../src/search.js";
import { hashEmbedder } from "../src/embed.js";
import { Brain } from "../src/brain.js";

export function setup({ embedder = hashEmbedder(), llm = null, cacheDir } = {}) {
  const gh = fakeGitHub();
  gh.seed("memory/index.md", "---\nname: index\ndescription: TOC\n---\n\n- [[john-grecu]] — COO\n- [[johnny]] — voice assistant\n");
  gh.seed("memory/core.md", "---\nname: core\ntype: core\n---\n\n- User is Marcel, CTO, based in Spain\n");
  gh.seed(
    "memory/people/john-grecu.md",
    "---\nname: john-grecu\ntitle: John Grecu\ndescription: Chief Operating Officer\naliases: [John]\n---\n\n- Chief Operating Officer\n- Approves budget for infrastructure projects\n",
  );
  gh.seed(
    "memory/projects/johnny.md",
    "---\nname: johnny\ntitle: Johnny\ndescription: Voice-controlled Mac assistant\naliases: [Johnny, voice agent]\n---\n\n## Requirements\n- Needs a wake word and runs locally on the Mac mini\n- sponsor [[john-grecu]]\n",
  );
  gh.seed("memory/topics/brand.md", "---\nname: brand\ndescription: Brand rules\n---\n\n- Primary colour is navy\n");
  const store = new GitHubMemoryStore({ token: "t", repo: "me/mem", fetchImpl: gh.fetchImpl });
  const index = new MemoryIndex(store, embedder, { cacheDir });
  return { gh, store, index, brain: new Brain({ store, index, llm, coreBudgetTokens: 60 }) };
}

let cached = { at: 0, value: 1 };
/**
 * How many times slower than a typical idle machine this one is right now (1 = as fast or faster). Timing assertions multiply
 * their limits by it: they exist to catch blow-ups (the bugs they guard against took seconds, even minutes), not to fail on a
 * busy laptop or a slow shared CI runner.
 */
export function speedFactor() {
  if (Date.now() - cached.at < 1000) return cached.value;
  const t = performance.now();
  let x = 0;
  for (let i = 0; i < 2e7; i++) x = (x + i * 7) % 1000003;
  cached = { at: Date.now(), value: x < 0 ? 1 : Math.min(20, Math.max(1, (performance.now() - t) / 145)) }; // 145 ms: this loop on an idle development machine
  return cached.value;
}
