// Minimal Anthropic Messages API client for githippo's optional LLM features (consolidation, contextual
// retrieval, evaluation). Opt-in: nothing calls it without ANTHROPIC_API_KEY. Transport is injectable for tests.
export const BACKGROUND_MODEL = "claude-haiku-5-5";

export function createLLM(env = process.env, fetchImpl = fetch) {
  if (!env.ANTHROPIC_API_KEY && !env.GITHIPPO_LLM_MOCK) return null;
  const model = env.ANTHROPIC_MODEL || BACKGROUND_MODEL;
  async function complete({ system, prompt, maxTokens = 2000, model: m = model, temperature = 0 }) {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY || "mock", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: m, max_tokens: maxTokens, temperature, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API failed (${res.status}): ${(await res.text?.().catch(() => "")) || ""}`.slice(0, 300));
    const data = await res.json();
    return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  /** Asks for JSON and parses the first JSON value in the reply (tolerates prose or code fences around it). */
  async function json(opts) {
    const text = await complete(opts);
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!m) throw new Error("model did not return JSON");
    return JSON.parse(m[1]);
  }
  /** Raw Messages API call (tool use loops in the evaluation harnesses). */
  async function messages(body) {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY || "mock", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1500, temperature: 0, ...body }),
    });
    if (!res.ok) throw new Error(`Anthropic API failed (${res.status})`);
    return res.json();
  }
  return {
    model,
    complete,
    messages,
    json,
    // kept for maintain rewrite=path (existing feature)
    async consolidate(content, hints) {
      const out = await complete({
        system: "You consolidate a Markdown memory file. Merge duplicate or overlapping bullet points, keep every distinct fact, keep the YAML frontmatter and every [[wikilink]], keep newer information when two lines conflict, never invent facts. Return only the full file.",
        prompt: `Duplicate hints:\n${JSON.stringify(hints, null, 1)}\n\nFile:\n${content}`,
        maxTokens: 8000,
      });
      return out.replace(/^```(?:markdown|md)?\n|\n```\s*$/g, "").trim() + "\n";
    },
  };
}
