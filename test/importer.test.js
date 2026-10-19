// Issue #1: import from the MCP reference memory server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { importReferenceMemory } from "../src/importer.js";

const JSONL = [
  { type: "entity", name: "Ada_Lovelace", entityType: "person", observations: ["Wrote the first published algorithm", "Prefers tea in the afternoon"] },
  { type: "entity", name: "Analytical_Engine", entityType: "project", observations: ["Mechanical general-purpose computer designed by Babbage"] },
  { type: "entity", name: "Acme Corp", entityType: "organization", observations: ["Card on file 4111 1111 1111 1111"] },
  { type: "relation", from: "Ada_Lovelace", to: "Analytical_Engine", relationType: "works on" },
].map((o) => JSON.stringify(o)).join("\n") + "\nnot json\n";

test("imports entities, observations and typed relations; guard + dedupe apply; re-run is a no-op", async () => {
  const { brain, gh } = setup();
  const r = await importReferenceMemory(brain, JSONL);
  assert.deepEqual({ ...r }, { entities: 3, facts: 3, relations: 1, duplicates: 0, blocked: 1, rejected: 0, skippedLines: 1, reasons: [] });
  const ada = gh.text("memory/people/ada-lovelace.md");
  assert.match(ada, /title: Ada Lovelace/);
  assert.match(ada, /- Wrote the first published algorithm/);
  assert.match(ada, /- works_on \[\[analytical-engine\]\]/);
  assert.match(gh.text("memory/projects/analytical-engine.md"), /Mechanical general-purpose computer/);
  assert.ok(![...gh.files.keys()].some((k) => /acme/.test(k) && /4111/.test(gh.text(k))), "card number never stored");
  const again = await importReferenceMemory(brain, JSONL);
  assert.equal(again.facts + again.relations, 0, "re-import adds nothing");
  assert.equal(again.duplicates, 4);
  // and the graph understands the imported relation
  const g = await brain.neighbors("Ada Lovelace");
  assert.ok(g.relations.some((x) => x.type === "works_on" && x.to === "analytical-engine"));
});
