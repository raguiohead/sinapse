import { useState, useEffect, type FormEvent } from "react";

export interface NewNoteDialogProps {
  workspaceId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

const NOTE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function NewNoteDialog({ workspaceId, onClose, onSuccess }: NewNoteDialogProps) {
  const [name, setName] = useState("");
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const raw = name.toLowerCase().trim();
    if (!raw || isCreating) return;

    if (!NOTE_NAME_REGEX.test(raw)) {
      setErrorMessage(
        "Nome inválido. Use 1 a 64 caracteres: letras minúsculas, números, - ou _, começando por letra ou número."
      );
      return;
    }

    setIsCreating(true);
    setErrorMessage(null);

    try {
      await window.sinapse?.notes?.write({
        workspaceId,
        name: raw,
        content: `# ${raw}\n\n`,
      });
      onSuccess?.();
      onClose();
    } catch (err: any) {
      console.error("Erro ao criar nota:", err);
      setErrorMessage(err?.message || "Erro ao criar nota");
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
          <h2 className="dialog-title">Nova Nota</h2>
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
            <label className="dialog-label" htmlFor="note-name-input">
              Identificador da nota <span className="dialog-required">*</span>
            </label>
            <input
              id="note-name-input"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value.toLowerCase());
                setErrorMessage(null);
              }}
              placeholder="ex: arquitetura-projeto"
              className="dialog-input"
              required
              autoFocus
            />
            <span className="dialog-hint">
              Apenas letras minúsculas, números, - e _ (máx. 64 caracteres)
            </span>
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
              disabled={isCreating || !name.trim()}
              className="dialog-btn dialog-btn-primary"
            >
              {isCreating ? "Criando..." : "Criar Nota"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
