import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Adapter, AdapterRunOptions, ContextUsage, Provider, TurnEvent, TurnResult } from "../types.js";
import { randomUUID } from "node:crypto";
import { agentEnv, killTree, sweepEnvMarker, TURN_MARKER } from "../process.js";
import { estimateContextWindow } from "../context.js";

export class ClaudeAdapter implements Adapter {
  readonly provider: Provider = "claude";
  private activeProcesses = new Map<ChildProcess, string>();

  async *runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const events: TurnEvent[] = [];

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }
    if (options.autonomy === "read") {
      args.push("--permission-mode", "plan");
    } else if (options.autonomy === "edit") {
      args.push("--permission-mode", "acceptEdits");
    }

    const marker = randomUUID();
    const child = spawn("claude", args, {
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

    if (child.stdin) {
      child.stdin.write(options.prompt);
      child.stdin.end();
    }

    let sessionId = options.sessionId;
    let resolvedModel = options.model;
    let usage: ContextUsage | undefined;
    let resultText = "";
    let exitCode = 0;

    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.on("close", (code) => resolve({ code }));
      child.on("error", () => resolve({ code: -1 }));
    });

    try {
      if (child.stdout) {
        const rl = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });

        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (parsed.type === "system" && parsed.subtype === "init" && parsed.model) {
            resolvedModel = parsed.model;
          } else if (parsed.type === "assistant" && parsed.message?.content && Array.isArray(parsed.message.content)) {
            for (const content of parsed.message.content) {
              if (content.type === "text" && typeof content.text === "string") {
                const event: TurnEvent = {
                  type: "text",
                  timestamp: Date.now(),
                  data: content.text,
                };
                events.push(event);
                yield event;
              } else if (content.type === "tool_use") {
                const event: TurnEvent = {
                  type: "tool_use",
                  timestamp: Date.now(),
                  data: JSON.stringify(content),
                };
                events.push(event);
                yield event;
              } else if (content.type === "thinking") {
                const event: TurnEvent = {
                  type: "thinking",
                  timestamp: Date.now(),
                  data: content.thinking || content.text || JSON.stringify(content),
                };
                events.push(event);
                yield event;
              }
            }
          } else if (parsed.type === "result") {
            if (parsed.session_id) {
              sessionId = parsed.session_id;
            }
            if (parsed.result !== undefined && parsed.result !== null) {
              resultText = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
            }

            const rawUsage = parsed.usage ?? (typeof parsed.result === "object" ? parsed.result?.usage : undefined);
            const lastIteration =
              Array.isArray(rawUsage?.iterations) && rawUsage.iterations.length > 0
                ? rawUsage.iterations[rawUsage.iterations.length - 1]
                : rawUsage;

            const inputTokens = Number(lastIteration?.input_tokens ?? 0);
            const cacheCreation = Number(lastIteration?.cache_creation_input_tokens ?? 0);
            const cacheRead = Number(lastIteration?.cache_read_input_tokens ?? 0);
            const usedTokens = inputTokens + cacheCreation + cacheRead;

            const modelUsage =
              parsed.modelUsage ?? (typeof parsed.result === "object" ? parsed.result?.modelUsage : undefined);

            let windowTokens: number | undefined;
            let windowEstimated = false;

            if (modelUsage && typeof modelUsage === "object") {
              if (resolvedModel && modelUsage[resolvedModel]?.contextWindow !== undefined) {
                windowTokens = modelUsage[resolvedModel].contextWindow;
              } else {
                const firstKey = Object.keys(modelUsage)[0];
                if (firstKey && modelUsage[firstKey]?.contextWindow !== undefined) {
                  windowTokens = modelUsage[firstKey].contextWindow;
                }
              }
            }

            if (windowTokens !== undefined) {
              windowEstimated = false;
            } else {
              windowTokens = estimateContextWindow(resolvedModel);
              windowEstimated = true;
            }

            usage = {
              usedTokens,
              windowTokens,
              windowEstimated,
              model: resolvedModel,
            };
          }
        }
      }

      const { code } = await exitPromise;
      exitCode = code ?? 0;
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
          // Process might have already exited
        }
      }
      // Detached leftovers (MCP servers) carry the turn marker even after the CLI is gone.
      sweepEnvMarker(TURN_MARKER, marker);
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
