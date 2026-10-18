// Step 1b: memory behaviour. Claude gets githippo's real tools (remember, recall) and instructions, has scripted
// multi-session conversations, then answers probe questions in a fresh session. Measures what memory tools
// usually don't: what it chose to save (coverage of the facts that matter, junk), and whether answers improved.
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";
import { instructions } from "../src/server.js";
import { fmt } from "../src/format.js";

export const SCENARIO = {
  sessions: [
    ["Hi! I'm Ada, I lead the payments team at a fintech in Lisbon.", "We decided to move billing from Stripe to Adyen next quarter.", "Also, please always answer me in British English.", "What's a good name for a cat?"],
    ["Quick one: Sam Okafor joined my team as tech lead last week.", "The Adyen migration deadline is March 31.", "Can you explain idempotency keys in two sentences?"],
    ["Change of plan: the Adyen deadline moved to April 30.", "I'm allergic to nothing, but I'm vegetarian, so keep that in mind for team dinners.", "Thanks!"],
  ],
  // facts a careful assistant should keep, as regexes that must match somewhere in the vault
  gold: [/payments/i, /Lisbon/i, /Adyen/i, /British English/i, /Sam Okafor|Sam/i, /April 30/i, /vegetarian/i],
  junk: [/cat name|name for a cat/i, /idempotency keys? (are|is|means)/i, /Thanks/i],
  probes: [
    ["Which payment provider are we moving to, and by when?", /Adyen[\s\S]*April 30|April 30[\s\S]*Adyen/i],
    ["Who is the tech lead on my team?", /Sam/i],
    ["Suggest a restaurant type for my team dinner.", /vegetarian/i],
    ["Spell the word for the colour of the sky the way I like.", /colour|blue/i],
  ],
};

const TOOLS = [
  { name: "remember", description: "Save one durable fact.", input_schema: { type: "object", properties: { fact: { type: "string" }, about: { type: "string" } }, required: ["fact"] } },
  { name: "recall", description: "Search memory by meaning and keywords.", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
];

async function turn(llm, brain, history, userText, stats) {
  history.push({ role: "user", content: userText });
  for (let step = 0; step < 6; step++) {
    const res = await llm.messages({ system: instructions(brain.core), tools: TOOLS, messages: history });
    history.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b) => b.type === "tool_use");
    if (!uses.length) return res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const results = [];
    for (const u of uses) {
      let out;
      try {
        if (u.name === "remember") {
          stats.remember++;
          out = fmt.remember(await brain.remember(u.input.fact, { about: u.input.about }));
        } else {
          stats.recall++;
          out = fmt.recall(await brain.recall(u.input.q));
        }
      } catch (e) {
        out = `ERROR: ${e.message}`;
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: out });
    }
    history.push({ role: "user", content: results });
  }
  return "";
}

export async function runBehavior({ llm, scenario = SCENARIO }) {
  const store = new InMemoryStore();
  await store.write("index.md", "---\nname: index\n---\n\n", "new");
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  const stats = { remember: 0, recall: 0 };
  for (const session of scenario.sessions) {
    const history = [];
    for (const msg of session) await turn(llm, brain, history, msg, stats);
  }
  const vault = (await Promise.all((await store.list()).map((f) => store.read(f.path)))).map((f) => f.content).join("\n");
  const lines = vault.split("\n").filter((l) => /^\s*-\s/.test(l));
  const covered = scenario.gold.filter((re) => re.test(vault)).length;
  const junk = lines.filter((l) => scenario.junk.some((re) => re.test(l))).length;
  let correct = 0;
  const answers = [];
  for (const [q, want] of scenario.probes) {
    const a = await turn(llm, brain, [], q, stats);
    answers.push({ q, a: a.slice(0, 200), ok: want.test(a) });
    if (want.test(a)) correct++;
  }
  return { saved: lines.length, coverage: `${covered}/${scenario.gold.length}`, junkLines: junk, probes: `${correct}/${scenario.probes.length}`, calls: stats, answers };
}
