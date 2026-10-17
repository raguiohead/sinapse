import type { ContextUsage } from "./types.js";

export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-high";

// Fallback only: prefer the window size the CLI reports (Claude's result.modelUsage[*].contextWindow).
// Claude 5.x reported 1M in practice (claude-haiku-5-5 via the CLI, Opus 5.5 in Claude Code's status line).
export function estimateContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase().trim();
  if (id.includes("[1m]")) return 1_000_000;
  if (["fable", "opus", "sonnet", "haiku"].includes(id)) return 1_000_000;
  if (/^claude[- ][a-z]+[- ]5[.-]/.test(id)) return 1_000_000;
  if (id.startsWith("claude")) return 200_000;
  if (id.startsWith("gemini")) return 1_048_576;
  if (id.startsWith("gpt-oss")) return 131_072;
  if (id.startsWith("gpt-5")) return 400_000;
  if (id.startsWith("gpt-4.1")) return 1_047_576;
  if (id.startsWith("gpt-4o") || id.startsWith("gpt-4")) return 128_000;
  if (id.startsWith("codex") || id.startsWith("o3") || id.startsWith("o4")) return 200_000;
  return undefined;
}

export function normalizeAgyModelId(labelOrId: string | undefined): string | undefined {
  if (!labelOrId) return undefined;
  const trimmed = labelOrId.trim();
  if (!trimmed) return undefined;
  let slug = trimmed
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.startsWith("claude-")) {
    slug = slug.replace(/(\d)\.(\d)/g, "$1-$2");
  }
  return slug || undefined;
}

export function buildAgyContextUsage(
  rawUsage: { input_tokens?: number; cache_read_tokens?: number } | undefined,
  model: string | undefined,
  resolvedModel?: string
): ContextUsage | undefined {
  if (!rawUsage) return undefined;
  const input = Number(rawUsage.input_tokens ?? 0);
  const cacheRead = Number(rawUsage.cache_read_tokens ?? 0);
  const usedTokens = (Number.isFinite(input) ? input : 0) + (Number.isFinite(cacheRead) ? cacheRead : 0);
  const effectiveModel = resolvedModel || model || DEFAULT_AGY_MODEL;
  const windowTokens = estimateContextWindow(effectiveModel);
  return {
    usedTokens,
    windowTokens,
    windowEstimated: true,
    model: resolvedModel ?? model,
  };
}

