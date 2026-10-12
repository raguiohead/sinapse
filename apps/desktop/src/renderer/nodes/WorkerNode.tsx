import { useState, useEffect, useRef, type FormEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type WorkerStatus = "idle" | "thinking" | "done" | "error" | "interrupted";

export interface WorkerNodeData {
  name: string;
  provider: "claude" | "agy";
  role?: string;
  status?: WorkerStatus;
}

export function WorkerNode({ data }: NodeProps) {
  const nodeData = (data ?? {}) as unknown as WorkerNodeData;
  const workerName = nodeData.name || "worker";
  const provider = nodeData.provider || "claude";
  const role = nodeData.role || "Worker agent";

  const [status, setStatus] = useState<WorkerStatus>(nodeData.status || "idle");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [isAsking, setIsAsking] = useState(false);

  const outputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.sinapse?.workers?.onEvents((event: any) => {
      if (event?.agent && event.agent !== workerName) {
        return;
      }

      if (event?.type === "text") {
        setStatus("thinking");
        setOutput((prev) => prev + event.data);
      } else if (event?.type === "thinking") {
        setStatus("thinking");
        setOutput((prev) => prev + `[thinking] ${event.data}\n`);
      } else if (event?.type === "tool_use") {
        setOutput((prev) => prev + `\n[tool: ${event.data}]\n`);
      } else if (event?.type === "tool_result") {
        setOutput((prev) => prev + `[result: ${event.data}]\n`);
      } else if (event?.type === "error") {
        setStatus("error");
        setOutput((prev) => prev + `\n[error: ${event.data}]\n`);
      } else if (event?.type === "done") {
        setStatus("done");
      }
    });
  }, [workerName]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleAsk = async (e: FormEvent) => {
    e.preventDefault();
    const query = prompt.trim();
    if (!query || isAsking) return;

    setPrompt("");
    setIsAsking(true);
    setStatus("thinking");
    setOutput((prev) => (prev ? prev + `\n> ${query}\n` : `> ${query}\n`));

    try {
      await window.sinapse?.workers?.ask({
        name: workerName,
        prompt: query,
      });
      setStatus((current) => (current === "thinking" ? "done" : current));
    } catch (err: any) {
      setStatus("error");
      setOutput((prev) => prev + `\n[error: ${err?.message || String(err)}]\n`);
    } finally {
      setIsAsking(false);
    }
  };

  const handleStop = async () => {
    try {
      await window.sinapse?.workers?.stop(workerName);
      setStatus("interrupted");
      setIsAsking(false);
    } catch (err) {
      console.error("Failed to stop worker:", err);
    }
  };

  const getStatusColor = (s: WorkerStatus): string => {
    switch (s) {
      case "thinking":
        return "#f59e0b";
      case "done":
        return "#10b981";
      case "error":
        return "#ef4444";
      case "interrupted":
        return "#f97316";
      case "idle":
      default:
        return "#71717a";
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
        <div className="worker-node-title-group">
          <span className="worker-node-name">{workerName}</span>
          <span className={`worker-provider-badge badge-${provider}`}>{provider}</span>
        </div>

        <div className="worker-status-group">
          <span
            className={`status-indicator-dot ${status === "thinking" ? "status-pulse" : ""}`}
            style={{ backgroundColor: getStatusColor(status) }}
          />
          <span className="worker-status-text">{status}</span>
        </div>
      </div>

      <div className="worker-node-role">{role}</div>

      <div className="worker-output-area nodrag nowheel" ref={outputRef}>
        {output ? (
          <pre className="worker-output-text">{output}</pre>
        ) : (
          <span className="worker-output-placeholder">No activity yet. Send a prompt to start.</span>
        )}
      </div>

      <form onSubmit={handleAsk} className="worker-input-form nodrag">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask worker..."
          disabled={isAsking}
          className="worker-prompt-input"
        />
        {isAsking ? (
          <button
            type="button"
            onClick={handleStop}
            className="worker-btn worker-btn-stop"
            title="Stop worker"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!prompt.trim()}
            className="worker-btn worker-btn-ask"
          >
            Ask
          </button>
        )}
      </form>
    </div>
  );
}
