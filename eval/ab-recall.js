// A/B pilot: what githippo's `recall` tool would hand the model for a query over a folder of notes, in keyword mode:
//   node eval/ab-recall.js <vault-folder> "<query>" [--brief]
// It builds an in-memory index of the notes, runs the same Brain.recall the MCP tool runs, and prints the same text the tool returns.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { fmt } from "../src/format.js";

const [dir, query] = process.argv.slice(2);
if (!dir || !query) {
  console.error('usage: node eval/ab-recall.js <vault-folder> "<query>" [--brief]');
  process.exit(2);
}
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith(".md") ? [join(d, n)] : []));
const store = new InMemoryStore();
for (const f of walk(dir)) await store.write(relative(dir, f), readFileSync(f, "utf8"), "new", "seed");
const index = new MemoryIndex(store, null, {});
await index.sync({ maxAgeMs: 0 });
const brain = new Brain({ store, index });
const mode = process.argv.includes("--brief") ? "brief" : undefined;
console.log(fmt.recall(await brain.recall(query, { mode })));
