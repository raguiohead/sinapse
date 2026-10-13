import Fastify from "fastify";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { sinapseDir } from "../paths.js";
import type {
  AgentConfig,
  AgentState,
  DaemonEvent,
  DaemonState,
  Provider,
  TurnEvent,
  TurnResult,
} from "../types.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { AgyAdapter } from "../adapters/agy.js";

const SINAPSE_DIR = sinapseDir();
const STATE_FILE = path.join(SINAPSE_DIR, "state.json");
const DAEMON_FILE = path.join(SINAPSE_DIR, "daemon.json");

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
  try {
    await fs.mkdir(SINAPSE_DIR, { recursive: true });
    const content = await fs.readFile(STATE_FILE, "utf-8");
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
    return { agents: {} };
  }
}

// Both files hold the daemon token, so keep them owner-only (chmod also fixes files created before this).
async function writePrivate(file: string, content: string): Promise<void> {
  await fs.mkdir(SINAPSE_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function saveState(): Promise<void> {
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
    });
    await saveState();
  }
}

export async function start(): Promise<{ port: number; token: string }> {
  const loaded = await loadSavedState();
  state.agents = loaded.agents;
  state.token = loaded.token || nanoid();

  const fastify = Fastify({ logger: false });

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
    };

    state.agents[agentId] = newAgent;
    await saveState();
    broadcast({ kind: "agent_spawned", agent: newAgent });

    return reply.status(201).send(newAgent);
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

  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address() as AddressInfo;
  state.port = address.port;

  await writeDaemonFile(state.port, state.token);
  await saveState();

  const cleanup = async () => {
    try {
      await saveState();
    } catch {}
  };

  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  return { port: state.port, token: state.token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start()
    .then(({ port }) => {
      console.log(`sinapsed running on port ${port}`);
    })
    .catch((err) => {
      console.error("Failed to start sinapsed:", err);
      process.exit(1);
    });
}
