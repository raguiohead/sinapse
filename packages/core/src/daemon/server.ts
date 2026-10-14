import Fastify, { type FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { findCliBinDir, sinapseDir } from "../paths.js";
import { agentEnv, killTree, sweepEnvMarker, TURN_MARKER } from "../process.js";
import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  AgentState,
  Author,
  Autonomy,
  DaemonEvent,
  DaemonState,
  ModelCatalog,
  ModelOption,
  Note,
  NoteSummary,
  OrchestratorConfig,
  Provider,
  TurnEvent,
  TurnResult,
  Workspace,
} from "../types.js";
import { AUTHOR_HEADER, ENV, USER_AUTHOR } from "../routes.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { AgyAdapter } from "../adapters/agy.js";
import { estimateContextWindow } from "../context.js";

const WS_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NOTE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;
const AUTHOR_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function getSinapseDir(): string {
  return sinapseDir();
}

function getStateFile(): string {
  return path.join(getSinapseDir(), "state.json");
}

function getDaemonFile(): string {
  return path.join(getSinapseDir(), "daemon.json");
}

function getWorkspacesDir(): string {
  return path.join(getSinapseDir(), "workspaces");
}

function getWorkspaceDir(id: string): string {
  if (!WS_ID_REGEX.test(id)) {
    throw new Error(`ID de workspace inválido: ${id}`);
  }
  return path.join(getWorkspacesDir(), id);
}

function getWorkspaceNotesDir(id: string): string {
  return path.join(getWorkspaceDir(id), "notes");
}

function validateModel(input: unknown): { valid: true; model?: string } | { valid: false } {
  if (input === undefined || input === null) {
    return { valid: true, model: undefined };
  }
  if (typeof input !== "string") {
    return { valid: false };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { valid: true, model: undefined };
  }
  if (!MODEL_REGEX.test(trimmed)) {
    return { valid: false };
  }
  return { valid: true, model: trimmed };
}

function isValidNoteName(name: string): boolean {
  return NOTE_NAME_REGEX.test(name);
}

function extractTitle(name: string, content: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("# ")) {
      const heading = line.slice(2).trim();
      if (heading) return heading;
    }
  }
  return name;
}

function slugifyWorkspaceName(name: string): string {
  let slug = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  slug = slug.replace(/[^a-z0-9]+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  if (slug.length > 40) {
    slug = slug.slice(0, 40).replace(/-+$/, "");
  }
  return slug;
}

function generateWorkspaceId(name: string, existingIds: Set<string>): string {
  let base = slugifyWorkspaceName(name);
  if (!base) {
    base = `ws-${nanoid(6).toLowerCase()}`;
  }
  if (!existingIds.has(base)) return base;
  let counter = 2;
  while (existingIds.has(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}

function getAuthor(request: FastifyRequest): Author {
  const header = request.headers[AUTHOR_HEADER];
  if (typeof header === "string") {
    const trimmed = header.trim();
    if (AUTHOR_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return USER_AUTHOR;
}

interface NoteMetaEntry {
  createdBy?: Author;
  contributors: Author[];
}
type NotesMeta = Record<string, NoteMetaEntry>;

const notesMetaCache = new Map<string, NotesMeta>();
const metaSaveQueues = new Map<string, Promise<void>>();

async function readNotesMeta(workspaceId: string): Promise<NotesMeta> {
  const metaPath = path.join(getWorkspaceNotesDir(workspaceId), ".meta.json");
  try {
    const content = await fs.readFile(metaPath, "utf-8");
    const parsed = JSON.parse(content);
    notesMetaCache.set(workspaceId, parsed);
    return parsed;
  } catch {
    return {};
  }
}

async function getNotesMeta(workspaceId: string): Promise<NotesMeta> {
  let meta = notesMetaCache.get(workspaceId);
  if (!meta) {
    meta = await readNotesMeta(workspaceId);
    notesMetaCache.set(workspaceId, meta);
  }
  return meta;
}

function saveNotesMeta(workspaceId: string, meta: NotesMeta): Promise<void> {
  notesMetaCache.set(workspaceId, meta);
  const prev = metaSaveQueues.get(workspaceId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const notesDir = getWorkspaceNotesDir(workspaceId);
    await fs.mkdir(notesDir, { recursive: true, mode: 0o700 });
    const metaPath = path.join(notesDir, ".meta.json");
    const tmpPath = path.join(notesDir, `.meta.json.${process.pid}.${nanoid(4)}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, metaPath);
  });
  metaSaveQueues.set(workspaceId, next);
  return next;
}

async function writeNoteAtomic(
  workspaceId: string,
  name: string,
  content: string
): Promise<{ stat: fsSync.Stats; title: string }> {
  const notesDir = getWorkspaceNotesDir(workspaceId);
  await fs.mkdir(notesDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(notesDir, `${name}.md`);
  const tmpPath = path.join(notesDir, `${name}.md.${process.pid}.${nanoid(4)}.tmp`);
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
  const stat = await fs.stat(filePath);
  return {
    stat,
    title: extractTitle(name, content),
  };
}

const CLAUDE_MODELS: ModelOption[] = [
  { id: "fable", label: "Fable (mais recente)" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const FALLBACK_AGY_MODELS: ModelOption[] = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
];

let cachedAgyModels: ModelOption[] | null = null;
let agyModelsCachedAt = 0;
const AGY_MODELS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchAgyModels(): Promise<ModelOption[]> {
  const now = Date.now();
  if (cachedAgyModels && now - agyModelsCachedAt < AGY_MODELS_CACHE_TTL) {
    return cachedAgyModels;
  }

  const marker = randomUUID();
  try {
    const models = await new Promise<ModelOption[]>((resolve, reject) => {
      const child = spawn("agy", ["models"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: agentEnv({ [TURN_MARKER]: marker }),
      });

      let stdout = "";
      const timer = setTimeout(() => {
        if (child.pid) killTree(child.pid);
        reject(new Error("Timeout fetching agy models"));
      }, 15000);

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`agy models exited with code ${code}`));
          return;
        }

        const lines = stdout.split(/\r?\n/);
        const parsed: ModelOption[] = [];
        for (const line of lines) {
          const tabIndex = line.indexOf("\t");
          if (tabIndex > 0) {
            const id = line.slice(0, tabIndex).trim();
            const label = line.slice(tabIndex + 1).trim();
            if (id && label) {
              parsed.push({ id, label });
            }
          }
        }

        if (parsed.length > 0) {
          resolve(parsed);
        } else {
          reject(new Error("No models parsed from agy models"));
        }
      });
    });

    cachedAgyModels = models;
    agyModelsCachedAt = now;
    return models;
  } catch {
    return FALLBACK_AGY_MODELS;
  } finally {
    sweepEnvMarker(TURN_MARKER, marker);
  }
}

function setupNotesWatcher(): () => void {
  const workspacesDir = getWorkspacesDir();
  try {
    const debounceTimers = new Map<string, NodeJS.Timeout>();

    const watcher = fsSync.watch(workspacesDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const fileStr = String(filename).replace(/\\/g, "/");
      const parts = fileStr.split("/");
      if (parts.length !== 3) return;
      const [wsId, notesFolder, file] = parts;
      if (notesFolder !== "notes") return;
      if (file.endsWith(".tmp") || file === ".meta.json" || file.includes(".tmp.")) return;
      if (!file.endsWith(".md")) return;

      const name = file.slice(0, -3);
      if (!WS_ID_REGEX.test(wsId) || !isValidNoteName(name)) return;

      const key = `${wsId}:${name}`;
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        debounceTimers.delete(key);
        try {
          const filePath = path.join(workspacesDir, wsId, "notes", `${name}.md`);
          const stat = await fs.stat(filePath);
          const content = await fs.readFile(filePath, "utf-8");
          const meta = await readNotesMeta(wsId);
          const metaEntry = meta[name];
          const summary: NoteSummary = {
            workspaceId: wsId,
            name,
            title: extractTitle(name, content),
            updatedAt: stat.mtimeMs,
            createdBy: metaEntry?.createdBy,
            contributors: metaEntry?.contributors ?? [],
          };
          broadcast({ kind: "note_changed", workspaceId: wsId, note: summary });
        } catch (err: any) {
          if (err?.code === "ENOENT") {
            broadcast({ kind: "note_deleted", workspaceId: wsId, name });
          }
        }
      }, 150);

      debounceTimers.set(key, timer);
    });

    watcher.on("error", () => {});
    return () => watcher.close();
  } catch {
    return () => {};
  }
}

interface ActiveTurnSession {
  turnId: string;
  adapter: ClaudeAdapter | AgyAdapter;
  events: TurnEvent[];
  stopped: boolean;
}

const state: DaemonState = {
  workspaces: {},
  agents: {},
  port: 0,
  token: "",
};

const activeTurns = new Map<string, ActiveTurnSession>();
const agentRecentEvents = new Map<string, TurnEvent[]>();
const subscribers = new Set<(event: DaemonEvent) => void>();

function broadcast(event: DaemonEvent): void {
  for (const send of subscribers) send(event);
}

function findWorkspace(idOrName: string): Workspace | undefined {
  if (state.workspaces[idOrName]) {
    return state.workspaces[idOrName];
  }
  const lower = idOrName.toLowerCase();
  return Object.values(state.workspaces).find((w) => w.name.toLowerCase() === lower);
}

function findAgentInWorkspace(ws: Workspace, idOrName: string): AgentState | undefined {
  return Object.values(state.agents).find(
    (a) => a.workspaceId === ws.id && (a.id === idOrName || a.name === idOrName)
  );
}

async function loadSavedState(): Promise<{
  workspaces: Record<string, Workspace>;
  agents: Record<string, AgentState>;
  token?: string;
}> {
  await fs.mkdir(getSinapseDir(), { recursive: true, mode: 0o700 });
  let content: string;
  try {
    content = await fs.readFile(getStateFile(), "utf-8");
  } catch {
    return { workspaces: {}, agents: {} };
  }
  try {
    const data = JSON.parse(content);
    const workspaces = data.workspaces ?? {};
    const agents = data.agents ?? {};
    for (const agent of Object.values(agents) as AgentState[]) {
      if (agent.status === "thinking") {
        agent.status = "interrupted";
        agent.currentTurnId = undefined;
      }
    }
    return { workspaces, agents, token: data.token };
  } catch {
    const backup = `${getStateFile()}.corrupt-${Date.now()}`;
    await fs.copyFile(getStateFile(), backup).catch(() => {});
    console.error(`state.json ilegível; cópia salva em ${backup}`);
    return { workspaces: {}, agents: {} };
  }
}

async function runMigration(): Promise<void> {
  let changed = false;
  if (!state.workspaces || Object.keys(state.workspaces).length === 0) {
    state.workspaces = {
      geral: {
        id: "geral",
        name: "Geral",
        folder: os.homedir(),
        orchestrator: { provider: "claude" },
        createdAt: Date.now(),
      },
    };
    changed = true;
  }

  for (const agent of Object.values(state.agents)) {
    if (!agent.workspaceId) {
      agent.workspaceId = "geral";
      changed = true;
    }
  }

  const legacyNotesDir = path.join(getSinapseDir(), "notes");
  const geralNotesDir = path.join(getSinapseDir(), "workspaces", "geral", "notes");

  try {
    const legacyStat = await fs.stat(legacyNotesDir);
    if (legacyStat.isDirectory()) {
      const geralExists = await fs.stat(geralNotesDir).then(() => true).catch(() => false);
      if (!geralExists) {
        await fs.mkdir(path.dirname(geralNotesDir), { recursive: true, mode: 0o700 });
        await fs.rename(legacyNotesDir, geralNotesDir);
      } else {
        const files = await fs.readdir(legacyNotesDir);
        for (const file of files) {
          const src = path.join(legacyNotesDir, file);
          const dst = path.join(geralNotesDir, file);
          const dstExists = await fs.stat(dst).then(() => true).catch(() => false);
          if (!dstExists) {
            await fs.rename(src, dst);
          }
        }
        const remaining = await fs.readdir(legacyNotesDir);
        if (remaining.length === 0) {
          await fs.rmdir(legacyNotesDir);
        }
      }
    }
  } catch {}

  for (const ws of Object.values(state.workspaces)) {
    await fs.mkdir(path.join(getSinapseDir(), "workspaces", ws.id, "notes"), { recursive: true, mode: 0o700 });
  }

  if (changed) {
    await saveState();
  }
}

async function writePrivate(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${nanoid(4)}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

let saveQueue: Promise<void> = Promise.resolve();
function saveState(): Promise<void> {
  saveQueue = saveQueue.catch(() => {}).then(writeState);
  return saveQueue;
}

async function writeState(): Promise<void> {
  await writePrivate(
    getStateFile(),
    JSON.stringify(
      {
        workspaces: state.workspaces,
        agents: state.agents,
        port: state.port,
        token: state.token,
      },
      null,
      2
    )
  );
}

async function writeDaemonFile(port: number, token: string): Promise<void> {
  await writePrivate(getDaemonFile(), JSON.stringify({ port, token, pid: process.pid }, null, 2));
}

function createAdapter(provider: Provider): ClaudeAdapter | AgyAdapter {
  switch (provider) {
    case "claude":
      return new ClaudeAdapter();
    case "agy":
      return new AgyAdapter();
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function executeTurn(
  agent: AgentState,
  turnId: string,
  prompt: string,
  session: ActiveTurnSession,
  onEvent?: (event: TurnEvent) => void
): Promise<void> {
  const adapter = session.adapter;
  let turnResult: TurnResult | undefined;

  try {
    const gen = adapter.runTurn({
      prompt,
      cwd: agent.cwd,
      sessionId: agent.sessionId,
      autonomy: agent.autonomy,
      model: agent.model,
      env: {
        [ENV.workspace]: agent.workspaceId,
        [ENV.agentId]: agent.id,
      },
    });

    let iter = await gen.next();
    while (!iter.done) {
      if (session.stopped) {
        await gen.return(null as any);
        break;
      }
      const event = iter.value;
      session.events.push(event);
      if (onEvent) {
        onEvent(event);
      }
      broadcast({
        kind: "turn_event",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        agentName: agent.name,
        turnId,
        event,
      });
      iter = await gen.next();
    }

    turnResult = iter.value as TurnResult | undefined;

    if (!session.stopped) {
      agent.status = "done";
      if (turnResult?.sessionId) {
        agent.sessionId = turnResult.sessionId;
      }
      if (turnResult?.usage) {
        agent.usage = turnResult.usage;
      }
      agent.lastError = undefined;
    }
  } catch (err: any) {
    if (!session.stopped) {
      agent.status = "error";
      agent.lastError = err?.message || String(err);
      const errorEvent: TurnEvent = {
        type: "error",
        timestamp: Date.now(),
        data: agent.lastError ?? "Unknown error",
      };
      session.events.push(errorEvent);
      if (onEvent) {
        onEvent(errorEvent);
      }
    }
  } finally {
    agent.currentTurnId = undefined;
    agentRecentEvents.set(agent.id, [...session.events]);
    activeTurns.delete(agent.id);
    broadcast({
      kind: "turn_finished",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      agentName: agent.name,
      turnId,
      status: session.stopped ? "interrupted" : agent.status,
      text: turnResult?.text,
      error: agent.lastError,
      usage: turnResult?.usage,
    });
    await saveState();
  }
}

export async function start(
  options: { handleSignals?: boolean } = {}
): Promise<{ port: number; token: string }> {
  const cliBin = findCliBinDir();
  const currentPath = process.env.PATH ?? "";
  if (cliBin && !currentPath.split(path.delimiter).includes(cliBin)) {
    process.env.PATH = cliBin + path.delimiter + currentPath;
  }

  const loaded = await loadSavedState();
  state.workspaces = loaded.workspaces;
  state.agents = loaded.agents;
  state.token = loaded.token || nanoid();

  await runMigration();

  const fastify = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, forceCloseConnections: true });

  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const str = typeof body === "string" ? body : body.toString("utf-8");
      if (!str.trim()) {
        done(null, {});
        return;
      }
      try {
        const json = JSON.parse(str);
        done(null, json);
      } catch (err: any) {
        done(err, undefined);
      }
    }
  );

  fastify.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }
    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${state.token}`) {
      reply.status(401).send({ error: "Unauthorized" });
    }
  });

  fastify.get("/health", async () => {
    return { ok: true };
  });

  fastify.get("/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");

    const send = (event: DaemonEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    subscribers.add(send);

    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      subscribers.delete(send);
    });
  });

  fastify.get("/models", async (): Promise<ModelCatalog> => {
    const agy = await fetchAgyModels();
    return {
      claude: CLAUDE_MODELS,
      agy,
    };
  });

  // Workspaces routes
  fastify.get("/workspaces", async () => {
    return Object.values(state.workspaces);
  });

  fastify.post("/workspaces", async (request, reply) => {
    const body = request.body as {
      name?: unknown;
      folder?: unknown;
      orchestrator?: { provider?: unknown; model?: unknown };
    } | undefined;

    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return reply.status(400).send({ error: "Nome do workspace é obrigatório" });
    }
    const name = body.name.trim();
    if (name.length < 1 || name.length > 60) {
      return reply.status(400).send({ error: "Nome do workspace deve ter entre 1 e 60 caracteres" });
    }

    const nameLower = name.toLowerCase();
    const existing = Object.values(state.workspaces).find((w) => w.name.toLowerCase() === nameLower);
    if (existing) {
      return reply.status(409).send({ error: `Workspace com o nome "${name}" já existe` });
    }

    if (typeof body.folder !== "string" || !body.folder.trim()) {
      return reply.status(400).send({ error: "Pasta do workspace é obrigatória" });
    }
    const folder = path.resolve(body.folder.trim());
    try {
      const st = await fs.stat(folder);
      if (!st.isDirectory()) {
        return reply.status(400).send({ error: "Caminho informado não é um diretório" });
      }
    } catch {
      return reply.status(400).send({ error: "Pasta informada não existe" });
    }

    if (!body.orchestrator || typeof body.orchestrator !== "object") {
      return reply.status(400).send({ error: "Configuração do orquestrador é obrigatória" });
    }
    const provider = body.orchestrator.provider;
    if (provider !== "claude" && provider !== "agy") {
      return reply.status(400).send({ error: "Provedor do orquestrador inválido (use claude ou agy)" });
    }

    const modelVal = validateModel(body.orchestrator.model);
    if (!modelVal.valid) {
      return reply.status(400).send({ error: "Modelo do orquestrador inválido" });
    }

    const existingIds = new Set(Object.keys(state.workspaces));
    const id = generateWorkspaceId(name, existingIds);

    const workspace: Workspace = {
      id,
      name,
      folder,
      orchestrator: {
        provider,
        ...(modelVal.model ? { model: modelVal.model } : {}),
      },
      createdAt: Date.now(),
    };

    await fs.mkdir(getWorkspaceNotesDir(id), { recursive: true, mode: 0o700 });
    state.workspaces[id] = workspace;
    await saveState();
    broadcast({ kind: "workspace_created", workspace });

    return reply.status(201).send(workspace);
  });

  fastify.patch("/workspaces/:ws", async (request, reply) => {
    const { ws: wsParam } = request.params as { ws: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }

    const body = request.body as Record<string, any> | undefined;
    if (!body || typeof body !== "object") {
      return reply.status(400).send({ error: "Corpo da requisição inválido" });
    }

    if ("folder" in body) {
      return reply.status(400).send({ error: "Pasta do workspace é imutável" });
    }

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return reply.status(400).send({ error: "Nome do workspace deve ser uma string não vazia" });
      }
      const name = body.name.trim();
      if (name.length < 1 || name.length > 60) {
        return reply.status(400).send({ error: "Nome do workspace deve ter entre 1 e 60 caracteres" });
      }
      const nameLower = name.toLowerCase();
      const existing = Object.values(state.workspaces).find(
        (w) => w.id !== ws.id && w.name.toLowerCase() === nameLower
      );
      if (existing) {
        return reply.status(409).send({ error: `Workspace com o nome "${name}" já existe` });
      }
      ws.name = name;
    }

    if (body.orchestrator !== undefined) {
      if (!body.orchestrator || typeof body.orchestrator !== "object") {
        return reply.status(400).send({ error: "Configuração do orquestrador inválida" });
      }
      const provider = body.orchestrator.provider ?? ws.orchestrator.provider;
      if (provider !== "claude" && provider !== "agy") {
        return reply.status(400).send({ error: "Provedor do orquestrador inválido (use claude ou agy)" });
      }

      if ("model" in body.orchestrator) {
        const modelVal = validateModel(body.orchestrator.model);
        if (!modelVal.valid) {
          return reply.status(400).send({ error: "Modelo do orquestrador inválido" });
        }
        ws.orchestrator = {
          provider,
          ...(modelVal.model ? { model: modelVal.model } : {}),
        };
      } else {
        ws.orchestrator.provider = provider;
      }
    }

    await saveState();
    broadcast({ kind: "workspace_updated", workspace: ws });
    return ws;
  });

  fastify.delete("/workspaces/:ws", async (request, reply) => {
    const { ws: wsParam } = request.params as { ws: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }

    if (Object.keys(state.workspaces).length <= 1) {
      return reply.status(409).send({ error: "Não é possível apagar o último workspace" });
    }

    const wsAgents = Object.values(state.agents).filter((a) => a.workspaceId === ws.id);
    for (const a of wsAgents) {
      const session = activeTurns.get(a.id);
      if (session) {
        session.stopped = true;
        try {
          await session.adapter.stop(0);
        } catch {}
        activeTurns.delete(a.id);
      }
      delete state.agents[a.id];
      agentRecentEvents.delete(a.id);
      broadcast({ kind: "agent_deleted", workspaceId: ws.id, agentId: a.id, agentName: a.name });
    }

    delete state.workspaces[ws.id];
    notesMetaCache.delete(ws.id);
    metaSaveQueues.delete(ws.id);

    // The id comes from state.json; re-validate it so a tampered file can't point rm outside workspaces/.
    if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(ws.id)) {
      try {
        await fs.rm(path.join(getSinapseDir(), "workspaces", ws.id), { recursive: true, force: true });
      } catch {}
    }

    await saveState();
    broadcast({ kind: "workspace_deleted", workspaceId: ws.id });

    return { ok: true };
  });

  // Agents routes under workspace
  fastify.get("/workspaces/:ws/agents", async (request, reply) => {
    const { ws: wsParam } = request.params as { ws: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    return Object.values(state.agents).filter((a) => a.workspaceId === ws.id);
  });

  fastify.post("/workspaces/:ws/agents", async (request, reply) => {
    const { ws: wsParam } = request.params as { ws: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }

    const body = request.body as Partial<AgentConfig> | undefined;
    if (
      !body ||
      !body.name ||
      !body.provider ||
      !body.role ||
      !body.autonomy
    ) {
      return reply.status(400).send({
        error: "Missing required fields: name, provider, role, autonomy",
      });
    }

    if (body.provider !== "claude" && body.provider !== "agy" && body.provider !== "codex") {
      return reply.status(400).send({ error: `Invalid provider: ${body.provider}` });
    }

    const modelVal = validateModel(body.model);
    if (!modelVal.valid) {
      return reply.status(400).send({ error: "Invalid model format" });
    }

    const existing = Object.values(state.agents).find(
      (a) => a.workspaceId === ws.id && a.name === body.name
    );
    if (existing) {
      return reply.status(409).send({
        error: `Agent with name "${body.name}" already exists in workspace "${ws.name}"`,
      });
    }

    const cwd = body.cwd && typeof body.cwd === "string" && body.cwd.trim()
      ? path.resolve(body.cwd.trim())
      : ws.folder;

    const author = getAuthor(request);
    const agentId = nanoid(8);
    const newAgent: AgentState = {
      id: agentId,
      workspaceId: ws.id,
      name: body.name,
      provider: body.provider,
      cwd,
      role: body.role,
      autonomy: body.autonomy,
      status: "idle",
      createdBy: author,
      ...(modelVal.model ? { model: modelVal.model } : {}),
    };

    state.agents[agentId] = newAgent;
    await saveState();
    broadcast({ kind: "agent_spawned", workspaceId: ws.id, agent: newAgent });

    return reply.status(201).send(newAgent);
  });

  fastify.patch("/workspaces/:ws/agents/:agent", async (request, reply) => {
    const { ws: wsParam, agent: agentParam } = request.params as { ws: string; agent: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    const agent = findAgentInWorkspace(ws, agentParam);
    if (!agent) {
      return reply.status(404).send({ error: "Worker não encontrado" });
    }

    if (agent.status === "thinking") {
      return reply.status(409).send({ error: "Agent is currently busy (status is thinking)" });
    }

    const body = request.body as {
      model?: string | null;
      role?: string;
      autonomy?: Autonomy;
    } | undefined;

    if (!body || typeof body !== "object") {
      return reply.status(400).send({ error: "Invalid request body" });
    }

    if (body.role !== undefined) {
      if (typeof body.role !== "string" || !body.role.trim()) {
        return reply.status(400).send({ error: "Role must be a non-empty string" });
      }
      agent.role = body.role.trim();
    }

    if (body.autonomy !== undefined) {
      if (body.autonomy !== "read" && body.autonomy !== "edit" && body.autonomy !== "full") {
        return reply.status(400).send({ error: `Invalid autonomy: ${body.autonomy}` });
      }
      agent.autonomy = body.autonomy;
    }

    if ("model" in body) {
      if (body.model === null || (typeof body.model === "string" && body.model.trim() === "")) {
        delete agent.model;
        if (agent.usage) {
          delete agent.usage.model;
        }
      } else {
        const modelVal = validateModel(body.model);
        if (!modelVal.valid || !modelVal.model) {
          return reply.status(400).send({ error: "Invalid model format" });
        }
        agent.model = modelVal.model;
        if (agent.usage) {
          agent.usage.model = agent.model;
          if (agent.usage.windowEstimated) {
            agent.usage.windowTokens = estimateContextWindow(agent.model);
          }
        }
      }
    }

    await saveState();
    broadcast({ kind: "agent_updated", workspaceId: ws.id, agent });
    return agent;
  });

  fastify.post("/workspaces/:ws/agents/:agent/ask", async (request, reply) => {
    const { ws: wsParam, agent: agentParam } = request.params as { ws: string; agent: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    const agent = findAgentInWorkspace(ws, agentParam);
    if (!agent) {
      return reply.status(404).send({ error: "Worker não encontrado" });
    }

    const body = request.body as { prompt?: string; async?: boolean } | undefined;
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return reply.status(400).send({ error: "Prompt is required" });
    }

    if (agent.status === "thinking") {
      return reply.status(409).send({ error: "Agent is currently busy (queue limit of 1)" });
    }

    let adapter: ClaudeAdapter | AgyAdapter;
    try {
      adapter = createAdapter(agent.provider);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }

    const turnId = nanoid();
    agent.status = "thinking";
    agent.currentTurnId = turnId;
    agent.lastError = undefined;
    await saveState();

    const session: ActiveTurnSession = {
      turnId,
      adapter,
      events: [],
      stopped: false,
    };
    activeTurns.set(agent.id, session);
    broadcast({
      kind: "turn_started",
      workspaceId: ws.id,
      agentId: agent.id,
      agentName: agent.name,
      turnId,
      prompt: body.prompt,
    });

    if (body.async) {
      executeTurn(agent, turnId, body.prompt, session).catch(console.error);
      return reply.status(202).send({ turnId });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const onEvent = (event: TurnEvent) => {
      reply.raw.write(JSON.stringify(event) + "\n");
    };

    await executeTurn(agent, turnId, body.prompt, session, onEvent);
    reply.raw.end();
  });

  fastify.get("/workspaces/:ws/agents/:agent/check", async (request, reply) => {
    const { ws: wsParam, agent: agentParam } = request.params as { ws: string; agent: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    const agent = findAgentInWorkspace(ws, agentParam);
    if (!agent) {
      return reply.status(404).send({ error: "Worker não encontrado" });
    }

    const session = activeTurns.get(agent.id);
    const events = session ? session.events : agentRecentEvents.get(agent.id) ?? [];

    return {
      agentId: agent.id,
      name: agent.name,
      status: agent.status,
      model: agent.model,
      usage: agent.usage,
      turnId: agent.currentTurnId,
      events,
      lastError: agent.lastError,
    };
  });

  fastify.post("/workspaces/:ws/agents/:agent/stop", async (request, reply) => {
    const { ws: wsParam, agent: agentParam } = request.params as { ws: string; agent: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    const agent = findAgentInWorkspace(ws, agentParam);
    if (!agent) {
      return reply.status(404).send({ error: "Worker não encontrado" });
    }

    const session = activeTurns.get(agent.id);
    if (session) {
      session.stopped = true;
      try {
        await session.adapter.stop(0);
      } catch {}
      agentRecentEvents.set(agent.id, [...session.events]);
      activeTurns.delete(agent.id);
    }

    agent.status = "interrupted";
    agent.currentTurnId = undefined;
    await saveState();

    return { ok: true, status: agent.status };
  });

  fastify.delete("/workspaces/:ws/agents/:agent", async (request, reply) => {
    const { ws: wsParam, agent: agentParam } = request.params as { ws: string; agent: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    const agent = findAgentInWorkspace(ws, agentParam);
    if (!agent) {
      return reply.status(404).send({ error: "Worker não encontrado" });
    }

    const session = activeTurns.get(agent.id);
    if (session) {
      session.stopped = true;
      try {
        await session.adapter.stop(0);
      } catch {}
      activeTurns.delete(agent.id);
    }

    delete state.agents[agent.id];
    agentRecentEvents.delete(agent.id);
    await saveState();
    broadcast({ kind: "agent_deleted", workspaceId: ws.id, agentId: agent.id, agentName: agent.name });

    return { ok: true };
  });

  // Notes routes under workspace
  fastify.get("/workspaces/:ws/notes", async (request, reply): Promise<NoteSummary[]> => {
    const { ws: wsParam } = request.params as { ws: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      reply.status(404).send({ error: "Workspace não encontrado" });
      return [];
    }
    const notesDir = getWorkspaceNotesDir(ws.id);
    const meta = await getNotesMeta(ws.id);
    try {
      const entries = await fs.readdir(notesDir, { withFileTypes: true });
      const summaries: NoteSummary[] = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const name = entry.name.slice(0, -3);
          if (isValidNoteName(name)) {
            const filePath = path.join(notesDir, entry.name);
            try {
              const stat = await fs.stat(filePath);
              const content = await fs.readFile(filePath, "utf-8");
              const metaEntry = meta[name];
              summaries.push({
                workspaceId: ws.id,
                name,
                title: extractTitle(name, content),
                updatedAt: stat.mtimeMs,
                createdBy: metaEntry?.createdBy,
                contributors: metaEntry?.contributors ?? [],
              });
            } catch {}
          }
        }
      }
      summaries.sort((a, b) => b.updatedAt - a.updatedAt);
      return summaries;
    } catch {
      return [];
    }
  });

  fastify.get("/workspaces/:ws/notes/:name", async (request, reply) => {
    const { ws: wsParam, name } = request.params as { ws: string; name: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Nome da nota inválido" });
    }
    const filePath = path.join(getWorkspaceNotesDir(ws.id), `${name}.md`);
    try {
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, "utf-8");
      const meta = await getNotesMeta(ws.id);
      const metaEntry = meta[name];
      const note: Note = {
        workspaceId: ws.id,
        name,
        title: extractTitle(name, content),
        updatedAt: stat.mtimeMs,
        createdBy: metaEntry?.createdBy,
        contributors: metaEntry?.contributors ?? [],
        content,
      };
      return note;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return reply.status(404).send({ error: "Nota não encontrada" });
      }
      throw err;
    }
  });

  fastify.put("/workspaces/:ws/notes/:name", async (request, reply) => {
    const { ws: wsParam, name } = request.params as { ws: string; name: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Nome da nota inválido" });
    }
    const body = request.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.status(400).send({ error: "Conteúdo é obrigatório" });
    }
    if (Buffer.byteLength(body.content, "utf-8") > 1024 * 1024) {
      return reply.status(413).send({ error: "Conteúdo excede o limite de 1 MB" });
    }

    const filePath = path.join(getWorkspaceNotesDir(ws.id), `${name}.md`);
    let exists = false;
    try {
      await fs.stat(filePath);
      exists = true;
    } catch {}

    const author = getAuthor(request);
    const { stat, title } = await writeNoteAtomic(ws.id, name, body.content);

    const meta = await getNotesMeta(ws.id);
    if (!exists) {
      meta[name] = { createdBy: author, contributors: [] };
    } else {
      if (!meta[name]) {
        meta[name] = { contributors: [] };
      }
      if (author !== meta[name].createdBy && !meta[name].contributors.includes(author)) {
        meta[name].contributors.push(author);
      }
    }
    await saveNotesMeta(ws.id, meta);

    const summary: NoteSummary = {
      workspaceId: ws.id,
      name,
      title,
      updatedAt: stat.mtimeMs,
      createdBy: meta[name].createdBy,
      contributors: meta[name].contributors,
    };

    broadcast({ kind: "note_changed", workspaceId: ws.id, note: summary, by: author });
    return summary;
  });

  fastify.post("/workspaces/:ws/notes/:name/append", async (request, reply) => {
    const { ws: wsParam, name } = request.params as { ws: string; name: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Nome da nota inválido" });
    }
    const body = request.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.status(400).send({ error: "Conteúdo é obrigatório" });
    }

    const filePath = path.join(getWorkspaceNotesDir(ws.id), `${name}.md`);
    let combinedContent = body.content;
    let exists = false;
    try {
      const existing = await fs.readFile(filePath, "utf-8");
      exists = true;
      if (existing.length > 0) {
        const separator = existing.endsWith("\n") ? "" : "\n";
        combinedContent = `${existing}${separator}${body.content}`;
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }

    if (Buffer.byteLength(combinedContent, "utf-8") > 1024 * 1024) {
      return reply.status(413).send({ error: "Conteúdo excede o limite de 1 MB" });
    }

    const author = getAuthor(request);
    const { stat, title } = await writeNoteAtomic(ws.id, name, combinedContent);

    const meta = await getNotesMeta(ws.id);
    if (!exists) {
      meta[name] = { createdBy: author, contributors: [] };
    } else {
      if (!meta[name]) {
        meta[name] = { contributors: [] };
      }
      if (author !== meta[name].createdBy && !meta[name].contributors.includes(author)) {
        meta[name].contributors.push(author);
      }
    }
    await saveNotesMeta(ws.id, meta);

    const summary: NoteSummary = {
      workspaceId: ws.id,
      name,
      title,
      updatedAt: stat.mtimeMs,
      createdBy: meta[name].createdBy,
      contributors: meta[name].contributors,
    };

    broadcast({ kind: "note_changed", workspaceId: ws.id, note: summary, by: author });
    return summary;
  });

  fastify.delete("/workspaces/:ws/notes/:name", async (request, reply) => {
    const { ws: wsParam, name } = request.params as { ws: string; name: string };
    const ws = findWorkspace(wsParam);
    if (!ws) {
      return reply.status(404).send({ error: "Workspace não encontrado" });
    }
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Nome da nota inválido" });
    }
    const filePath = path.join(getWorkspaceNotesDir(ws.id), `${name}.md`);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return reply.status(404).send({ error: "Nota não encontrada" });
      }
      throw err;
    }

    const meta = await getNotesMeta(ws.id);
    if (meta[name]) {
      delete meta[name];
      await saveNotesMeta(ws.id, meta);
    }

    broadcast({ kind: "note_deleted", workspaceId: ws.id, name });
    return { ok: true };
  });

  await fs.mkdir(getWorkspacesDir(), { recursive: true, mode: 0o700 });
  closeWatcher = setupNotesWatcher();

  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address() as AddressInfo;
  state.port = address.port;

  await writeDaemonFile(state.port, state.token);
  await saveState();

  closeServer = () => fastify.close();

  if (options.handleSignals) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, async () => {
        await shutdown();
        process.exit(0);
      });
    }
  }

  return { port: state.port, token: state.token };
}

let closeServer: (() => Promise<void>) | null = null;
let closeWatcher: () => void = () => {};

export async function shutdown(): Promise<void> {
  for (const [agentId, session] of activeTurns) {
    session.stopped = true;
    try {
      await session.adapter.stop(0);
    } catch {}
    const agent = state.agents[agentId];
    if (agent) {
      agent.status = "interrupted";
      agent.currentTurnId = undefined;
    }
  }
  activeTurns.clear();
  try {
    closeWatcher();
  } catch {}
  try {
    await closeServer?.();
  } catch {}
  try {
    await saveState();
  } catch {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start({ handleSignals: true })
    .then(({ port }) => {
      console.log(`sinapsed running on port ${port}`);
    })
    .catch((err) => {
      console.error("Failed to start sinapsed:", err);
      process.exit(1);
    });
}
