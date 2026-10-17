#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  AgentDeleteResult,
  AgentState,
  AskResponse,
  Autonomy,
  CheckResponse,
  ContextUsage,
  HandoffResponse,
  ModelCatalog,
  ModelOption,
  Note,
  NoteSummary,
  Provider,
  StopResponse,
  SquadApplyResult,
  SquadCatalog,
  TurnEvent,
  WaitResponse,
  WaitResult,
  Workspace,
} from "@sinapse/core";
import {
  startDaemon as start,
  sinapseDir,
  routes,
  AUTHOR_HEADER,
  ENV,
} from "@sinapse/core";

const SINAPSE_DIR = sinapseDir();
const DAEMON_FILE = path.join(SINAPSE_DIR, "daemon.json");

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = Math.round(tokens / 100_000) / 10;
    return `${m}m`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
}

function formatContext(usage?: ContextUsage): string {
  if (!usage || usage.usedTokens === undefined) {
    return "-";
  }
  const used = formatTokens(usage.usedTokens);
  if (!usage.windowTokens) {
    return usage.windowEstimated ? `≈${used}` : used;
  }
  const win = formatTokens(usage.windowTokens);
  const pct = Math.round((usage.usedTokens / usage.windowTokens) * 100);
  const formatted = `${used}/${win} ${pct}%`;
  return usage.windowEstimated ? `≈${formatted}` : formatted;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function noteText(positional: string[], command: "write" | "append"): Promise<string> {
  const words = positional.slice(3);
  if (words.length === 1 && words[0] === "-") return readStdin();
  if (words.length === 0) {
    console.error(
      `Erro: falta o texto. Uso: sinapse note ${command} <nome> "<texto>"  (ou "-" para ler do stdin)`
    );
    process.exit(1);
  }
  return words.join(" ");
}

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
    const res = await fetch(`http://127.0.0.1:${info.port}${routes.health()}`, {
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

function authorHeaders(): Record<string, string> {
  const agentId = process.env.SINAPSE_AGENT_ID || process.env[ENV.agentId];
  if (agentId && agentId.trim()) {
    return { [AUTHOR_HEADER]: agentId.trim() };
  }
  return {};
}

let cachedWorkspaces: Workspace[] | null = null;
async function getWorkspaces(): Promise<Workspace[]> {
  if (cachedWorkspaces) return cachedWorkspaces;
  const res = await apiRequest(routes.workspaces());
  if (!res.ok) await handleResponseError(res);
  cachedWorkspaces = (await res.json()) as Workspace[];
  return cachedWorkspaces;
}

async function resolveWorkspace(flags: Record<string, any>): Promise<Workspace> {
  const workspaces = await getWorkspaces();
  if (workspaces.length === 0) {
    console.error("Erro: Nenhum workspace disponível.");
    process.exit(1);
  }

  const explicit = (flags.workspace || flags.w) as string | undefined;
  if (explicit && typeof explicit === "string" && explicit.trim()) {
    const target = explicit.trim();
    const targetLower = target.toLowerCase();
    const found = workspaces.find((w) => w.id === target || w.name.toLowerCase() === targetLower);
    if (!found) {
      console.error(`Erro: Workspace "${target}" não encontrado.`);
      process.exit(1);
    }
    return found;
  }

  const envWs = process.env.SINAPSE_WORKSPACE || process.env[ENV.workspace];
  if (envWs && envWs.trim()) {
    const target = envWs.trim();
    const targetLower = target.toLowerCase();
    const found = workspaces.find((w) => w.id === target || w.name.toLowerCase() === targetLower);
    if (!found) {
      console.error(`Erro: Workspace "${target}" não encontrado.`);
      process.exit(1);
    }
    return found;
  }

  const cwd = process.cwd();
  const matching = workspaces.filter((w) => {
    const rel = path.relative(w.folder, cwd);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });

  if (matching.length > 0) {
    matching.sort((a, b) => b.folder.length - a.folder.length);
    return matching[0];
  }

  const geral = workspaces.find((w) => w.id === "geral" || w.name.toLowerCase() === "geral");
  if (geral) return geral;

  return workspaces[0];
}

const FLAG_PATTERN = /^--?[A-Za-z]/;
/** Flags that never take a value, so `wait --any a b` and `--force <name>` keep the next word as an argument. */
const BOOLEAN_FLAGS = new Set(["async", "queue", "any", "full", "help", "h", "worktree", "force"]);

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAG_PATTERN.test(arg)) {
      const key = arg.replace(/^--?/, "");
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (next !== undefined && !FLAG_PATTERN.test(next)) {
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
    console.log("Nenhum worker encontrado.");
    return;
  }

  const headers = ["NAME", "PROVIDER", "MODELO", "CONTEXTO", "STATUS", "AUTONOMY", "CWD"];
  const rows = agents.map((a) => [
    a.name,
    a.provider,
    a.usage?.model ?? a.model ?? "padrão",
    formatContext(a.usage),
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

async function listWorkspaces() {
  const workspaces = await getWorkspaces();
  if (workspaces.length === 0) {
    console.log("Nenhum workspace encontrado.");
    return;
  }

  const agentCounts = await Promise.all(
    workspaces.map(async (w) => {
      try {
        const res = await apiRequest(routes.agents(w.id));
        if (res.ok) {
          const agents = (await res.json()) as AgentState[];
          return agents.length;
        }
      } catch {}
      return 0;
    })
  );

  const headers = ["ID", "NOME", "PASTA", "ORQUESTRADOR", "AGENTES"];
  const rows = workspaces.map((w, idx) => {
    const orch = w.orchestrator.model
      ? `${w.orchestrator.provider} (${w.orchestrator.model})`
      : w.orchestrator.provider;
    return [w.id, w.name, w.folder, orch, String(agentCounts[idx])];
  });

  const colWidths = headers.map((header, colIdx) => {
    const maxVal = Math.max(
      header.length,
      ...rows.map((row) => (row[colIdx] ? row[colIdx].length : 0))
    );
    return Math.min(maxVal, 60);
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

/** Each long-poll stays under the daemon's 60s cap; the loop runs until the condition holds or `timeoutSec` passes. */
const WAIT_CHUNK_MS = 55_000;

async function waitForWorkers(
  ws: Workspace,
  agents: string[],
  options: { any?: boolean; timeoutSec?: number } = {}
): Promise<WaitResponse> {
  const deadline = options.timeoutSec !== undefined ? Date.now() + options.timeoutSec * 1000 : Infinity;
  for (;;) {
    const remaining = deadline - Date.now();
    const res = await apiRequest(routes.wait(ws.id), {
      method: "POST",
      body: JSON.stringify({
        agents,
        any: Boolean(options.any),
        timeoutMs: Math.max(0, Math.min(WAIT_CHUNK_MS, remaining)),
      }),
    });
    if (!res.ok) await handleResponseError(res);
    const data = (await res.json()) as WaitResponse;
    if (data.done || Date.now() >= deadline) return data;
  }
}

function parseTimeoutSec(flags: Record<string, string | boolean>): number | undefined {
  const raw = flags.timeout ?? flags.t;
  if (raw === undefined) return undefined;
  const value = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) {
    console.error("Erro: --timeout deve ser um número de segundos (>= 0).");
    process.exit(1);
  }
  return value;
}

function printWaitResult(r: WaitResult) {
  console.log(`=== ${r.name} ===`);
  console.log(`Status: ${r.status}${r.busy ? " (ainda ocupado)" : ""}`);
  console.log(`Contexto: ${formatContext(r.usage)}`);
  if (r.queued > 0) {
    console.log(`Fila: ${r.queued} prompt(s)`);
  }
  if (r.lastError) {
    console.log(`Erro: ${r.lastError}`);
  }
  if (!r.busy && r.text) {
    console.log("");
    console.log(r.text.replace(/\s+$/, ""));
  }
  console.log("");
}

function printHelp() {
  console.log(`Sinapse - Orquestrador Pessoal Multiagente

Uso:
  sinapse start                                              Inicia o daemon
  sinapse workspaces                                         Lista todos os workspaces
  sinapse workspace create <nome> --folder <dir> [--orchestrator claude|agy] [--model <m>]
  sinapse workspace rm <nome|id>                             Remove um workspace
  sinapse list [--workspace <ws>]                            Lista workers do workspace
  sinapse spawn <nome> --provider <p> [--cwd <dir>] --role <r> [--autonomy edit] [--model <m>] [--workspace <ws>]
                [--worktree]                                 Isola o worker numa git worktree (branch sinapse/<nome>)
  sinapse squad list                                         Lista presets de squad (embutidos + ~/.sinapse/squads.json)
  sinapse squad apply <preset> [--prefix <p>] [--worktree] [--workspace <ws>]
                                                             Cria os workers do preset (<prefix>-<membro>)
  sinapse ask <nome> "<prompt>" [--async] [--workspace <ws>] Envia prompt ao worker
  sinapse ask <nome> "<prompt>" --queue [--workspace <ws>]   Enfileira se o worker estiver ocupado (implica --async)
  sinapse wait <n1> [n2 ...] [--any] [--timeout <seg>]       Espera os workers terminarem e imprime as respostas
  sinapse check <nome> [--full] [--workspace <ws>]           Consulta status e eventos (--full: resposta completa)
  sinapse stop <nome> [--workspace <ws>]                     Interrompe o turno ativo e esvazia a fila
  sinapse handoff <nome> [--note <nota>] [--workspace <ws>]  Resume o trabalho numa nota e zera a sessão do worker
  sinapse rm <nome> [--force] [--workspace <ws>]             Remove o worker (--force apaga worktree/branch mesmo com trabalho nela)
  sinapse models [claude|codex|agy]                          Lista catálogo de modelos
  sinapse model <nome> <modelo|padrao> [--workspace <ws>]    Altera o modelo de um worker
  sinapse note list [--workspace <ws>]                       Lista notas do workspace
  sinapse note read <nome> [--workspace <ws>]                Exibe o conteúdo da nota
  sinapse note write <nome> "<texto>"|- [--workspace <ws>]   Cria ou sobrescreve uma nota
  sinapse note append <nome> "<texto>"|- [--workspace <ws>]  Adiciona texto a uma nota existente
  sinapse note rm <nome> [--workspace <ws>]                  Remove uma nota
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

      const { port } = await start({ handleSignals: true });
      console.log(`sinapsed running on http://127.0.0.1:${port}`);
      break;
    }

    case "workspaces":
    case "workspace": {
      const subCommand = positional[1];
      if (!subCommand || subCommand === "list") {
        await listWorkspaces();
        break;
      }

      if (subCommand === "create") {
        const name = positional[2];
        if (!name) {
          console.error(
            'Erro: Nome do workspace é obrigatório. Uso: sinapse workspace create <nome> --folder <dir> [--orchestrator claude|agy] [--model <m>]'
          );
          process.exit(1);
        }
        const folder = (flags.folder || flags.f) as string | undefined;
        if (!folder) {
          console.error("Erro: Pasta do workspace é obrigatória (--folder <dir>).");
          process.exit(1);
        }
        const provider = ((flags.orchestrator || flags.o || "claude") as string).toLowerCase();
        if (provider !== "claude" && provider !== "agy") {
          console.error('Erro: Provedor do orquestrador inválido. Use "claude" ou "agy".');
          process.exit(1);
        }
        const model = (flags.model || flags.m) as string | undefined;

        const res = await apiRequest(routes.workspaces(), {
          method: "POST",
          body: JSON.stringify({
            name,
            folder: path.resolve(folder),
            orchestrator: {
              provider,
              ...(model ? { model } : {}),
            },
          }),
        });
        if (!res.ok) {
          await handleResponseError(res);
        }
        const ws = (await res.json()) as Workspace;
        console.log(`Workspace "${ws.name}" criado (id: ${ws.id}, pasta: ${ws.folder}).`);
        break;
      }

      if (subCommand === "rm" || subCommand === "delete") {
        const name = positional[2];
        if (!name) {
          console.error("Erro: Identificador do workspace é obrigatório. Uso: sinapse workspace rm <nome|id>");
          process.exit(1);
        }
        const res = await apiRequest(routes.workspace(name), {
          method: "DELETE",
        });
        if (!res.ok) {
          await handleResponseError(res);
        }
        console.log(`Workspace "${name}" removido.`);
        break;
      }

      console.error(`Subcomando desconhecido: "${subCommand}". Uso: sinapse workspace [list|create|rm]`);
      process.exit(1);
    }

    case "list": {
      const ws = await resolveWorkspace(flags);
      const res = await apiRequest(routes.agents(ws.id));
      if (!res.ok) {
        await handleResponseError(res);
      }
      const agents = (await res.json()) as AgentState[];
      console.log(`Workspace: ${ws.name} (${ws.folder})`);
      printTable(agents);
      break;
    }

    case "spawn": {
      const name = positional[1];
      if (!name) {
        console.error("Erro: Nome do agente é obrigatório. Uso: sinapse spawn <name> --provider <p> [--cwd <dir>] --role \"...\" [--autonomy edit] [--model <m>]");
        process.exit(1);
      }

      const provider = ((flags.provider || flags.p || "") as string).toLowerCase() as Provider;
      if (!provider) {
        console.error("Erro: --provider é obrigatório (claude, codex ou agy)");
        process.exit(1);
      }
      if (provider !== "claude" && provider !== "codex" && provider !== "agy") {
        console.error(`Erro: Provedor inválido: "${provider}". Use "claude", "codex" ou "agy".`);
        process.exit(1);
      }

      const cwd = (flags.cwd || flags.c) as string | undefined;
      const role = (flags.role || flags.r || "assistant") as string;
      const autonomy = (flags.autonomy || flags.a || "edit") as Autonomy;
      const model = (flags.model || flags.m) as string | undefined;

      const ws = await resolveWorkspace(flags);

      const res = await apiRequest(routes.agents(ws.id), {
        method: "POST",
        headers: authorHeaders(),
        body: JSON.stringify({
          name,
          provider,
          ...(cwd ? { cwd } : {}),
          role,
          autonomy,
          ...(model ? { model } : {}),
          ...(flags.worktree ? { worktree: true } : {}),
        }),
      });

      if (!res.ok) {
        await handleResponseError(res);
      }

      const created = (await res.json()) as AgentState;
      console.log(`Agent "${created.name}" spawned (id: ${created.id}, provider: ${created.provider}${created.model ? `, model: ${created.model}` : ""})`);
      if (created.worktree) {
        console.log(`Worktree: ${created.worktree.path} (branch ${created.worktree.branch})`);
      }
      break;
    }

    case "squad": {
      const sub = positional[1];
      if (sub === "list") {
        const res = await apiRequest(routes.squads());
        if (!res.ok) await handleResponseError(res);
        const catalog = (await res.json()) as SquadCatalog;
        for (const preset of catalog.presets) {
          console.log(`${preset.name} [${preset.source}]${preset.description ? ` - ${preset.description}` : ""}`);
          for (const m of preset.members) {
            console.log(`  ${m.name}  ${m.provider}${m.model ? `/${m.model}` : ""}  ${m.autonomy}  ${m.role}`);
          }
        }
        for (const w of catalog.warnings) console.error(`Aviso: ${w}`);
        break;
      }
      if (sub === "apply") {
        const preset = positional[2];
        if (!preset) {
          console.error("Erro: Nome do preset é obrigatório. Uso: sinapse squad apply <preset> [--prefix <p>] [--worktree]");
          process.exit(1);
        }
        const prefix = typeof flags.prefix === "string" ? flags.prefix : undefined;
        const ws = await resolveWorkspace(flags);
        const res = await apiRequest(routes.squadApply(ws.id), {
          method: "POST",
          headers: authorHeaders(),
          body: JSON.stringify({
            preset,
            ...(prefix ? { prefix } : {}),
            ...(flags.worktree ? { worktree: true } : {}),
          }),
        });
        if (!res.ok) await handleResponseError(res);
        const result = (await res.json()) as SquadApplyResult;
        for (const a of result.created) {
          console.log(`Criado: ${a.name} (${a.provider}, ${a.autonomy})${a.worktree ? ` worktree ${a.worktree.path} [${a.worktree.branch}]` : ""}`);
        }
        for (const s of result.skipped) console.error(`Aviso: "${s.name}" ignorado (${s.reason}).`);
        for (const f of result.failed) console.error(`Erro: "${f.name}" não foi criado: ${f.error}`);
        if (result.failed.length > 0) process.exit(1);
        break;
      }
      console.error("Uso: sinapse squad list | sinapse squad apply <preset> [--prefix <p>] [--worktree]");
      process.exit(1);
    }

    case "ask": {
      const name = positional[1];
      const prompt = positional[2];
      if (!name || !prompt) {
        console.error("Erro: Nome e prompt são obrigatórios. Uso: sinapse ask <name> \"prompt\" [--async|--queue]");
        process.exit(1);
      }

      const ws = await resolveWorkspace(flags);
      const queue = Boolean(flags.queue);
      const isAsync = Boolean(flags.async) || queue;

      if (isAsync) {
        const res = await apiRequest(routes.agentAsk(ws.id, name), {
          method: "POST",
          body: JSON.stringify({ prompt, async: true, ...(queue ? { queue: true } : {}) }),
        });
        if (!res.ok) {
          await handleResponseError(res);
        }
        const data = (await res.json()) as AskResponse;
        if (data.status === "queued") {
          console.log(`Worker ocupado: prompt enfileirado (posição ${data.position ?? "?"}). Turn ID: ${data.turnId}`);
        } else {
          console.log(`Turn started: ${data.turnId}`);
        }
      } else {
        const res = await apiRequest(routes.agentAsk(ws.id, name), {
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
        console.error("Erro: Nome do agente é obrigatório. Uso: sinapse check <name>");
        process.exit(1);
      }

      const ws = await resolveWorkspace(flags);
      const res = await apiRequest(routes.agentCheck(ws.id, name));
      if (!res.ok) {
        await handleResponseError(res);
      }

      const data = (await res.json()) as CheckResponse;

      console.log(`Agent: ${data.name} (id: ${data.agentId})`);
      console.log(`Modelo: ${data.usage?.model ?? data.model ?? "padrão"}`);
      console.log(`Contexto: ${formatContext(data.usage)}`);
      console.log(`Status: ${data.status}`);
      if (data.turnId) {
        console.log(`Turn ID: ${data.turnId}`);
      }
      if (data.queued > 0) {
        console.log(`Fila: ${data.queued} prompt(s) aguardando`);
      }
      if (data.handoffNote) {
        console.log(`Handoff pendente: o próximo turno começa lendo a nota "${data.handoffNote}"`);
      }
      if (data.lastError) {
        console.log(`Last Error: ${data.lastError}`);
      }
      if (flags.full) {
        const label = data.status === "thinking" ? "Resposta parcial (turno em andamento)" : "Última resposta";
        console.log(`\n${label}:`);
        console.log(data.text ? data.text.replace(/\s+$/, "") : "(sem texto)");
      } else if (data.events && data.events.length > 0) {
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
        console.error("Erro: Nome do agente é obrigatório. Uso: sinapse stop <name>");
        process.exit(1);
      }

      const ws = await resolveWorkspace(flags);
      const res = await apiRequest(routes.agentStop(ws.id, name), {
        method: "POST",
      });
      if (!res.ok) {
        await handleResponseError(res);
      }

      const data = (await res.json()) as StopResponse;
      console.log(
        data.interrupted
          ? `Worker "${name}": turno atual interrompido.`
          : `Worker "${name}": nenhum turno em andamento.`
      );
      console.log(
        data.clearedQueue > 0
          ? `Fila esvaziada: ${data.clearedQueue} prompt(s) descartado(s).`
          : "Fila: vazia (nada descartado)."
      );
      break;
    }

    case "wait": {
      const names = positional.slice(1);
      if (names.length === 0) {
        console.error("Erro: informe ao menos um worker. Uso: sinapse wait <n1> [n2 ...] [--any] [--timeout <seg>]");
        process.exit(1);
      }
      const timeoutSec = parseTimeoutSec(flags);
      const ws = await resolveWorkspace(flags);
      const data = await waitForWorkers(ws, names, { any: Boolean(flags.any), timeoutSec });

      for (const r of data.results) {
        printWaitResult(r);
      }
      if (!data.done) {
        console.error(`Tempo esgotado (${timeoutSec}s): ainda há worker ocupado.`);
        process.exit(2);
      }
      if (data.results.some((r) => !r.busy && r.status === "error")) {
        process.exit(1);
      }
      break;
    }

    case "handoff": {
      const name = positional[1];
      if (!name) {
        console.error("Erro: Nome do worker é obrigatório. Uso: sinapse handoff <nome> [--note <nota>]");
        process.exit(1);
      }
      const note = typeof flags.note === "string" ? flags.note : undefined;
      const timeoutSec = parseTimeoutSec(flags);
      const ws = await resolveWorkspace(flags);

      const res = await apiRequest(routes.agentHandoff(ws.id, name), {
        method: "POST",
        body: JSON.stringify(note ? { note } : {}),
      });
      if (!res.ok) {
        await handleResponseError(res);
      }
      const started = (await res.json()) as HandoffResponse;
      console.log(`Gerando handoff de "${name}" (turn ${started.turnId})...`);

      const waited = await waitForWorkers(ws, [name], { timeoutSec });
      if (!waited.done) {
        console.error(`Tempo esgotado (${timeoutSec}s): o handoff ainda está rodando; confira com sinapse check ${name}.`);
        process.exit(2);
      }

      const checkRes = await apiRequest(routes.agentCheck(ws.id, name));
      if (!checkRes.ok) {
        await handleResponseError(checkRes);
      }
      const check = (await checkRes.json()) as CheckResponse;
      const outcome = check.lastHandoff?.turnId === started.turnId ? check.lastHandoff : undefined;
      if (!outcome?.ok) {
        console.error(`Handoff falhou: ${outcome?.error ?? check.lastError ?? "motivo desconhecido"}`);
        process.exit(1);
      }
      console.log(`Handoff salvo na nota "${outcome.note}" (sinapse note read ${outcome.note}).`);
      console.log(`Sessão de "${name}" zerada; o próximo turno começa lendo essa nota.`);
      break;
    }

    case "rm": {
      const name = positional[1];
      if (!name) {
        console.error("Erro: Nome do worker é obrigatório. Uso: sinapse rm <nome>");
        process.exit(1);
      }
      const ws = await resolveWorkspace(flags);
      const res = await apiRequest(`${routes.agent(ws.id, name)}${flags.force ? "?force=1" : ""}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        await handleResponseError(res);
      }
      const removed = (await res.json()) as AgentDeleteResult;
      console.log(`Worker "${name}" removido.`);
      if (removed.worktree?.action === "removed") {
        console.log(`Worktree e branch ${removed.worktree.branch} removidas.`);
      } else if (removed.worktree) {
        console.error(
          `Aviso: worktree e branch mantidas (${removed.worktree.reason ?? "motivo desconhecido"}): ` +
            `${removed.worktree.path} [${removed.worktree.branch}]. Faça o merge/descarte manualmente ou use "sinapse rm --force".`
        );
      }
      break;
    }

    case "models": {
      const provider = positional[1]?.toLowerCase();
      const res = await apiRequest(routes.models());
      if (!res.ok) {
        await handleResponseError(res);
      }
      const catalog = (await res.json()) as ModelCatalog;

      const printGroup = (title: string, models: ModelOption[]) => {
        console.log(`${title}:`);
        for (const m of models) {
          console.log(`  ${m.id.padEnd(28)} ${m.label}`);
        }
      };

      if (!provider) {
        printGroup("Claude", catalog.claude || []);
        console.log("");
        printGroup("Codex", catalog.codex || []);
        console.log("");
        printGroup("AGY", catalog.agy || []);
      } else if (provider === "claude") {
        printGroup("Claude", catalog.claude || []);
      } else if (provider === "codex") {
        printGroup("Codex", catalog.codex || []);
      } else if (provider === "agy") {
        printGroup("AGY", catalog.agy || []);
      } else {
        console.error(`Provedor desconhecido: "${provider}". Use "claude", "codex" ou "agy".`);
        process.exit(1);
      }
      break;
    }

    case "model": {
      const name = positional[1];
      const modelArg = positional[2];
      if (!name || !modelArg) {
        console.error("Uso: sinapse model <nome> <modelo|padrao>");
        process.exit(1);
      }

      const ws = await resolveWorkspace(flags);
      const isDefault = modelArg === "padrao" || modelArg === "padrão";
      const res = await apiRequest(routes.agent(ws.id, name), {
        method: "PATCH",
        body: JSON.stringify({ model: isDefault ? null : modelArg }),
      });

      if (!res.ok) {
        await handleResponseError(res);
      }

      const agent = (await res.json()) as AgentState;
      console.log(`Modelo de "${agent.name}" atualizado para: ${agent.model ?? "padrão"}`);
      break;
    }

    case "note":
    case "notes": {
      const subCommand = positional[1];
      if (!subCommand || subCommand === "help") {
        console.log(`Uso:
  sinapse note list [--workspace <ws>]
  sinapse note read <nome> [--workspace <ws>]
  sinapse note write <nome> "<texto>"|- [--workspace <ws>]
  sinapse note append <nome> "<texto>"|- [--workspace <ws>]
  sinapse note rm <nome> [--workspace <ws>]`);
        return;
      }

      switch (subCommand) {
        case "list": {
          const ws = await resolveWorkspace(flags);
          const res = await apiRequest(routes.notes(ws.id));
          if (!res.ok) await handleResponseError(res);
          const notes = (await res.json()) as NoteSummary[];
          if (notes.length === 0) {
            console.log("Nenhuma nota encontrada.");
            return;
          }
          const headers = ["NOME", "TÍTULO", "ATUALIZADO"];
          const rows = notes.map((n) => [
            n.name,
            n.title,
            new Date(n.updatedAt).toLocaleString("pt-BR"),
          ]);
          const colWidths = headers.map((h, i) =>
            Math.max(h.length, ...rows.map((r) => r[i]?.length || 0))
          );
          const formatRow = (cols: string[]) =>
            cols.map((c, i) => c.padEnd(colWidths[i])).join("  ");
          console.log(formatRow(headers));
          console.log(colWidths.map((w) => "-".repeat(w)).join("  "));
          for (const row of rows) {
            console.log(formatRow(row));
          }
          break;
        }

        case "read": {
          const name = positional[2];
          if (!name) {
            console.error("Erro: Nome da nota é obrigatório. Uso: sinapse note read <nome>");
            process.exit(1);
          }
          const ws = await resolveWorkspace(flags);
          const res = await apiRequest(routes.note(ws.id, name));
          if (!res.ok) await handleResponseError(res);
          const note = (await res.json()) as Note;
          process.stdout.write(note.content);
          if (!note.content.endsWith("\n")) {
            process.stdout.write("\n");
          }
          break;
        }

        case "write": {
          const name = positional[2];
          if (!name) {
            console.error('Erro: Nome da nota é obrigatório. Uso: sinapse note write <nome> "<texto>" (ou "-" para ler do stdin)');
            process.exit(1);
          }
          const text = await noteText(positional, "write");
          const ws = await resolveWorkspace(flags);
          const res = await apiRequest(routes.note(ws.id, name), {
            method: "PUT",
            headers: authorHeaders(),
            body: JSON.stringify({ content: text }),
          });
          if (!res.ok) await handleResponseError(res);
          console.log(`Nota "${name}" salva.`);
          break;
        }

        case "append": {
          const name = positional[2];
          if (!name) {
            console.error('Erro: Nome da nota é obrigatório. Uso: sinapse note append <nome> "<texto>" (ou "-" para ler do stdin)');
            process.exit(1);
          }
          const text = await noteText(positional, "append");
          const ws = await resolveWorkspace(flags);
          const res = await apiRequest(routes.noteAppend(ws.id, name), {
            method: "POST",
            headers: authorHeaders(),
            body: JSON.stringify({ content: text }),
          });
          if (!res.ok) await handleResponseError(res);
          console.log(`Nota "${name}" atualizada.`);
          break;
        }

        case "rm": {
          const name = positional[2];
          if (!name) {
            console.error("Erro: Nome da nota é obrigatório. Uso: sinapse note rm <nome>");
            process.exit(1);
          }
          const ws = await resolveWorkspace(flags);
          const res = await apiRequest(routes.note(ws.id, name), {
            method: "DELETE",
          });
          if (!res.ok) await handleResponseError(res);
          console.log(`Nota "${name}" removida.`);
          break;
        }

        default:
          console.error(`Subcomando desconhecido: "${subCommand}". Use list, read, write, append ou rm.`);
          process.exit(1);
      }
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
