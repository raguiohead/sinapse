export type Provider = "claude" | "codex" | "agy";
export type AgentStatus = "idle" | "thinking" | "done" | "error" | "interrupted";
export type Autonomy = "read" | "edit" | "full";

export interface AgentConfig {
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
}

export interface TurnEvent {
  type: "text" | "tool_use" | "tool_result" | "thinking" | "error" | "done";
  timestamp: number;
  data: string;
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
  timeoutMs?: number;
}

export interface Adapter {
  readonly provider: Provider;
  runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult>;
  stop(pid: number): Promise<void>;
}

export interface ModelOption {
  id: string;
  label: string;
}

/** GET /models response. */
export type ModelCatalog = Record<"claude" | "agy", ModelOption[]>;

export interface NoteSummary {
  /** File name without ".md"; only [a-z0-9-_] (lowercase), max 64 chars. */
  name: string;
  /** First "# " heading, or the name. */
  title: string;
  updatedAt: number;
}

export interface Note extends NoteSummary {
  content: string;
}

export type DaemonEvent =
  | { kind: "agent_spawned"; agent: AgentState }
  | { kind: "agent_updated"; agent: AgentState }
  | { kind: "turn_started"; agentId: string; agentName: string; turnId: string; prompt: string }
  | { kind: "turn_event"; agentId: string; agentName: string; turnId: string; event: TurnEvent }
  | {
      kind: "turn_finished";
      agentId: string;
      agentName: string;
      turnId: string;
      status: AgentStatus;
      text?: string;
      error?: string;
      usage?: ContextUsage;
    }
  | { kind: "note_changed"; note: NoteSummary }
  | { kind: "note_deleted"; name: string };

export interface DaemonState {
  agents: Record<string, AgentState>;
  port: number;
  token: string;
}
