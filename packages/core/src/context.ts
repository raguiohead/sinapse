// Fallback only: prefer the window size the CLI reports (Claude's result.modelUsage[*].contextWindow).
export function estimateContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  if (id.includes("[1m]")) return 1_000_000;
  if (id.startsWith("claude") || ["fable", "opus", "sonnet", "haiku"].includes(id)) return 200_000;
  if (id.startsWith("gemini")) return 1_048_576;
  if (id.startsWith("gpt-oss")) return 131_072;
  return undefined;
}
