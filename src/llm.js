// Optional: uses the Anthropic API to rewrite a bloated file during consolidation.
export function createLLM(env = process.env, fetchImpl = fetch) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  return {
    model,
    async consolidate(content, hints) {
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          system:
            "You consolidate a Markdown memory file. Merge duplicate or overlapping bullet points, " +
            "keep every distinct fact, keep the YAML frontmatter and every [[wikilink]], keep newer " +
            "information when two lines conflict, never invent facts. Return only the full file.",
          messages: [
            {
              role: "user",
              content: `Duplicate hints:\n${JSON.stringify(hints, null, 1)}\n\nFile:\n${content}`,
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API failed (${res.status})`);
      const data = await res.json();
      return data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .replace(/^```(?:markdown|md)?\n|\n```\s*$/g, "")
        .trim() + "\n";
    },
  };
}
