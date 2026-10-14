// Fallback only: prefer the window size the CLI reports (Claude's result.modelUsage[*].contextWindow).
// Claude 5.x reported 1M in practice (claude-haiku-5-5 via the CLI, Opus 5.5 in Claude Code's status line).
export function estimateContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  if (id.includes("[1m]")) return 1_000_000;
  if (["fable", "opus", "sonnet", "haiku"].includes(id)) return 1_000_000;
  if (/^claude-[a-z]+-5-/.test(id)) return 1_000_000;
  if (id.startsWith("claude")) return 200_000;
  if (id.startsWith("gemini")) return 1_048_576;
  if (id.startsWith("gpt-oss")) return 131_072;
  return undefined;
}
