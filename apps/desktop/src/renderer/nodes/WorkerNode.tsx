import { useState, useEffect, useRef, type FormEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AgentStatus, Provider, ContextUsage } from "@sinapse/core";
import { ModelSelect } from "../components/ModelSelect";
import { ContextMeter } from "../components/ContextMeter";

export interface WorkerNodeData {
  name: string;
  provider: Provider;
  role?: string;
  status?: AgentStatus;
  model?: string;
  usage?: ContextUsage;
  log?: string;
  lastPrompt?: string;
}

function getProviderColor(p: string): string {
  if (p === "agy") return "var(--agy)";
  if (p === "claude") return "var(--claude)";
  return "var(--accent-b)";
}

function getProviderInitial(p: string): string {
  if (p === "agy") return "G";
  if (p === "claude") return "C";
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

  const outputRef = useRef<HTMLDivElement | null>(null);

  const isThinking = status === "thinking";
  const providerColor = getProviderColor(provider);
  const statusColor = getStatusColor(status);
  const statusLabel = getStatusLabel(status);

  const chipLabel = nodeData.usage?.model ?? nodeData.model ?? "padrão";

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [log]);

  const handleModelChange = async (newModel: string | null) => {
    setIsUpdatingModel(true);
    setModelError(null);
    try {
      await window.sinapse?.workers?.update({
        name: workerName,
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
        name: workerName,
        prompt: query,
      });
    } catch (err: any) {
      console.error("Erro ao enviar prompt ao worker:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = async () => {
    try {
      await window.sinapse?.workers?.stop(workerName);
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
      </div>

      <div className="worker-node-role" title={role}>
        {role}
      </div>

      <ContextMeter usage={nodeData.usage} className="worker-context-meter" />

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
    </div>
  );
}
