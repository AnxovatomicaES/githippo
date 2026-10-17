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
