import { useState, useEffect, type FormEvent } from "react";
import { ModelSelect } from "./ModelSelect";

export interface NewWorkspaceDialogProps {
  onClose: () => void;
  onSuccess?: () => void;
}

export function NewWorkspaceDialog({ onClose, onSuccess }: NewWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [provider, setProvider] = useState<"claude" | "agy">("claude");
  const [model, setModel] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
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

  const handlePickFolder = async () => {
    try {
      const picked = await window.sinapse?.app?.pickFolder();
      if (picked) {
        setFolder(picked);
        // If name is empty, suggest the folder basename
        if (!name.trim()) {
          const parts = picked.split("/").filter(Boolean);
          if (parts.length > 0) {
            setName(parts[parts.length - 1]);
          }
        }
      }
    } catch (err) {
      console.error("Erro ao escolher pasta:", err);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const wsName = name.trim();
    const wsFolder = folder.trim();
    if (!wsName || !wsFolder || isCreating) return;

    setIsCreating(true);
    setErrorMessage(null);

    try {
      const created = await window.sinapse?.workspaces?.create({
        name: wsName,
        folder: wsFolder,
        orchestrator: {
          provider,
          ...(model ? { model } : {}),
        },
      });

      if (created) {
        await window.sinapse?.workspaces?.setActive(created.id);
      }

      onSuccess?.();
      onClose();
    } catch (err: any) {
      console.error("Erro ao criar workspace:", err);
      setErrorMessage(err?.message || "Erro ao criar workspace");
    } finally {
      setIsCreating(false);
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
          <h2 className="dialog-title">Novo Workspace</h2>
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
            <label className="dialog-label" htmlFor="workspace-name-input">
              Nome do workspace <span className="dialog-required">*</span>
            </label>
            <input
              id="workspace-name-input"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrorMessage(null);
              }}
              placeholder="ex: Projeto Sinapse"
              className="dialog-input"
              required
              autoFocus
            />
          </div>

          <div className="dialog-field">
            <label className="dialog-label" htmlFor="workspace-folder-input">
              Pasta do projeto <span className="dialog-required">*</span>
            </label>
            <div className="dialog-folder-row">
              <input
                id="workspace-folder-input"
                type="text"
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setErrorMessage(null);
                }}
                placeholder="/caminho/do/projeto"
                className="dialog-input dialog-input-mono"
                required
              />
              <button
                type="button"
                onClick={handlePickFolder}
                className="dialog-btn dialog-btn-secondary dialog-btn-pick"
              >
                Escolher pasta…
              </button>
            </div>
            <span className="dialog-hint">
              Pasta raiz do repositório ou projeto local.
            </span>
          </div>

          <div className="dialog-field-row">
            <div className="dialog-field" style={{ flex: 1 }}>
              <label className="dialog-label">Orquestrador</label>
              <div className="segmented-control" style={{ width: "100%" }}>
                <button
                  type="button"
                  className={`segmented-btn ${provider === "claude" ? "active" : ""}`}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setProvider("claude");
                    setModel(null);
                  }}
                >
                  Claude Code
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${provider === "agy" ? "active" : ""}`}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setProvider("agy");
                    setModel(null);
                  }}
                >
                  AGY
                </button>
              </div>
            </div>

            <div className="dialog-field" style={{ flex: 1 }}>
              <label className="dialog-label" htmlFor="workspace-model-select">
                Modelo
              </label>
              <ModelSelect
                id="workspace-model-select"
                provider={provider}
                value={model}
                onChange={(m) => setModel(m)}
                className="dialog-model-select"
              />
            </div>
          </div>

          {errorMessage && (
            <div className="dialog-error" role="alert">
              {errorMessage}
            </div>
          )}

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
              disabled={isCreating || !name.trim() || !folder.trim()}
              className="dialog-btn dialog-btn-primary"
            >
              {isCreating ? "Criando..." : "Criar Workspace"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
