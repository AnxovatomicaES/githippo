// The per-prompt hook injects memory when it is "confident". Its cost is paid on every prompt, so a false injection is wasted tokens (~220 each):
// words the vault has never seen must count against the match. GITHIPPO_HOME is set before anything is imported (HOME_DIR is read once).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "r6h-"));
process.env.GITHIPPO_HOME = home;
const { InMemoryStore } = await import("../src/memstore.js");
const { MemoryIndex } = await import("../src/search.js");
const { promptRecall } = await import("../src/hooks.js");
const { buildVault } = await import("../eval/scale-context.js");

const UNRELATED = [
  "refactor the parser to use async iterators instead of callbacks", "why does this test fail with a timeout on CI only", "add a retry with exponential backoff around the http client",
  "rename the variable foo to count in utils and update all call sites", "write a regex that matches ISO dates with optional time zones", "explain how the event loop handles promise microtasks",
  "convert this class component to a function component with hooks", "the build is slow, can you profile the webpack configuration", "add input validation to the signup form and show errors inline",
  "what is the difference between a mutex and a semaphore", "fix the off by one error in the pagination helper", "generate a sql migration that adds an index on created_at",
  "make the sidebar collapsible on small screens", "summarise the changes in the last three commits", "why is my docker image so large and how can I shrink it",
  "implement binary search over the sorted list of timestamps", "write unit tests for the date formatting module", "how do I debounce this search box input handler",
  "upgrade the dependencies and fix whatever breaks", "add dark mode support to the settings page using css variables",
];

test("on 1,000 notes the prompt hook injects nothing for ordinary coding prompts (3 of these 20 got ~220 tokens of memory each before) and still fires for the real questions", async () => {
  const cacheDir = join(home, "cache");
  const { md, questions } = buildVault(1000, { queries: 40, seed: 7 });
  const store = new InMemoryStore();
  for (const [p, c] of Object.entries(md)) await store.write(p, c, "new", "seed");
  const index = new MemoryIndex(store, null, { cacheDir });
  await index.sync({ maxAgeMs: 0 });
  await index.writeSnapshot();
  let i = 0;
  const injected = [];
  for (const prompt of UNRELATED) if (await promptRecall({ prompt, session_id: `u${i++}` }, { cacheDir })) injected.push(prompt);
  assert.deepEqual(injected, [], "these unrelated prompts were given memory");
  let fired = 0;
  for (const { q, path } of questions) {
    const out = await promptRecall({ prompt: q, session_id: `q${i++}` }, { cacheDir });
    if (out && out.includes(path)) fired++;
  }
  assert.ok(fired >= 38, `the hook fired with the right note for only ${fired} of ${questions.length} real questions`);
});
