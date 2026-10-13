#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { AgentState, Autonomy, Provider, TurnEvent } from "@sinapse/core";
import { startDaemon as start } from "@sinapse/core";

const SINAPSE_DIR = path.join(os.homedir(), ".sinapse");
const DAEMON_FILE = path.join(SINAPSE_DIR, "daemon.json");

interface DaemonInfo {
  port: number;
  token: string;
}

async function readDaemonFile(): Promise<DaemonInfo | null> {
  try {
    const content = await fs.readFile(DAEMON_FILE, "utf-8");
    const data = JSON.parse(content);
    if (data.port && data.token) {
      return { port: data.port, token: data.token };
    }
  } catch {
    return null;
  }
  return null;
}

async function isDaemonHealthy(info: DaemonInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = (await res.json()) as { ok?: boolean };
      return data.ok === true;
    }
    return false;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<DaemonInfo> {
  let info = await readDaemonFile();
  if (info && (await isDaemonHealthy(info))) {
    return info;
  }

  // Auto-start daemon in background
  const scriptPath = process.argv[1];
  const isTsx = scriptPath?.endsWith(".ts");
  const child = isTsx && !process.execPath.includes("tsx")
    ? spawn("npx", ["tsx", scriptPath, "start"], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(process.execPath, [scriptPath, "start"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();

  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 100));
    info = await readDaemonFile();
    if (info && (await isDaemonHealthy(info))) {
      return info;
    }
  }

  throw new Error("Failed to connect to daemon or auto-start it.");
}

async function apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const daemon = await ensureDaemon();
  const url = `http://127.0.0.1:${daemon.port}${endpoint}`;
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${daemon.token}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...options, headers });
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function printTable(agents: AgentState[]) {
  if (agents.length === 0) {
    console.log("No agents found.");
    return;
  }

  const headers = ["NAME", "PROVIDER", "STATUS", "AUTONOMY", "CWD"];
  const rows = agents.map((a) => [
    a.name,
    a.provider,
    a.status,
    a.autonomy,
    a.cwd,
  ]);

  const colWidths = headers.map((header, colIdx) => {
    const maxVal = Math.max(
      header.length,
      ...rows.map((row) => (row[colIdx] ? row[colIdx].length : 0))
    );
    return Math.min(maxVal, 40);
  });

  const formatRow = (cols: string[]) =>
    cols
      .map((col, idx) => {
        const truncated =
          col.length > colWidths[idx] ? col.slice(0, colWidths[idx] - 3) + "..." : col;
        return truncated.padEnd(colWidths[idx]);
      })
      .join("  ");

  console.log(formatRow(headers));
  console.log(colWidths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

async function handleResponseError(res: Response): Promise<never> {
  let errMsg = `Request failed with status ${res.status}`;
  try {
    const errJson = await res.json();
    if (errJson.error) errMsg = errJson.error;
  } catch {
    const text = await res.text();
    if (text) errMsg = text;
  }
  console.error(`Error: ${errMsg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Sinapse - Personal Multi-Agent Orchestrator

Usage:
  sinapse start                                              Start daemon
  sinapse list                                               List all agents
  sinapse spawn <name> --provider <p> --cwd <dir> --role <r> [--autonomy edit]
  sinapse ask <name> "<prompt>" [--async]                    Send prompt to agent
  sinapse check <name>                                       Check agent status and events
  sinapse stop <name>                                        Stop active agent turn
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || flags.help || flags.h || command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "start": {
      const existingInfo = await readDaemonFile();
      if (existingInfo && (await isDaemonHealthy(existingInfo))) {
        console.log(`Daemon is already running on http://127.0.0.1:${existingInfo.port}`);
        return;
      }

      const { port } = await start();
      console.log(`sinapsed running on http://127.0.0.1:${port}`);
      break;
    }

    case "list": {
      const res = await apiRequest("/agents");
      if (!res.ok) {
        await handleResponseError(res);
      }
      const agents = (await res.json()) as AgentState[];
      printTable(agents);
      break;
    }

    case "spawn": {
      const name = positional[1];
      if (!name) {
        console.error("Error: Agent name is required. Usage: sinapse spawn <name> --provider <p> --cwd <dir> --role \"...\" [--autonomy edit]");
        process.exit(1);
      }

      const provider = (flags.provider || flags.p) as Provider;
      if (!provider) {
        console.error("Error: --provider is required (e.g. claude, agy)");
        process.exit(1);
      }

      const cwd = (flags.cwd || flags.c || process.cwd()) as string;
      const role = (flags.role || flags.r || "assistant") as string;
      const autonomy = (flags.autonomy || flags.a || "edit") as Autonomy;

      const res = await apiRequest("/agents", {
        method: "POST",
        body: JSON.stringify({ name, provider, cwd, role, autonomy }),
      });

      if (!res.ok) {
        await handleResponseError(res);
      }

      const created = (await res.json()) as AgentState;
      console.log(`Agent "${created.name}" spawned (id: ${created.id}, provider: ${created.provider})`);
      break;
    }

    case "ask": {
      const name = positional[1];
      const prompt = positional[2];
      if (!name || !prompt) {
        console.error("Error: Name and prompt are required. Usage: sinapse ask <name> \"prompt\" [--async]");
        process.exit(1);
      }

      const isAsync = Boolean(flags.async);

      if (isAsync) {
        const res = await apiRequest(`/agents/${encodeURIComponent(name)}/ask`, {
          method: "POST",
          body: JSON.stringify({ prompt, async: true }),
        });
        if (!res.ok) {
          await handleResponseError(res);
        }
        const data = (await res.json()) as { turnId: string };
        console.log(`Turn started: ${data.turnId}`);
      } else {
        const res = await apiRequest(`/agents/${encodeURIComponent(name)}/ask`, {
          method: "POST",
          body: JSON.stringify({ prompt, async: false }),
        });
        if (!res.ok) {
          await handleResponseError(res);
        }

        if (!res.body) {
          console.error("No response stream received.");
          process.exit(1);
        }

        const rl = readline.createInterface({
          input: Readable.fromWeb(res.body as any),
          crlfDelay: Infinity,
        });

        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event: TurnEvent = JSON.parse(trimmed);
            if (event.type === "text") {
              process.stdout.write(event.data);
            } else if (event.type === "tool_use") {
              process.stdout.write(`\n[tool_use] ${event.data}\n`);
            } else if (event.type === "tool_result") {
              process.stdout.write(`\n[tool_result] ${event.data}\n`);
            } else if (event.type === "thinking") {
              process.stderr.write(`[thinking] ${event.data}\n`);
            } else if (event.type === "error") {
              process.stderr.write(`\n[error] ${event.data}\n`);
            } else if (event.type === "done") {
              process.stdout.write("\n");
            }
          } catch {
            console.log(line);
          }
        }
        process.stdout.write("\n");
      }
      break;
    }

    case "check": {
      const name = positional[1];
      if (!name) {
        console.error("Error: Agent name is required. Usage: sinapse check <name>");
        process.exit(1);
      }

      const res = await apiRequest(`/agents/${encodeURIComponent(name)}/check`);
      if (!res.ok) {
        await handleResponseError(res);
      }

      const data = (await res.json()) as {
        agentId: string;
        name: string;
        status: string;
        turnId?: string;
        events?: TurnEvent[];
        lastError?: string;
      };

      console.log(`Agent: ${data.name} (id: ${data.agentId})`);
      console.log(`Status: ${data.status}`);
      if (data.turnId) {
        console.log(`Turn ID: ${data.turnId}`);
      }
      if (data.lastError) {
        console.log(`Last Error: ${data.lastError}`);
      }
      if (data.events && data.events.length > 0) {
        console.log(`\nRecent events (${data.events.length}):`);
        for (const ev of data.events.slice(-10)) {
          const time = new Date(ev.timestamp).toLocaleTimeString();
          const preview =
            ev.data.length > 80 ? ev.data.slice(0, 80).replace(/\n/g, " ") + "..." : ev.data.replace(/\n/g, " ");
          console.log(`  [${time}] [${ev.type}] ${preview}`);
        }
      }
      break;
    }

    case "stop": {
      const name = positional[1];
      if (!name) {
        console.error("Error: Agent name is required. Usage: sinapse stop <name>");
        process.exit(1);
      }

      const res = await apiRequest(`/agents/${encodeURIComponent(name)}/stop`, {
        method: "POST",
      });
      if (!res.ok) {
        await handleResponseError(res);
      }

      console.log(`Agent "${name}" stopped.`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
