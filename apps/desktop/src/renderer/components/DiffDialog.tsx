import { useEffect, useState } from "react";
import ReactDOM from "react-dom";
import type { WorkerDiffResult } from "../../shared/ipc";

export interface DiffDialogProps {
  workspaceId: string;
  agentId: string;
  workerName: string;
  onClose: () => void;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "diff-line-meta";
  }
  if (line.startsWith("@@")) return "diff-line-hunk";
  if (line.startsWith("+")) return "diff-line-add";
  if (line.startsWith("-")) return "diff-line-del";
  if (line.startsWith("#") || line.startsWith("??")) return "diff-line-note";
  return "";
}

export function DiffDialog({ workspaceId, agentId, workerName, onClose }: DiffDialogProps) {
  const [result, setResult] = useState<WorkerDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.sinapse?.workers
      ?.diff(workspaceId, agentId)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || "Falha ao ler o diff");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const failure = error ?? (result && !result.ok ? result.error ?? "Falha ao ler o diff" : null);
  const lines = result?.ok ? result.diff.split("\n") : [];

  return ReactDOM.createPortal(
    <div
      className="dialog-backdrop nodrag nowheel"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dialog-modal diff-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">Diff · {workerName}</h2>
          <button type="button" onClick={onClose} className="dialog-close-btn" title="Fechar" aria-label="Fechar">
            ✕
          </button>
        </div>

        {failure && <div className="dialog-error">{failure}</div>}
        {!failure && !result && <div className="diff-empty">Carregando...</div>}
        {result?.ok && result.status.trim() === "" && <div className="diff-empty">Sem alterações.</div>}
        {result?.ok && result.status.trim() !== "" && (
          <>
            <pre className="diff-status">{result.status}</pre>
            <pre className="diff-body">
              {lines.map((line, i) => (
                <div key={i} className={`diff-line ${lineClass(line)}`}>
                  {line || " "}
                </div>
              ))}
            </pre>
            {result.truncated && <div className="diff-empty">Diff truncado (limite de 200 KB).</div>}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
