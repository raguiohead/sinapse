/**
 * Adapter para o OpenAI Codex CLI (`@openai/codex` / `codex-rs`).
 *
 * Notas sobre flags e protocolo JSONL (não testado ponta a ponta nesta máquina pois o binário `codex` não está instalado):
 * - Modo não interativo: `codex exec --json ...` emite eventos JSONL em stdout.
 * - Autonomia:
 *   - `read` -> `--sandbox read-only`
 *   - `edit` -> `--sandbox workspace-write`
 *   - `full` -> `--dangerously-bypass-approvals-and-sandbox`
 * - Retomada de sessão: `codex exec [FLAGS] resume <session_id> -`. Na CLI em Rust (clap), as flags de `exec`
 *   (`--json`, `--model`, `--sandbox`, `--dangerously-bypass-approvals-and-sandbox`) pertencem ao comando `exec`
 *   e precedem o subcomando `resume <session_id>`.
 * - Prompt seguro contra hifens iniciais: passamos `"-"` como argumento posicional de prompt e enviamos o conteúdo
 *   real via `stdin`, evitando que prompts iniciados com `"-"` sejam interpretados como flags pelo parser da CLI.
 * - Formato de eventos JSONL: suporta tanto o esquema atual baseado em threads/itens (`thread.started`,
 *   `item.started`, `item.completed`, `turn.completed`, `turn.failed`) quanto o envelope legado (`msg.type` /
 *   `session_configured`, `agent_message`, `agent_reasoning`, `exec_command_*`, `mcp_tool_call_*`, `token_count`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { Adapter, AdapterRunOptions, ContextUsage, Provider, TurnEvent, TurnResult } from "../types.js";
import { agentEnv, killTree, sweepEnvMarker, TURN_MARKER } from "../process.js";
import { estimateContextWindow } from "../context.js";

export interface CodexRawUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

export interface ParsedCodexEvent {
  events: TurnEvent[];
  sessionId?: string;
  model?: string;
  usage?: CodexRawUsage;
  resultText?: string;
}

export function buildCodexArgs(options: AdapterRunOptions): string[] {
  const args: string[] = ["exec", "--json", "--skip-git-repo-check"];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.autonomy === "read") {
    args.push("--sandbox", "read-only");
  } else if (options.autonomy === "edit") {
    args.push("--sandbox", "workspace-write");
  } else if (options.autonomy === "full") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (options.sessionId) {
    args.push("resume", options.sessionId, "-");
  } else {
    args.push("-");
  }

  return args;
}

function truncateOutput(value: unknown, maxLen = 2000): string {
  const str = typeof value === "string" ? value : value !== undefined && value !== null ? JSON.stringify(value) : "";
  return str.slice(0, maxLen);
}

function extractItemText(item: Record<string, any>): string {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.message === "string") {
    return item.message;
  }
  if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content) {
      if (part && typeof part === "object") {
        if (typeof part.text === "string") {
          parts.push(part.text);
        } else if (typeof part.transcript === "string") {
          parts.push(part.transcript);
        }
      }
    }
    return parts.join("");
  }
  if (Array.isArray(item.summary)) {
    const parts: string[] = [];
    for (const part of item.summary) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (part && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function extractUsage(rawUsage: unknown, contextWindowHint?: unknown): CodexRawUsage | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  const u = rawUsage as Record<string, any>;
  const inputTokens = Number(u.input_tokens ?? u.prompt_tokens ?? u.total_tokens ?? 0);
  const cachedInputTokens =
    u.cached_input_tokens !== undefined || u.cache_read_input_tokens !== undefined
      ? Number(u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0)
      : undefined;
  const outputTokens =
    u.output_tokens !== undefined || u.completion_tokens !== undefined
      ? Number(u.output_tokens ?? u.completion_tokens ?? 0)
      : undefined;
  const cw = Number(u.model_context_window ?? u.context_window ?? contextWindowHint ?? 0);

  if (Number.isNaN(inputTokens) && cachedInputTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens: Number.isNaN(inputTokens) ? 0 : inputTokens,
    ...(cachedInputTokens !== undefined && !Number.isNaN(cachedInputTokens) ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined && !Number.isNaN(outputTokens) ? { outputTokens } : {}),
    ...(cw > 0 && !Number.isNaN(cw) ? { contextWindow: cw } : {}),
  };
}

/**
 * Função pura que converte um objeto JSON emitido pelo `codex exec --json`
 * em eventos `TurnEvent` e metadados de turno (sessionId, model, usage, resultText).
 * Eventos desconhecidos são ignorados sem lançar exceção.
 */
export function parseCodexEvent(raw: unknown, timestamp: number = Date.now()): ParsedCodexEvent {
  const out: ParsedCodexEvent = { events: [] };
  if (!raw || typeof raw !== "object") {
    return out;
  }

  const obj = raw as Record<string, any>;

  // Captura identificadores de sessão/modelo no nível raiz se presentes
  if (typeof obj.thread_id === "string" && obj.thread_id) {
    out.sessionId = obj.thread_id;
  } else if (typeof obj.session_id === "string" && obj.session_id) {
    out.sessionId = obj.session_id;
  } else if (typeof obj.conversation_id === "string" && obj.conversation_id) {
    out.sessionId = obj.conversation_id;
  }

  if (typeof obj.model === "string" && obj.model) {
    out.model = obj.model;
  }

  // Caso o evento venha envelopado em `{ id, msg: { type, ... } }` (formato legado do codex)
  const payload: Record<string, any> =
    obj.msg && typeof obj.msg === "object" && typeof obj.msg.type === "string" ? obj.msg : obj;

  if (typeof payload.session_id === "string" && payload.session_id) {
    out.sessionId = payload.session_id;
  } else if (typeof payload.thread_id === "string" && payload.thread_id) {
    out.sessionId = payload.thread_id;
  }
  if (typeof payload.model === "string" && payload.model) {
    out.model = payload.model;
  }

  const type = typeof payload.type === "string" ? payload.type : "";

  // 1. Eventos de ciclo de vida da thread/sessão/turno (`codex exec --json` moderno)
  if (type === "thread.started" || type === "session.created" || type === "session_configured") {
    if (typeof payload.thread_id === "string" && payload.thread_id) {
      out.sessionId = payload.thread_id;
    } else if (typeof payload.session_id === "string" && payload.session_id) {
      out.sessionId = payload.session_id;
    }
    if (typeof payload.model === "string" && payload.model) {
      out.model = payload.model;
    }
    return out;
  }

  if (type === "turn.completed") {
    const parsedUsage = extractUsage(payload.usage, payload.model_context_window);
    if (parsedUsage) {
      out.usage = parsedUsage;
    }
    if (typeof payload.result === "string" && payload.result) {
      out.resultText = payload.result;
    }
    return out;
  }

  if (type === "turn.failed") {
    const errMsg =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.error?.message === "string"
        ? payload.error.message
        : typeof payload.message === "string"
        ? payload.message
        : JSON.stringify(payload.error ?? payload);
    out.events.push({
      type: "error",
      timestamp,
      data: errMsg,
    });
    return out;
  }

  // 2. Eventos `item.started` / `item.updated` / `item.completed`
  if (
    (type === "item.started" || type === "item.updated" || type === "item.completed") &&
    payload.item &&
    typeof payload.item === "object"
  ) {
    const item = payload.item as Record<string, any>;
    const itemType = typeof item.type === "string" ? item.type : "";

    if (itemType === "agent_message" || itemType === "message") {
      // Emite texto apenas quando completo (ou delta se for streaming incremental explícito)
      if (type === "item.completed") {
        const text = extractItemText(item);
        if (text) {
          out.events.push({ type: "text", timestamp, data: text });
          out.resultText = text;
        }
      }
      return out;
    }

    if (itemType === "reasoning") {
      if (type === "item.completed") {
        const thinkingText = extractItemText(item);
        if (thinkingText) {
          out.events.push({ type: "thinking", timestamp, data: thinkingText });
        }
      }
      return out;
    }

    if (itemType === "command_execution") {
      const cmd = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
      if (type === "item.started") {
        out.events.push({
          type: "tool_use",
          timestamp,
          data: JSON.stringify({ name: "command_execution", command: cmd }),
        });
      } else if (type === "item.completed") {
        const output = truncateOutput(item.aggregated_output ?? item.output ?? item.stdout ?? "");
        out.events.push({
          type: "tool_result",
          timestamp,
          data: JSON.stringify({
            name: "command_execution",
            command: cmd,
            exit_code: item.exit_code,
            output,
          }),
        });
      }
      return out;
    }

    if (itemType === "file_change") {
      if (type === "item.started") {
        out.events.push({
          type: "tool_use",
          timestamp,
          data: JSON.stringify({ name: "file_change", changes: item.changes }),
        });
      } else if (type === "item.completed") {
        out.events.push({
          type: "tool_result",
          timestamp,
          data: JSON.stringify({
            name: "file_change",
            status: item.status,
            changes: item.changes,
          }),
        });
      }
      return out;
    }

    if (
      itemType === "mcp_tool_call" ||
      itemType === "function_call" ||
      itemType === "tool_call" ||
      itemType === "web_search"
    ) {
      const toolName = String(item.tool ?? item.name ?? itemType);
      if (type === "item.started") {
        out.events.push({
          type: "tool_use",
          timestamp,
          data: JSON.stringify({
            name: toolName,
            ...(item.server ? { server: item.server } : {}),
            input: item.arguments ?? item.input ?? item.query,
          }),
        });
      } else if (type === "item.completed") {
        const output = truncateOutput(item.result ?? item.output ?? item.error ?? "");
        out.events.push({
          type: "tool_result",
          timestamp,
          data: JSON.stringify({
            name: toolName,
            ...(item.server ? { server: item.server } : {}),
            output,
          }),
        });
      }
      return out;
    }

    if (itemType === "error") {
      const errMsg = extractItemText(item) || JSON.stringify(item);
      out.events.push({ type: "error", timestamp, data: errMsg });
      return out;
    }

    return out;
  }

  // 3. Eventos diretos / legados (`msg.type` ou Responses API)
  switch (type) {
    case "agent_message":
    case "agent_message_delta":
    case "response.output_text.delta": {
      const text =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.delta === "string"
          ? payload.delta
          : typeof payload.text === "string"
          ? payload.text
          : "";
      if (text) {
        out.events.push({ type: "text", timestamp, data: text });
        if (type === "agent_message") {
          out.resultText = text;
        }
      }
      break;
    }

    case "agent_reasoning":
    case "agent_reasoning_delta":
    case "reasoning": {
      const text =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.delta === "string"
          ? payload.delta
          : extractItemText(payload);
      if (text) {
        out.events.push({ type: "thinking", timestamp, data: text });
      }
      break;
    }

    case "exec_command_begin": {
      const cmd = Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command ?? "");
      out.events.push({
        type: "tool_use",
        timestamp,
        data: JSON.stringify({ name: "exec_command", command: cmd, cwd: payload.cwd }),
      });
      break;
    }

    case "exec_command_end": {
      const output = truncateOutput(payload.aggregated_output ?? payload.stdout ?? payload.stderr ?? "");
      out.events.push({
        type: "tool_result",
        timestamp,
        data: JSON.stringify({
          name: "exec_command",
          exit_code: payload.exit_code,
          output,
        }),
      });
      break;
    }

    case "mcp_tool_call_begin":
    case "patch_apply_begin":
    case "function_call":
    case "tool_use": {
      const name = String(
        payload.invocation?.tool ??
          payload.tool_name ??
          payload.name ??
          (type === "patch_apply_begin" ? "patch_apply" : "tool")
      );
      out.events.push({
        type: "tool_use",
        timestamp,
        data: JSON.stringify({
          name,
          input: payload.invocation?.arguments ?? payload.arguments ?? payload.input ?? payload.changes,
        }),
      });
      break;
    }

    case "mcp_tool_call_end":
    case "patch_apply_end":
    case "function_call_output":
    case "tool_result": {
      const name = String(
        payload.invocation?.tool ??
          payload.tool_name ??
          payload.name ??
          (type === "patch_apply_end" ? "patch_apply" : "tool")
      );
      const output = truncateOutput(payload.result ?? payload.output ?? payload.stdout ?? payload.stderr ?? "");
      out.events.push({
        type: "tool_result",
        timestamp,
        data: JSON.stringify({ name, output }),
      });
      break;
    }

    case "token_count": {
      const info = payload.info && typeof payload.info === "object" ? payload.info : payload;
      const rawUsage = info.last_token_usage ?? info.total_token_usage ?? payload.usage ?? info;
      const parsedUsage = extractUsage(rawUsage, info.model_context_window ?? payload.model_context_window);
      if (parsedUsage) {
        out.usage = parsedUsage;
      }
      break;
    }

    case "task_complete":
    case "result": {
      if (typeof payload.last_agent_message === "string" && payload.last_agent_message) {
        out.resultText = payload.last_agent_message;
      } else if (typeof payload.result === "string" && payload.result) {
        out.resultText = payload.result;
      }
      if (payload.usage) {
        const parsedUsage = extractUsage(payload.usage, payload.model_context_window);
        if (parsedUsage) {
          out.usage = parsedUsage;
        }
      }
      break;
    }

    case "error":
    case "stream_error": {
      const errMsg =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string"
          ? payload.error
          : typeof payload.error?.message === "string"
          ? payload.error.message
          : JSON.stringify(payload);
      out.events.push({ type: "error", timestamp, data: errMsg });
      break;
    }

    default:
      // Eventos desconhecidos (ex: turn.started, exec_command_output_delta, etc.) são ignorados
      break;
  }

  return out;
}

/**
 * Faz o parse de uma linha JSONL bruta do stdout do `codex exec --json`.
 * Retorna `null` se a linha estiver vazia ou não for um JSON válido.
 */
export function parseCodexLine(line: string, timestamp: number = Date.now()): ParsedCodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parseCodexEvent(parsed, timestamp);
  } catch {
    return null;
  }
}

export class CodexAdapter implements Adapter {
  readonly provider: Provider = "codex";
  private activeProcesses = new Map<ChildProcess, string>();

  async *runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const events: TurnEvent[] = [];

    const args = buildCodexArgs(options);
    const marker = randomUUID();

    const child = spawn("codex", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: agentEnv({ [TURN_MARKER]: marker, ...options.env }),
      windowsHide: true,
    });

    this.activeProcesses.set(child, marker);

    let timeoutTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        killTree(child.pid);
      }
    }, timeoutMs);

    let spawnError: NodeJS.ErrnoException | null = null;
    let stderrText = "";

    if (child.stderr) {
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        if (stderrText.length < 4000) {
          stderrText += chunk;
        }
      });
    }

    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.on("close", (code) => resolve({ code }));
      child.on("error", (err: NodeJS.ErrnoException) => {
        spawnError = err;
        resolve({ code: -1 });
      });
    });

    if (child.stdin) {
      child.stdin.on("error", () => {
        // Ignora EPIPE caso o binário não exista ou encerre antes da escrita
      });
      child.stdin.write(options.prompt);
      child.stdin.end();
    }

    let sessionId = options.sessionId;
    let resolvedModel = options.model;
    let lastUsage: CodexRawUsage | undefined;
    let resultText = "";
    let exitCode = 0;

    try {
      if (child.stdout) {
        const rl = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });

        for await (const line of rl) {
          const parsed = parseCodexLine(line);
          if (!parsed) continue;

          if (parsed.sessionId) {
            sessionId = parsed.sessionId;
          }
          if (parsed.model) {
            resolvedModel = parsed.model;
          }
          if (parsed.usage) {
            lastUsage = parsed.usage;
          }
          if (parsed.resultText) {
            resultText = parsed.resultText;
          }

          for (const event of parsed.events) {
            events.push(event);
            yield event;
          }
        }
      }

      const { code } = await exitPromise;
      exitCode = code ?? 0;

      if (spawnError) {
        const err = spawnError as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          throw new Error("codex não encontrado no PATH");
        }
        throw new Error(`Falha ao executar codex: ${err.message}`);
      }

      if (exitCode !== 0 && !events.some((e) => e.type === "error")) {
        const detail = stderrText.trim();
        throw new Error(detail ? `codex encerrou com código ${exitCode}: ${detail}` : `codex encerrou com código ${exitCode}`);
      }
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      this.activeProcesses.delete(child);
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          killTree(child.pid);
        } catch {
          // O processo já pode ter encerrado
        }
      }
      sweepEnvMarker(TURN_MARKER, marker);
    }

    if (!resultText && events.some((e) => e.type === "text")) {
      resultText = events
        .filter((e) => e.type === "text")
        .map((e) => e.data)
        .join("");
    }

    let usage: ContextUsage | undefined;
    if (lastUsage) {
      const usedTokens =
        lastUsage.inputTokens > 0
          ? lastUsage.inputTokens
          : (lastUsage.cachedInputTokens ?? 0);
      const reportedWindow = lastUsage.contextWindow;
      const estimatedWindow = reportedWindow === undefined ? estimateContextWindow(resolvedModel) : undefined;
      const windowTokens = reportedWindow ?? estimatedWindow;
      usage = {
        usedTokens,
        windowTokens,
        windowEstimated: reportedWindow === undefined && windowTokens !== undefined,
        model: resolvedModel,
      };
    }

    const durationMs = Date.now() - startTime;
    return {
      turnId: "",
      agentId: "",
      sessionId,
      text: resultText,
      events,
      exitCode,
      durationMs,
      usage,
    };
  }

  async stop(pid?: number): Promise<void> {
    if (pid !== undefined && pid !== 0) {
      killTree(pid);
      return;
    }

    for (const [child, marker] of this.activeProcesses) {
      if (child.pid) {
        killTree(child.pid);
      }
      sweepEnvMarker(TURN_MARKER, marker);
    }
  }
}
