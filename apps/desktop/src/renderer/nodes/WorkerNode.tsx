import { useState, useEffect, useRef, type FormEvent } from "react";
import { Handle, Position, NodeResizeControl, type NodeProps } from "@xyflow/react";
import type { AgentStatus, Provider, ContextUsage } from "@sinapse/core";
import { ModelSelect } from "../components/ModelSelect";
import { ContextMeter } from "../components/ContextMeter";

export interface WorkerNodeData {
  id: string;
  workspaceId: string;
  name: string;
  provider: Provider;
  role?: string;
  status?: AgentStatus;
  model?: string;
  usage?: ContextUsage;
  /** Branch/path of the worker's git worktree, when it has one. */
  worktreeBranch?: string;
  worktreePath?: string;
  log?: string;
  lastPrompt?: string;
  deleteError?: string;
}

function getProviderColor(p: string): string {
  if (p === "agy") return "var(--agy)";
  if (p === "claude") return "var(--claude)";
  if (p === "codex") return "var(--codex)";
  return "var(--accent-b)";
}

function getProviderInitial(p: string): string {
  if (p === "agy") return "G";
  if (p === "claude") return "C";
  if (p === "codex") return "X";
  return p.charAt(0).toUpperCase();
}

function getStatusLabel(s: AgentStatus): string {
  switch (s) {
    case "thinking":
      return "pensando";
    case "done":
      return "concluído";
    case "error":
      return "erro";
    case "interrupted":
      return "interrompido";
    case "idle":
    default:
      return "ocioso";
  }
}

function getStatusColor(s: AgentStatus): string {
  switch (s) {
    case "thinking":
      return "var(--thinking)";
    case "done":
      return "var(--done)";
    case "error":
      return "var(--error)";
    case "interrupted":
      return "var(--interrupted)";
    case "idle":
    default:
      return "var(--idle)";
  }
}

export function WorkerNode({ data }: NodeProps) {
  const nodeData = (data ?? {}) as unknown as WorkerNodeData;
  const agentId = nodeData.id;
  const workspaceId = nodeData.workspaceId;
  const workerName = nodeData.name || "worker";
  const provider = nodeData.provider || "claude";
  const role = nodeData.role || "Agente worker";
  const status: AgentStatus = nodeData.status || "idle";
  const log = nodeData.log || "";

  const [inputPrompt, setInputPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [isUpdatingModel, setIsUpdatingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isStartingHandoff, setIsStartingHandoff] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const outputRef = useRef<HTMLDivElement | null>(null);

  const isThinking = status === "thinking";
  const providerColor = getProviderColor(provider);
  const statusColor = getStatusColor(status);
  const statusLabel = getStatusLabel(status);

  const chipLabel = nodeData.usage?.model ?? nodeData.model ?? "padrão";
  const currentDeleteError = deleteError ?? nodeData.deleteError;

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [log]);

  const handleDelete = async () => {
    const message =
      status === "thinking"
        ? `Excluir o worker "${workerName}"? O turno em andamento será interrompido e a sessão dele será perdida.`
        : `Excluir o worker "${workerName}"? A sessão dele será perdida.`;
    if (!window.confirm(message)) return;

    setDeleteError(null);
    try {
      const result = await window.sinapse?.workers?.delete(workspaceId, agentId);
      if (result?.worktree?.action === "kept") {
        window.alert(
          `Worker removido, mas a worktree e a branch ${result.worktree.branch} foram mantidas ` +
            `(${result.worktree.reason ?? "motivo desconhecido"}):\n${result.worktree.path}`
        );
      }
    } catch (err: any) {
      console.error("Erro ao excluir worker:", err);
      setDeleteError(err?.message || "Falha ao excluir worker");
    }
  };

  const handleModelChange = async (newModel: string | null) => {
    setIsUpdatingModel(true);
    setModelError(null);
    try {
      await window.sinapse?.workers?.update({
        workspaceId,
        agent: agentId,
        model: newModel,
      });
      setIsEditingModel(false);
    } catch (err: any) {
      console.error("Erro ao atualizar modelo do worker:", err);
      setModelError(err?.message || "Falha ao atualizar modelo");
    } finally {
      setIsUpdatingModel(false);
    }
  };

  const handleAsk = async (e: FormEvent) => {
    e.preventDefault();
    const query = inputPrompt.trim();
    if (!query || isThinking || isSubmitting) return;

    setIsSubmitting(true);
    setInputPrompt("");
    try {
      await window.sinapse?.workers?.ask({
        workspaceId,
        agent: agentId,
        prompt: query,
      });
    } catch (err: any) {
      console.error("Erro ao enviar prompt ao worker:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleHandoff = async () => {
    const message = `Fazer handoff de "${workerName}"? Ele resume o trabalho numa nota, a sessão é zerada e o próximo turno começa lendo essa nota.`;
    if (!window.confirm(message)) return;

    setIsStartingHandoff(true);
    setHandoffError(null);
    try {
      await window.sinapse?.workers?.handoff(workspaceId, agentId);
    } catch (err: any) {
      console.error("Erro ao iniciar handoff:", err);
      setHandoffError(err?.message || "Falha ao iniciar handoff");
    } finally {
      setIsStartingHandoff(false);
    }
  };

  const handleStop = async () => {
    try {
      await window.sinapse?.workers?.stop(workspaceId, agentId);
    } catch (err) {
      console.error("Erro ao interromper worker:", err);
    }
  };

  return (
    <div className="worker-node-card">
      <Handle
        type="target"
        position={Position.Left}
        id="worker-target"
        className="flow-handle worker-handle-target"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="worker-source"
        className="flow-handle worker-handle-source"
      />

      <div className="worker-node-header">
        {/* Circular avatar with provider initial and animated status ring */}
        <div className="worker-avatar-container">
          <div
            className={`worker-avatar-ring ${isThinking ? "ring-thinking" : ""}`}
            style={{
              backgroundColor: isThinking ? undefined : statusColor,
            }}
          />
          <div
            className="worker-avatar-core"
            style={{ color: providerColor }}
          >
            {getProviderInitial(provider)}
          </div>
        </div>

        <div className="worker-node-identity">
          <div className="worker-title-line">
            <span className="worker-node-name">{workerName}</span>
            <span
              className={`worker-provider-badge badge-${provider}`}
              style={{ borderColor: providerColor, color: providerColor }}
            >
              {provider}
            </span>
          </div>

          {/* Model chip or ModelSelect */}
          <div className="worker-model-row">
            {!isEditingModel ? (
              <button
                type="button"
                onClick={() => {
                  if (!isThinking) {
                    setModelError(null);
                    setIsEditingModel(true);
                  }
                }}
                disabled={isThinking}
                className="worker-model-chip"
                title={
                  isThinking
                    ? "Não é possível alterar modelo enquanto pensa"
                    : "Clique para selecionar o modelo"
                }
              >
                {chipLabel}
              </button>
            ) : (
              <div className="worker-model-select-inline">
                <ModelSelect
                  provider={provider}
                  value={nodeData.model ?? ""}
                  resolvedModel={nodeData.usage?.model}
                  disabled={isThinking || isUpdatingModel}
                  onChange={handleModelChange}
                  className="worker-model-select"
                />
                <button
                  type="button"
                  onClick={() => {
                    setIsEditingModel(false);
                    setModelError(null);
                  }}
                  className="worker-model-close-btn"
                  title="Fechar seleção"
                >
                  ✕
                </button>
              </div>
            )}
            {nodeData.worktreeBranch && (
              <span
                className="worker-branch-badge"
                title={`Worktree isolada: ${nodeData.worktreePath ?? ""}`}
              >
                ⎇ {nodeData.worktreeBranch}
              </span>
            )}
          </div>

          {modelError && (
            <div className="worker-model-error">{modelError}</div>
          )}

          <div className="worker-status-line">
            <span
              className="status-dot"
              style={{ backgroundColor: statusColor }}
            />
            <span className="worker-status-label">{statusLabel}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDelete}
          className="worker-btn-delete nodrag"
          title="Excluir worker"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
      </div>

      {currentDeleteError && (
        <div className="worker-delete-error" role="alert">
          {currentDeleteError}
        </div>
      )}

      <div className="worker-node-role" title={role}>
        {role}
      </div>

      <ContextMeter
        usage={nodeData.usage}
        className="worker-context-meter"
        onHandoff={handleHandoff}
        handoffDisabled={isThinking || isStartingHandoff}
      />

      {handoffError && (
        <div className="worker-delete-error" role="alert">
          {handoffError}
        </div>
      )}

      <div className="worker-output-area nodrag nowheel" ref={outputRef}>
        {log ? (
          <pre className="worker-output-text">{log}</pre>
        ) : (
          <span className="worker-output-placeholder">Sem atividade ainda.</span>
        )}
      </div>

      <form onSubmit={handleAsk} className="worker-input-form nodrag">
        <input
          type="text"
          value={inputPrompt}
          onChange={(e) => setInputPrompt(e.target.value)}
          placeholder="Perguntar ao worker..."
          disabled={isThinking}
          className="worker-prompt-input"
        />
        {isThinking ? (
          <button
            type="button"
            onClick={handleStop}
            className="worker-btn worker-btn-stop"
            title="Interromper worker"
          >
            Parar
          </button>
        ) : (
          <button
            type="submit"
            disabled={!inputPrompt.trim() || isSubmitting}
            className="worker-btn worker-btn-ask"
          >
            Perguntar
          </button>
        )}
      </form>

      <NodeResizeControl
        position="bottom-right"
        minWidth={280}
        minHeight={300}
        className="node-resize-control nodrag"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="node-resize-grip-icon"
          aria-hidden="true"
        >
          <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
          <line x1="8.5" y1="5" x2="5" y2="8.5" />
          <line x1="8.5" y1="8.5" x2="8.5" y2="8.5" />
        </svg>
      </NodeResizeControl>
    </div>
  );
}
