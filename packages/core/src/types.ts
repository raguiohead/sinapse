export type Provider = "claude" | "codex" | "agy";
export type AgentStatus = "idle" | "thinking" | "done" | "error" | "interrupted";
export type Autonomy = "read" | "edit" | "full";

/**
 * Who created or changed something: "orquestrador" (the workspace's orchestrator), "usuario" (the canvas or a
 * terminal without SINAPSE_AGENT_ID) or a worker's agentId. Comes from the X-Sinapse-Agent header (self-declared;
 * the daemon is local and token-protected).
 */
export type Author = string;

export interface OrchestratorConfig {
  provider: "claude" | "agy";
  /** Undefined = provider default. */
  model?: string;
}

export interface Workspace {
  /** /^[a-z0-9][a-z0-9_-]{0,63}$/ — used in paths. "geral" is the migrated default workspace. */
  id: string;
  /** Display name, 1–60 chars, unique case-insensitively. */
  name: string;
  /** Absolute path of the project folder. Fixed after creation; Sinapse never writes into it. */
  folder: string;
  orchestrator: OrchestratorConfig;
  createdAt: number;
}

export interface AgentConfig {
  workspaceId: string;
  /** Unique within its workspace. */
  name: string;
  provider: Provider;
  cwd: string;
  role: string;
  autonomy: Autonomy;
  /** Model requested for this agent. Undefined = provider default (account default for Claude, gemini-3.8-flash-high for AGY). */
  model?: string;
}

export interface ContextUsage {
  /** Tokens in the context window at the end of the last turn (input + cache creation + cache read of the last model call). */
  usedTokens: number;
  /** Window size; reported by the CLI when available, otherwise estimated from the model id. Undefined = unknown. */
  windowTokens?: number;
  /** True when windowTokens came from estimateContextWindow instead of the CLI. */
  windowEstimated?: boolean;
  /** Model that actually answered (resolved by the CLI, e.g. "opus" -> "claude-opus-5-5"). */
  model?: string;
}

export interface AgentState extends AgentConfig {
  id: string;
  status: AgentStatus;
  sessionId?: string;
  currentTurnId?: string;
  lastError?: string;
  usage?: ContextUsage;
  createdBy?: Author;
  /** Set by a handoff: the session was reset and the next turn is told to read this note first. Cleared once that turn succeeds. */
  handoffNote?: string;
}

export interface TurnEvent {
  type: "text" | "tool_use" | "tool_result" | "thinking" | "error" | "done";
  timestamp: number;
  data: string;
}

/** One finished turn as persisted in `<workspace>/agents/<agentId>.jsonl` (one JSON object per line). */
export interface TurnRecord {
  turnId: string;
  prompt: string;
  startedAt: number;
  finishedAt: number;
  status: "done" | "error" | "interrupted";
  error?: string;
  events: TurnEvent[];
}

export interface TurnResult {
  turnId: string;
  agentId: string;
  sessionId?: string;
  text: string;
  events: TurnEvent[];
  exitCode: number;
  durationMs: number;
  usage?: ContextUsage;
}

export interface AdapterRunOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  autonomy: Autonomy;
  model?: string;
  /** The agent's role in the team. Claude gets it as an appended system prompt every turn; AGY as a prompt prefix on the first turn. */
  role?: string;
  timeoutMs?: number;
  /** Extra env for the turn (SINAPSE_WORKSPACE, SINAPSE_AGENT_ID), applied on top of agentEnv(). */
  env?: Record<string, string>;
}

export interface Adapter {
  readonly provider: Provider;
  runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult>;
  stop(pid: number): Promise<void>;
}

/** POST ask response for async/queued asks. "queued": the worker was busy and the prompt waits in its in-memory queue. */
export interface AskResponse {
  turnId: string;
  status: "started" | "queued";
  /** 1-based position in the queue when status is "queued". */
  position?: number;
}

/** POST stop response. */
export interface StopResponse {
  ok: true;
  status: AgentStatus;
  /** True when a running turn was cancelled. */
  interrupted: boolean;
  /** Queued prompts that were discarded. */
  clearedQueue: number;
}

/** Outcome of the last handoff of a worker (kept in memory by the daemon). */
export interface HandoffOutcome {
  turnId: string;
  note: string;
  ok: boolean;
  error?: string;
  finishedAt: number;
}

/** POST handoff response: the summary turn runs in the background; follow it with wait/check. */
export interface HandoffResponse {
  turnId: string;
  note: string;
}

/** GET check response. */
export interface CheckResponse {
  agentId: string;
  name: string;
  status: AgentStatus;
  model?: string;
  usage?: ContextUsage;
  turnId?: string;
  /** Events of the running turn, or of the last finished one. */
  events: TurnEvent[];
  /** Concatenated "text" events of those same events (partial while thinking). */
  text: string;
  /** Prompts waiting in the queue. */
  queued: number;
  lastError?: string;
  handoffNote?: string;
  lastHandoff?: HandoffOutcome;
}

/** One worker in a POST wait response. */
export interface WaitResult {
  agentId: string;
  name: string;
  /** "removed" when the worker was deleted while waiting. */
  status: AgentStatus | "removed";
  /** Still thinking, with queued prompts, or finishing a handoff. */
  busy: boolean;
  queued: number;
  usage?: ContextUsage;
  /** Full text of the last finished turn (empty while busy). */
  text: string;
  lastError?: string;
}

/** POST wait response. `done` = the condition (all, or any with `any`) was met before this request's timeout. */
export interface WaitResponse {
  done: boolean;
  results: WaitResult[];
}

export interface ModelOption {
  id: string;
  label: string;
}

/** GET /models response. */
export type ModelCatalog = Record<"claude" | "agy", ModelOption[]>;

export interface NoteSummary {
  workspaceId: string;
  /** File name without ".md"; only [a-z0-9-_] (lowercase), max 64 chars. */
  name: string;
  /** First "# " heading, or the name. */
  title: string;
  updatedAt: number;
  /** Undefined when the note was created outside Sinapse. */
  createdBy?: Author;
  /** Other authors that wrote or appended later (no duplicates, excludes createdBy). */
  contributors: Author[];
}

export interface Note extends NoteSummary {
  content: string;
}

export type DaemonEvent =
  | { kind: "workspace_created"; workspace: Workspace }
  | { kind: "workspace_updated"; workspace: Workspace }
  | { kind: "workspace_deleted"; workspaceId: string }
  | { kind: "agent_spawned"; workspaceId: string; agent: AgentState }
  | { kind: "agent_updated"; workspaceId: string; agent: AgentState }
  | { kind: "agent_deleted"; workspaceId: string; agentId: string; agentName: string }
  | {
      kind: "turn_started";
      workspaceId: string;
      agentId: string;
      agentName: string;
      turnId: string;
      prompt: string;
    }
  | {
      kind: "turn_event";
      workspaceId: string;
      agentId: string;
      agentName: string;
      turnId: string;
      event: TurnEvent;
    }
  | {
      kind: "turn_finished";
      workspaceId: string;
      agentId: string;
      agentName: string;
      turnId: string;
      status: AgentStatus;
      text?: string;
      error?: string;
      usage?: ContextUsage;
    }
  /** `by`: who made this change (undefined for changes made outside Sinapse, seen by the file watcher). */
  | { kind: "note_changed"; workspaceId: string; note: NoteSummary; by?: Author }
  | { kind: "note_deleted"; workspaceId: string; name: string };

export interface DaemonState {
  workspaces: Record<string, Workspace>;
  agents: Record<string, AgentState>;
  port: number;
  token: string;
}
