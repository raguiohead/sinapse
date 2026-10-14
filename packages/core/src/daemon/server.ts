import Fastify from "fastify";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { findCliBinDir, sinapseDir } from "../paths.js";
import { agentEnv, killTree, sweepEnvMarker, TURN_MARKER } from "../process.js";
import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  AgentState,
  Autonomy,
  DaemonEvent,
  DaemonState,
  ModelCatalog,
  ModelOption,
  Note,
  NoteSummary,
  Provider,
  TurnEvent,
  TurnResult,
} from "../types.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { AgyAdapter } from "../adapters/agy.js";
import { estimateContextWindow } from "../context.js";

const SINAPSE_DIR = sinapseDir();
const STATE_FILE = path.join(SINAPSE_DIR, "state.json");
const DAEMON_FILE = path.join(SINAPSE_DIR, "daemon.json");
const NOTES_DIR = path.join(SINAPSE_DIR, "notes");

const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;

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

const NOTE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

async function writeNoteAtomic(name: string, content: string): Promise<NoteSummary> {
  const filePath = path.join(NOTES_DIR, `${name}.md`);
  const tmpPath = path.join(NOTES_DIR, `${name}.md.tmp`);
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
  const stat = await fs.stat(filePath);
  return {
    name,
    title: extractTitle(name, content),
    updatedAt: stat.mtimeMs,
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

  // Even `agy models` starts MCP servers that detach; tag the spawn so they can be swept afterwards.
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
  try {
    const debounceTimers = new Map<string, NodeJS.Timeout>();

    const watcher = fsSync.watch(NOTES_DIR, (_eventType, filename) => {
      if (!filename) return;
      const fileStr = String(filename);
      if (fileStr.endsWith(".tmp")) return;
      if (!fileStr.endsWith(".md")) return;

      const name = fileStr.slice(0, -3);
      if (!isValidNoteName(name)) return;

      const existing = debounceTimers.get(name);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        debounceTimers.delete(name);
        try {
          const filePath = path.join(NOTES_DIR, `${name}.md`);
          const stat = await fs.stat(filePath);
          const content = await fs.readFile(filePath, "utf-8");
          const summary: NoteSummary = {
            name,
            title: extractTitle(name, content),
            updatedAt: stat.mtimeMs,
          };
          broadcast({ kind: "note_changed", note: summary });
        } catch (err: any) {
          if (err?.code === "ENOENT") {
            broadcast({ kind: "note_deleted", name });
          }
        }
      }, 150);

      debounceTimers.set(name, timer);
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

async function loadSavedState(): Promise<{ agents: Record<string, AgentState>; token?: string }> {
  await fs.mkdir(SINAPSE_DIR, { recursive: true });
  let content: string;
  try {
    content = await fs.readFile(STATE_FILE, "utf-8");
  } catch {
    return { agents: {} };
  }
  try {
    const data = JSON.parse(content);
    const agents = data.agents ?? {};
    for (const agent of Object.values(agents) as AgentState[]) {
      if (agent.status === "thinking") {
        agent.status = "interrupted";
        agent.currentTurnId = undefined;
      }
    }
    return { agents, token: data.token };
  } catch {
    // Never start empty over an unreadable file: the next save would erase every agent. Keep a copy instead.
    const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
    await fs.copyFile(STATE_FILE, backup).catch(() => {});
    console.error(`state.json ilegível; cópia salva em ${backup}`);
    return { agents: {} };
  }
}

// Both files hold the daemon token, so keep them owner-only (chmod also fixes files created before this).
// Write to a temp file and rename: a crash or a concurrent write can never leave a half-written file.
async function writePrivate(file: string, content: string): Promise<void> {
  await fs.mkdir(SINAPSE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

// Saves run one at a time, each writing the latest state.
let saveQueue: Promise<void> = Promise.resolve();
function saveState(): Promise<void> {
  saveQueue = saveQueue.catch(() => {}).then(writeState);
  return saveQueue;
}

async function writeState(): Promise<void> {
  await writePrivate(
    STATE_FILE,
    JSON.stringify(
      {
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
  await writePrivate(DAEMON_FILE, JSON.stringify({ port, token, pid: process.pid }, null, 2));
}

function findAgent(idOrName: string): AgentState | undefined {
  if (state.agents[idOrName]) {
    return state.agents[idOrName];
  }
  return Object.values(state.agents).find((a) => a.name === idOrName);
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
      broadcast({ kind: "turn_event", agentId: agent.id, agentName: agent.name, turnId, event });
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

/** handleSignals: only for a standalone daemon process; an embedding app (Electron) owns its own signals and calls shutdown(). */
export async function start(
  options: { handleSignals?: boolean } = {}
): Promise<{ port: number; token: string }> {
  // Workers inherit this env; they need the `sinapse` CLI to read and write notes.
  const cliBin = findCliBinDir();
  const currentPath = process.env.PATH ?? "";
  if (cliBin && !currentPath.split(path.delimiter).includes(cliBin)) {
    process.env.PATH = cliBin + path.delimiter + currentPath;
  }

  const loaded = await loadSavedState();
  state.agents = loaded.agents;
  state.token = loaded.token || nanoid();

  // forceCloseConnections: the SSE streams never end on their own, so close() would wait forever without it.
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

  fastify.get("/agents", async () => {
    return Object.values(state.agents);
  });

  fastify.post("/agents", async (request, reply) => {
    const body = request.body as Partial<AgentConfig> | undefined;
    if (
      !body ||
      !body.name ||
      !body.provider ||
      !body.cwd ||
      !body.role ||
      !body.autonomy
    ) {
      return reply.status(400).send({
        error: "Missing required fields: name, provider, cwd, role, autonomy",
      });
    }

    if (body.provider !== "claude" && body.provider !== "agy" && body.provider !== "codex") {
      return reply.status(400).send({ error: `Invalid provider: ${body.provider}` });
    }

    const modelVal = validateModel(body.model);
    if (!modelVal.valid) {
      return reply.status(400).send({ error: "Invalid model format" });
    }

    const existing = Object.values(state.agents).find((a) => a.name === body.name);
    if (existing) {
      return reply.status(409).send({
        error: `Agent with name "${body.name}" already exists`,
      });
    }

    const agentId = nanoid(8);
    const newAgent: AgentState = {
      id: agentId,
      name: body.name,
      provider: body.provider,
      cwd: body.cwd,
      role: body.role,
      autonomy: body.autonomy,
      status: "idle",
      ...(modelVal.model ? { model: modelVal.model } : {}),
    };

    state.agents[agentId] = newAgent;
    await saveState();
    broadcast({ kind: "agent_spawned", agent: newAgent });

    return reply.status(201).send(newAgent);
  });

  fastify.patch("/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = findAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
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
    broadcast({ kind: "agent_updated", agent });
    return agent;
  });

  fastify.post("/agents/:id/ask", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { prompt?: string; async?: boolean } | undefined;

    if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return reply.status(400).send({ error: "Prompt is required" });
    }

    const agent = findAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
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
      agentId: agent.id,
      agentName: agent.name,
      turnId,
      prompt: body.prompt,
    });

    if (body.async) {
      // Async: respond with turnId immediately, run in background
      executeTurn(agent, turnId, body.prompt, session).catch(console.error);
      return reply.status(202).send({ turnId });
    }

    // Sync: stream NDJSON events back
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

  fastify.get("/agents/:id/check", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = findAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
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

  fastify.post("/agents/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = findAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
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

  fastify.delete("/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = findAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }

    // A running turn is stopped first so its CLI and everything it started die with the agent.
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
    broadcast({ kind: "agent_deleted", agentId: agent.id, agentName: agent.name });

    return { ok: true };
  });

  fastify.get("/models", async (): Promise<ModelCatalog> => {
    const agy = await fetchAgyModels();
    return {
      claude: CLAUDE_MODELS,
      agy,
    };
  });

  fastify.get("/notes", async (): Promise<NoteSummary[]> => {
    try {
      const entries = await fs.readdir(NOTES_DIR, { withFileTypes: true });
      const summaries: NoteSummary[] = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const name = entry.name.slice(0, -3);
          if (isValidNoteName(name)) {
            const filePath = path.join(NOTES_DIR, entry.name);
            try {
              const stat = await fs.stat(filePath);
              const content = await fs.readFile(filePath, "utf-8");
              summaries.push({
                name,
                title: extractTitle(name, content),
                updatedAt: stat.mtimeMs,
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

  fastify.get("/notes/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Invalid note name" });
    }
    const filePath = path.join(NOTES_DIR, `${name}.md`);
    try {
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, "utf-8");
      const note: Note = {
        name,
        title: extractTitle(name, content),
        updatedAt: stat.mtimeMs,
        content,
      };
      return note;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return reply.status(404).send({ error: "Note not found" });
      }
      throw err;
    }
  });

  fastify.put("/notes/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Invalid note name" });
    }
    const body = request.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.status(400).send({ error: "Content is required" });
    }
    if (Buffer.byteLength(body.content, "utf-8") > 1024 * 1024) {
      return reply.status(413).send({ error: "Content exceeds 1 MB limit" });
    }
    const summary = await writeNoteAtomic(name, body.content);
    broadcast({ kind: "note_changed", note: summary });
    return summary;
  });

  fastify.post("/notes/:name/append", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Invalid note name" });
    }
    const body = request.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.status(400).send({ error: "Content is required" });
    }

    const filePath = path.join(NOTES_DIR, `${name}.md`);
    let combinedContent = body.content;
    try {
      const existing = await fs.readFile(filePath, "utf-8");
      if (existing.length > 0) {
        const separator = existing.endsWith("\n") ? "" : "\n";
        combinedContent = `${existing}${separator}${body.content}`;
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }

    if (Buffer.byteLength(combinedContent, "utf-8") > 1024 * 1024) {
      return reply.status(413).send({ error: "Content exceeds 1 MB limit" });
    }

    const summary = await writeNoteAtomic(name, combinedContent);
    broadcast({ kind: "note_changed", note: summary });
    return summary;
  });

  fastify.delete("/notes/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!isValidNoteName(name)) {
      return reply.status(400).send({ error: "Invalid note name" });
    }
    const filePath = path.join(NOTES_DIR, `${name}.md`);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return reply.status(404).send({ error: "Note not found" });
      }
      throw err;
    }
    broadcast({ kind: "note_deleted", name });
    return { ok: true };
  });

  await fs.mkdir(NOTES_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(NOTES_DIR, 0o700);
  } catch {}
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

/** Stops running turns (and their process trees), the notes watcher and the HTTP server, then saves state. */
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
