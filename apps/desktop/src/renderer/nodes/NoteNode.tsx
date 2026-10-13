import { useState, useEffect } from "react";
import type { NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface NoteNodeData {
  name: string;
  title: string;
  content: string;
  updatedAt: number;
}

export function NoteNode({ data }: NodeProps) {
  const nodeData = (data ?? {}) as unknown as NoteNodeData;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [syncedContent, setSyncedContent] = useState("");
  const [hasConflict, setHasConflict] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Detect external updates while editing
  useEffect(() => {
    if (isEditing) {
      if (nodeData.content !== syncedContent) {
        setHasConflict(true);
      }
    } else {
      setSyncedContent(nodeData.content);
    }
  }, [nodeData.content, isEditing, syncedContent]);

  const handleStartEdit = () => {
    setDraft(nodeData.content || "");
    setSyncedContent(nodeData.content || "");
    setHasConflict(false);
    setSaveError(null);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setHasConflict(false);
    setSaveError(null);
  };

  const handleReloadExternal = () => {
    setDraft(nodeData.content || "");
    setSyncedContent(nodeData.content || "");
    setHasConflict(false);
  };

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await window.sinapse?.notes?.write({
        name: nodeData.name,
        content: draft,
      });
      setSyncedContent(draft);
      setIsEditing(false);
      setHasConflict(false);
    } catch (err: any) {
      console.error("Erro ao salvar nota:", err);
      setSaveError(err?.message || "Erro ao salvar nota");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    const title = nodeData.title || nodeData.name;
    const ok = window.confirm(`Excluir a nota "${title}"?`);
    if (!ok) return;

    try {
      await window.sinapse?.notes?.delete(nodeData.name);
    } catch (err) {
      console.error("Erro ao excluir nota:", err);
    }
  };

  const formattedDate = nodeData.updatedAt
    ? new Date(nodeData.updatedAt).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";

  return (
    <div className="note-node-card">
      <div className="note-node-header">
        <div className="note-header-info">
          <span className="note-title" title={nodeData.title || nodeData.name}>
            {nodeData.title || nodeData.name}
          </span>
          {formattedDate && <span className="note-time">{formattedDate}</span>}
        </div>
        <div className="note-actions">
          {!isEditing ? (
            <>
              <button
                type="button"
                onClick={handleStartEdit}
                className="note-btn-action"
                title="Editar nota"
              >
                Editar
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="note-btn-action note-btn-delete"
                title="Excluir nota"
              >
                Excluir
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="note-btn-action note-btn-save"
                title="Salvar alterações"
              >
                {isSaving ? "Salvando..." : "Salvar"}
              </button>
              <button
                type="button"
                onClick={handleCancelEdit}
                className="note-btn-action"
                title="Cancelar edição"
              >
                Cancelar
              </button>
            </>
          )}
        </div>
      </div>

      {hasConflict && isEditing && (
        <div className="note-conflict-banner">
          <span>Alterada fora daqui</span>
          <button
            type="button"
            onClick={handleReloadExternal}
            className="note-btn-reload"
          >
            Recarregar
          </button>
        </div>
      )}

      {saveError && <div className="note-error-banner">{saveError}</div>}

      {isEditing ? (
        <div className="note-editor-wrapper nodrag nowheel">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="note-editor-textarea"
            placeholder="Conteúdo em Markdown..."
            autoFocus
          />
        </div>
      ) : (
        <div className="note-body-wrapper nodrag nowheel">
          <div className="note-markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children, ...props }) => (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      if (href) {
                        window.sinapse?.app?.openExternal(href);
                      }
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
              {nodeData.content || "_Nota vazia_"}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
