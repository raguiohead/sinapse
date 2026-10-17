import { useState, useEffect, type FormEvent } from "react";
import type { WorkerDefaults, Autonomy, WorkerSpawnPayload } from "../../shared/ipc";
import { ModelSelect } from "./ModelSelect";

export interface NewWorkerDialogProps {
  workspaceId: string;
  workspaceDefaultFolder?: string;
  defaults?: WorkerDefaults;
  onClose: () => void;
  onSuccess?: () => void;
}

export function NewWorkerDialog({
  workspaceId,
  workspaceDefaultFolder = "",
  defaults,
  onClose,
  onSuccess,
}: NewWorkerDialogProps) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"claude" | "agy">(
    defaults?.provider ?? "claude"
  );
  const [model, setModel] = useState<string | null>(defaults?.model ?? null);
  const [role, setRole] = useState("");
  const [autonomy, setAutonomy] = useState<Autonomy>(
    defaults?.autonomy ?? "edit"
  );
  const [cwd, setCwd] = useState(workspaceDefaultFolder);
  const [worktree, setWorktree] = useState(false);
  const [isSpawning, setIsSpawning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const workerName = name.trim();
    if (!workerName || isSpawning) return;

    setIsSpawning(true);
    setErrorMessage(null);

    try {
      const payload: WorkerSpawnPayload = {
        workspaceId,
        name: workerName,
        provider,
        role: role.trim() || "Agente worker",
        autonomy,
        cwd: cwd.trim() || undefined,
        ...(model ? { model } : {}),
        ...(worktree ? { worktree: true } : {}),
      };

      await window.sinapse?.workers?.spawn(payload);
      onSuccess?.();
      onClose();
    } catch (err: any) {
      console.error("Erro ao criar worker:", err);
      setErrorMessage(err?.message || "Erro ao criar worker");
    } finally {
      setIsSpawning(false);
    }
  };

  return (
    <div
      className="dialog-backdrop nodrag"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-modal" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <h2 className="dialog-title">Novo Worker</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close-btn"
            title="Fechar"
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="dialog-form">
          <div className="dialog-field">
            <label className="dialog-label" htmlFor="worker-name-input">
              Nome <span className="dialog-required">*</span>
            </label>
            <input
              id="worker-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex: revisor, analista"
              className="dialog-input"
              required
              autoFocus
            />
          </div>

          <div className="dialog-field-row">
            <div className="dialog-field" style={{ flex: 1 }}>
              <label className="dialog-label" htmlFor="worker-provider-select">
                Provedor
              </label>
              <select
                id="worker-provider-select"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as "claude" | "agy");
                  setModel(null);
                }}
                className="dialog-select"
              >
                <option value="claude">Claude</option>
                <option value="agy">AGY (Gemini 3.8 Flash)</option>
              </select>
            </div>

            <div className="dialog-field" style={{ flex: 1 }}>
              <label className="dialog-label" htmlFor="worker-model-select">
                Modelo
              </label>
              <ModelSelect
                id="worker-model-select"
                provider={provider}
                value={model}
                onChange={(m) => setModel(m)}
                className="dialog-model-select"
              />
            </div>
          </div>

          <div className="dialog-field">
            <label className="dialog-label" htmlFor="worker-role-input">
              Papel
            </label>
            <input
              id="worker-role-input"
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="ex: Revisor de código"
              className="dialog-input"
            />
          </div>

          <div className="dialog-field">
            <label className="dialog-label" htmlFor="worker-autonomy-select">
              Autonomia
            </label>
            <select
              id="worker-autonomy-select"
              value={autonomy}
              onChange={(e) => setAutonomy(e.target.value as Autonomy)}
              className="dialog-select"
            >
              <option value="read">Somente leitura</option>
              <option value="edit">Editar (padrão)</option>
              <option value="full">Total</option>
            </select>
          </div>

          <div className="dialog-field">
            <label className="dialog-label" htmlFor="worker-cwd-input">
              Pasta de trabalho
            </label>
            <input
              id="worker-cwd-input"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/caminho/absoluto"
              className="dialog-input dialog-input-mono"
            />
          </div>

          <div className="dialog-field">
            <label className="dialog-checkbox-label" htmlFor="worker-worktree-input">
              <input
                id="worker-worktree-input"
                type="checkbox"
                checked={worktree}
                onChange={(e) => setWorktree(e.target.checked)}
              />
              Isolar em git worktree
            </label>
            <div className="dialog-hint">
              Cria a branch sinapse/&lt;nome&gt; numa pasta própria. Exige repositório git; node_modules e artefatos não vêm junto.
            </div>
          </div>

          {errorMessage && <div className="dialog-error">{errorMessage}</div>}

          <div className="dialog-actions">
            <button
              type="button"
              onClick={onClose}
              className="dialog-btn dialog-btn-secondary"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSpawning || !name.trim()}
              className="dialog-btn dialog-btn-primary"
            >
              {isSpawning ? "Criando..." : "Criar Worker"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
