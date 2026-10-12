import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Adapter, AdapterRunOptions, Provider, TurnEvent, TurnResult } from "../types.js";

export class ClaudeAdapter implements Adapter {
  readonly provider: Provider = "claude";
  private activeProcesses = new Set<ChildProcess>();

  async *runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const events: TurnEvent[] = [];

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }
    if (options.autonomy === "read") {
      args.push("--permission-mode", "plan");
    } else if (options.autonomy === "edit") {
      args.push("--permission-mode", "acceptEdits");
    }

    const child = spawn("claude", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.activeProcesses.add(child);

    let timeoutTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    if (child.stdin) {
      child.stdin.write(options.prompt);
      child.stdin.end();
    }

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

          if (parsed.type === "assistant" && parsed.message?.content && Array.isArray(parsed.message.content)) {
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
      if (!child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process might have already exited
        }
      }
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
      try {
        process.kill(pid, "SIGTERM");
      } catch (err: any) {
        if (err.code !== "ESRCH") throw err;
      }
      return;
    }

    for (const child of this.activeProcesses) {
      try {
        if (child.pid) {
          process.kill(child.pid, "SIGTERM");
        }
      } catch (err: any) {
        if (err.code !== "ESRCH") throw err;
      }
    }
  }
}
