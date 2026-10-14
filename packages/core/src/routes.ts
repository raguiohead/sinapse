// Single source of the daemon's HTTP paths, shared by the daemon, the CLI and the desktop app.
// `ws` and `agent` accept an id or a name; callers must encode nothing themselves.
const seg = (value: string) => encodeURIComponent(value);

export const routes = {
  health: () => "/health",
  events: () => "/events",
  models: () => "/models",

  /** GET list | POST create {name, folder, orchestrator} */
  workspaces: () => "/workspaces",
  /** PATCH {name?, orchestrator?} | DELETE (stops its turns, removes its agents and Sinapse data; never the project folder) */
  workspace: (ws: string) => `/workspaces/${seg(ws)}`,

  /** GET list | POST spawn (AgentConfig without workspaceId) */
  agents: (ws: string) => `/workspaces/${seg(ws)}/agents`,
  /** PATCH {model?, role?, autonomy?} | DELETE */
  agent: (ws: string, agent: string) => `/workspaces/${seg(ws)}/agents/${seg(agent)}`,
  /** POST {prompt, async?} */
  agentAsk: (ws: string, agent: string) => `/workspaces/${seg(ws)}/agents/${seg(agent)}/ask`,
  /** GET */
  agentCheck: (ws: string, agent: string) => `/workspaces/${seg(ws)}/agents/${seg(agent)}/check`,
  /** POST */
  agentStop: (ws: string, agent: string) => `/workspaces/${seg(ws)}/agents/${seg(agent)}/stop`,

  /** GET list */
  notes: (ws: string) => `/workspaces/${seg(ws)}/notes`,
  /** GET | PUT {content} | DELETE */
  note: (ws: string, name: string) => `/workspaces/${seg(ws)}/notes/${seg(name)}`,
  /** POST {content} */
  noteAppend: (ws: string, name: string) => `/workspaces/${seg(ws)}/notes/${seg(name)}/append`,
};

/** Header carrying the caller's identity (SINAPSE_AGENT_ID) on spawn, note write and note append. */
export const AUTHOR_HEADER = "x-sinapse-agent";
export const ORCHESTRATOR_AUTHOR = "orquestrador";
export const USER_AUTHOR = "usuario";

/** Env vars the daemon and the app set for orchestrators and workers. */
export const ENV = {
  workspace: "SINAPSE_WORKSPACE",
  agentId: "SINAPSE_AGENT_ID",
} as const;
