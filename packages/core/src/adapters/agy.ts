import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Adapter, AdapterRunOptions, ContextUsage, Provider, TurnEvent, TurnResult } from "../types.js";
import { randomUUID } from "node:crypto";
import { agentEnv, killTree, sweepEnvMarker, TURN_MARKER } from "../process.js";
import { estimateContextWindow } from "../context.js";

export class AgyAdapter implements Adapter {
  readonly provider: Provider = "agy";
  private activeProcesses = new Map<ChildProcess, string>();

  async *runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const events: TurnEvent[] = [];

    const model = options.model ?? "gemini-3.8-flash-high";
    // "-p=<prompt>" keeps a prompt that starts with "-" from being parsed as a flag.
    const args = [`-p=${options.prompt}`, "--output-format", "stream-json", "--model", model];
    if (options.sessionId) {
      args.push("--conversation", options.sessionId);
    }
    if (options.autonomy === "read") {
      args.push("--mode", "plan");
    } else if (options.autonomy === "edit") {
      args.push("--mode", "accept-edits");
    }

    const marker = randomUUID();
    const child = spawn("agy", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: agentEnv({ [TURN_MARKER]: marker }),
      windowsHide: true,
    });

    this.activeProcesses.set(child, marker);

    let timeoutTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        killTree(child.pid);
      }
    }, timeoutMs);

    let sessionId = options.sessionId;
    let resolvedModel = model;
    let lastUsage: { input_tokens: number; cache_read_tokens?: number } | undefined;
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

          if (parsed.event === "init" || parsed.type === "init") {
            if (parsed.conversation_id) {
              sessionId = parsed.conversation_id;
            }
            if (parsed.init?.model) {
              resolvedModel = parsed.init.model;
            } else if (parsed.model) {
              resolvedModel = parsed.model;
            }
          } else if (parsed.event === "step_update" && parsed.step_update) {
            const step = parsed.step_update;
            if (step.usage) {
              lastUsage = step.usage;
            }
            if (step.step_type === "agent_response") {
              if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
                const event: TurnEvent = {
                  type: "text",
                  timestamp: Date.now(),
                  data: step.text_delta,
                };
                events.push(event);
                yield event;
              }
            } else if (step.step_type === "tool" && step.state === "ACTIVE") {
              const event: TurnEvent = {
                type: "tool_use",
                timestamp: Date.now(),
                data: JSON.stringify({ name: step.tool_name, input: step.tool_info?.parameters }),
              };
              events.push(event);
              yield event;
            } else if (step.step_type === "tool" && step.state === "DONE") {
              const output = String(step.tool_info?.output ?? "");
              const event: TurnEvent = {
                type: "tool_result",
                timestamp: Date.now(),
                data: JSON.stringify({ name: step.tool_name, output: output.slice(0, 2000) }),
              };
              events.push(event);
              yield event;
            }
          } else if (parsed.event === "result") {
            if (parsed.result?.conversation_id) {
              sessionId = parsed.result.conversation_id;
            }
            if (parsed.result?.response !== undefined && parsed.result?.response !== null) {
              resultText = typeof parsed.result.response === "string" ? parsed.result.response : JSON.stringify(parsed.result.response);
            }
            if (!lastUsage && parsed.result?.usage) {
              lastUsage = parsed.result.usage;
            }
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

    if (!resultText && events.some((e) => e.type === "text")) {
      resultText = events
        .filter((e) => e.type === "text")
        .map((e) => e.data)
        .join("");
    }

    let usage: ContextUsage | undefined;
    if (lastUsage) {
      const usedTokens = Number(lastUsage.input_tokens ?? 0) + Number(lastUsage.cache_read_tokens ?? 0);
      const windowTokens = estimateContextWindow(model);
      usage = {
        usedTokens,
        windowTokens,
        windowEstimated: true,
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
