export type Provider = "claude" | "codex" | "agy";
export type AgentStatus = "idle" | "thinking" | "done" | "error" | "interrupted";
export type Autonomy = "read" | "edit" | "full";

export interface AgentConfig {
  name: string;
  provider: Provider;
  cwd: string;
  role: string;
  autonomy: Autonomy;
}

export interface AgentState extends AgentConfig {
  id: string;
  status: AgentStatus;
  sessionId?: string;
  currentTurnId?: string;
  lastError?: string;
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
}

export interface AdapterRunOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  autonomy: Autonomy;
  timeoutMs?: number;
}

export interface Adapter {
  readonly provider: Provider;
  runTurn(options: AdapterRunOptions): AsyncGenerator<TurnEvent, TurnResult>;
  stop(pid: number): Promise<void>;
}

export interface DaemonState {
  agents: Record<string, AgentState>;
  port: number;
  token: string;
}
