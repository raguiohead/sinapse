import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { Handle, Position, NodeResizeControl, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentStatus, Autonomy, Provider, ContextUsage } from "@sinapse/core";
import type { ActivityEntry } from "../activity";
import { DiffDialog } from "../components/DiffDialog";
import { ModelSelect } from "../components/ModelSelect";
import { ContextMeter } from "../components/ContextMeter";

export interface WorkerNodeData {
  id: string;
  workspaceId: string;
  name: string;
  provider: Provider;
  role?: string;
  autonomy?: Autonomy;
  status?: AgentStatus;
  model?: string;
  usage?: ContextUsage;
  /** Branch/path of the worker's git worktree, when it has one. */
  worktreeBranch?: string;
  worktreePath?: string;
  log?: ActivityEntry[];
  lastPrompt?: string;
  deleteError?: string;
}

const AUTONOMY_OPTIONS: { value: Autonomy; title: string }[] = [
  { value: "read", title: "Somente leitura" },
  { value: "edit", title: "Pode editar arquivos" },
  { value: "full", title: "Acesso total (shell sem restrições)" },
];

function ActivityView({ entries }: { entries: ActivityEntry[] }) {
  return (
    <>
      {entries.map((e, i) => {
        switch (e.kind) {
          case "prompt":
            return (
              <div key={i} className="activity-prompt">
                {e.text}
              </div>
            );
          case "text":
            return (
              <div key={i} className="activity-text note-markdown-content">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children, ...props }) => (
                      <a
                        href={href}
                        onClick={(ev) => {
                          ev.preventDefault();
                          if (href) window.sinapse?.app?.openExternal(href);
                        }}
                        target="_blank"
                        rel="noopener noreferrer"
                        {...props}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {e.text}
                </ReactMarkdown>
              </div>
            );
          case "thinking":
            return (
              <details key={i} className="activity-block activity-thinking">
                <summary>💭 pensamento</summary>
                <pre>{e.text}</pre>
              </details>
            );
          case "error":
            return (
              <div key={i} className="activity-error" role="alert">
                {e.text}
              </div>
            );
          case "tool":
            return (
              <details key={i} className={`activity-block activity-tool${e.resultIsError ? " activity-tool-error" : ""}`}>
                <summary>
                  <span className="activity-tool-name">⚙ {e.name}</span>
                  {e.summary && <span className="activity-tool-summary">{e.summary}</span>}
                  {e.result === undefined && <span className="activity-tool-pending">…</span>}
                </summary>
                {e.input && <pre>{e.input}</pre>}
                {e.result !== undefined && <pre className="activity-tool-result">{e.result || "(sem saída)"}</pre>}
              </details>
            );
        }
      })}
    </>
  );
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
  const log = nodeData.log ?? [];
  const autonomy: Autonomy = nodeData.autonomy ?? "edit";

  const [inputPrompt, setInputPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [isUpdatingModel, setIsUpdatingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isStartingHandoff, setIsStartingHandoff] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const [isEditingRole, setIsEditingRole] = useState(false);
  const [roleDraft, setRoleDraft] = useState("");
  const [isSavingRole, setIsSavingRole] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isDiffOpen, setIsDiffOpen] = useState(false);

  const outputRef = useRef<HTMLDivElement | null>(null);
  // False once the user scrolled up; new activity then stops dragging the view down.
  const stickToBottomRef = useRef(true);

  const isThinking = status === "thinking";
  const providerColor = getProviderColor(provider);
  const statusColor = getStatusColor(status);
  const statusLabel = getStatusLabel(status);

  const chipLabel = nodeData.usage?.model ?? nodeData.model ?? "padrão";
  const currentDeleteError = deleteError ?? nodeData.deleteError;

  useEffect(() => {
    if (outputRef.current && stickToBottomRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [log]);

  const handleOutputScroll = () => {
    const el = outputRef.current;
    if (el) stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const handleAutonomyChange = async (value: Autonomy) => {
    setSettingsError(null);
    try {
      await window.sinapse?.workers?.update({ workspaceId, agent: agentId, autonomy: value });
    } catch (err: any) {
      console.error("Erro ao atualizar autonomia do worker:", err);
      setSettingsError(err?.message || "Falha ao atualizar autonomia");
    }
  };

  const startEditRole = () => {
    if (isThinking) return;
    setSettingsError(null);
    setRoleDraft(nodeData.role ?? "");
    setIsEditingRole(true);
  };

  const saveRole = async () => {
    const next = roleDraft.trim();
    if (isSavingRole) return;
    if (!next || next === (nodeData.role ?? "")) {
      setIsEditingRole(false);
      return;
    }
    setIsSavingRole(true);
    try {
      await window.sinapse?.workers?.update({ workspaceId, agent: agentId, role: next });
      setIsEditingRole(false);
    } catch (err: any) {
      console.error("Erro ao atualizar papel do worker:", err);
      setSettingsError(err?.message || "Falha ao atualizar papel");
    } finally {
      setIsSavingRole(false);
    }
  };

  const handleRoleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void saveRole();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsEditingRole(false);
    }
  };

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
            <select
              value={autonomy}
              onChange={(e) => handleAutonomyChange(e.target.value as Autonomy)}
              disabled={isThinking}
              className="worker-autonomy-select nodrag"
              title={
                isThinking
                  ? "Não é possível alterar autonomia enquanto pensa"
                  : AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.title
              }
            >
              {AUTONOMY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value}
                </option>
              ))}
            </select>
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
          {settingsError && (
            <div className="worker-model-error">{settingsError}</div>
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

      {isEditingRole ? (
        <textarea
          value={roleDraft}
          onChange={(e) => setRoleDraft(e.target.value)}
          onKeyDown={handleRoleKeyDown}
          onBlur={() => setIsEditingRole(false)}
          disabled={isSavingRole}
          className="worker-role-input nodrag nowheel"
          placeholder="Papel do worker (Enter salva, Esc cancela)"
          rows={3}
          autoFocus
        />
      ) : (
        <div
          className={`worker-node-role${isThinking ? "" : " worker-node-role-editable"}`}
          title={isThinking ? role : `${role}\n\nClique para editar o papel`}
          onClick={startEditRole}
        >
          {role}
        </div>
      )}

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

      <div className="worker-output-area nodrag nowheel" ref={outputRef} onScroll={handleOutputScroll}>
        {log.length > 0 ? (
          <ActivityView entries={log} />
        ) : (
          <span className="worker-output-placeholder">Sem atividade ainda.</span>
        )}
      </div>

      <div className="worker-actions-row">
        <button
          type="button"
          className="worker-btn-diff nodrag"
          onClick={() => setIsDiffOpen(true)}
          title="Ver alterações git no diretório do worker"
        >
          Ver diff
        </button>
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

      {isDiffOpen && (
        <DiffDialog
          workspaceId={workspaceId}
          agentId={agentId}
          workerName={workerName}
          onClose={() => setIsDiffOpen(false)}
        />
      )}

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
