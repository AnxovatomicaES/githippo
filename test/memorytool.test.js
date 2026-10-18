// Step 4: githippo behind Anthropic's native memory tool (memory_20250818), reference strings and security.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { createMemoryTool, toRel } from "../src/memorytool.js";

const call = async (h, input) => h({ id: "t1", input });

test("memory tool: full command set with reference return strings", async () => {
  const { brain, gh } = setup();
  const h = createMemoryTool(brain);
  let r = await call(h, { command: "view", path: "/memories" });
  assert.match(r.content, /^Here're the files and directories up to 2 levels deep in \/memories, excluding hidden items and node_modules:\n.*\t\/memories\n/);
  assert.match(r.content, /\t\/memories\/projects\/johnny\.md/);
  r = await call(h, { command: "create", path: "/memories/notes.txt", file_text: "Meeting notes:\n- Discussed timeline\n" });
  assert.equal(r.content, "File created successfully at: /memories/notes.txt");
  assert.ok(gh.files.has("memory/notes.txt.md"), "stored as Markdown");
  r = await call(h, { command: "view", path: "/memories/notes.txt" });
  assert.equal(r.content, "Here's the content of /memories/notes.txt with line numbers:\n     1\tMeeting notes:\n     2\t- Discussed timeline");
  assert.match((await call(h, { command: "view", path: "/memories" })).content, /\t\/memories\/notes\.txt\n|\t\/memories\/notes\.txt$/m, "shown under its own name");
  r = await call(h, { command: "str_replace", path: "/memories/notes.txt", old_str: "Discussed timeline", new_str: "Agreed launch in Q2" });
  assert.match(r.content, /^The memory file has been edited\.\n/);
  r = await call(h, { command: "insert", path: "/memories/notes.txt", insert_line: 0, insert_text: "# Notes\n" });
  assert.equal(r.content, "The file /memories/notes.txt has been edited.");
  assert.match((await call(h, { command: "view", path: "/memories/notes.txt", view_range: [1, 1] })).content, /     1\t# Notes$/);
  r = await call(h, { command: "rename", old_path: "/memories/notes.txt", new_path: "/memories/archive/notes.txt" });
  assert.equal(r.content, "Successfully renamed /memories/notes.txt to /memories/archive/notes.txt");
  r = await call(h, { command: "delete", path: "/memories/archive" });
  assert.equal(r.content, "Successfully deleted /memories/archive");
  assert.ok(!gh.files.has("memory/archive/notes.txt.md"));
});

test("memory tool: reference errors", async () => {
  const { brain } = setup();
  const h = createMemoryTool(brain);
  await call(h, { command: "create", path: "/memories/a.txt", file_text: "x x\n" });
  const err = async (input) => { const r = await call(h, input); assert.equal(r.is_error, true); return r.content; };
  assert.equal(await err({ command: "view", path: "/memories/nope.txt" }), "The path /memories/nope.txt does not exist. Please provide a valid path.");
  assert.equal(await err({ command: "str_replace", path: "/memories/a.txt", old_str: "y", new_str: "z" }), "No replacement was performed, old_str `y` did not appear verbatim in /memories/a.txt.");
  assert.match(await err({ command: "str_replace", path: "/memories/a.txt", old_str: "x", new_str: "z" }), /^No replacement was performed\. Multiple occurrences of old_str `x` in lines: 1\. Please ensure it is unique$/);
  assert.equal(await err({ command: "insert", path: "/memories/a.txt", insert_line: 9, insert_text: "q" }), "Error: Invalid `insert_line` parameter: 9. It should be within the range of lines of the file: [0, 1]");
  assert.equal(await err({ command: "delete", path: "/memories" }), "Error: Cannot delete the /memories directory itself");
  assert.equal(await err({ command: "rename", old_path: "/memories", new_path: "/memories/x" }), "Error: Cannot rename the /memories directory itself");
  await call(h, { command: "create", path: "/memories/b.txt", file_text: "b\n" });
  assert.equal(await err({ command: "rename", old_path: "/memories/a.txt", new_path: "/memories/b.txt" }), "Error: The destination /memories/b.txt already exists");
});

test("memory tool: path traversal and secrets are refused", async () => {
  for (const p of ["/memories/../../secrets.env", "/memories/%2e%2e%2fsecrets", "/memories/%252e%252e%252fx", "/etc/passwd", "/memories/a\\..\\b", "/memories/.hidden", "/memoriesX/a"]) {
    assert.throws(() => toRel(p), /Error|must start/, p);
  }
  const { brain, gh } = setup();
  const h = createMemoryTool(brain);
  const r = await call(h, { command: "create", path: "/memories/keys.txt", file_text: "stripe sk_live_" + "a1B2".repeat(6) });
  assert.equal(r.is_error, true);
  assert.match(r.content, /compliance guard: stripe_key/);
  assert.ok(!gh.files.has("memory/keys.txt.md"));
});

test("memory tool writes are searchable by githippo recall", async () => {
  const { brain } = setup();
  const h = createMemoryTool(brain);
  await call(h, { command: "create", path: "/memories/customer.xml", file_text: "<prefs>Acme Corp prefers email follow-ups</prefs>\n" });
  const r = await brain.recall("how does Acme want follow-ups", { mode: "brief" });
  assert.ok(r.hits.some((x) => x.ref.startsWith("customer.xml.md")));
});
