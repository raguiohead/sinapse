import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Adapter, AdapterRunOptions, Provider, TurnEvent, TurnResult } from "../types.js";
import { killTree } from "../process.js";

export class AgyAdapter implements Adapter {
  readonly provider: Provider = "agy";
  private activeProcesses = new Set<ChildProcess>();

  async *runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const events: TurnEvent[] = [];

    const args = ["-p", options.prompt, "--output-format", "stream-json", "--model", "gemini-3.8-flash-high"];
    if (options.sessionId) {
      args.push("--conversation", options.sessionId);
    }
    if (options.autonomy === "read") {
      args.push("--mode", "plan");
    } else if (options.autonomy === "edit") {
      args.push("--mode", "accept-edits");
    }

    const child = spawn("agy", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });

    this.activeProcesses.add(child);

    let timeoutTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        killTree(child.pid);
      }
    }, timeoutMs);

    let sessionId = options.sessionId;
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

          if (parsed.event === "init") {
            if (parsed.conversation_id) {
              sessionId = parsed.conversation_id;
            }
          } else if (parsed.event === "step_update" && parsed.step_update) {
            const step = parsed.step_update;
            if (step.step_type === "agent_response" && step.state === "ACTIVE") {
              if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
                const event: TurnEvent = {
                  type: "text",
                  timestamp: Date.now(),
                  data: step.text_delta,
                };
                events.push(event);
                yield event;
              }
            } else if (step.step_type === "tool_call") {
              const event: TurnEvent = {
                type: "tool_use",
                timestamp: Date.now(),
                data: JSON.stringify(step),
              };
              events.push(event);
              yield event;
            } else if (step.step_type === "tool_result") {
              const event: TurnEvent = {
                type: "tool_result",
                timestamp: Date.now(),
                data: JSON.stringify(step),
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
    }

    if (!resultText && events.some((e) => e.type === "text")) {
      resultText = events
        .filter((e) => e.type === "text")
        .map((e) => e.data)
        .join("");
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
    };
  }

  async stop(pid?: number): Promise<void> {
    if (pid !== undefined && pid !== 0) {
      killTree(pid);
      return;
    }

    for (const child of this.activeProcesses) {
      if (child.pid) {
        killTree(child.pid);
      }
    }
  }
}
