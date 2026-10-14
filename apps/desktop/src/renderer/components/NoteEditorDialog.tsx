import { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";

export interface NoteEditorDialogProps {
  workspaceId: string;
  name: string;
  title?: string;
  content: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export function NoteEditorDialog({
  workspaceId,
  name,
  title,
  content,
  onClose,
  onSuccess,
}: NoteEditorDialogProps) {
  const initialContent = content ?? "";
  const [draft, setDraft] = useState(initialContent);
  const [syncedContent, setSyncedContent] = useState(initialContent);
  const [hasConflict, setHasConflict] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const syncedContentRef = useRef(syncedContent);
  syncedContentRef.current = syncedContent;
  const isSavingRef = useRef(isSaving);
  isSavingRef.current = isSaving;
  const contentRef = useRef(initialContent);
  contentRef.current = content ?? "";

  // Autofocus with cursor at the end
  useEffect(() => {
    const focusAtEnd = () => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const len = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(len, len);
      }
    };
    focusAtEnd();
    const raf = requestAnimationFrame(focusAtEnd);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Detect external updates via prop change
  useEffect(() => {
    if (content !== syncedContent) {
      setHasConflict(true);
    }
  }, [content, syncedContent]);

  // Detect external updates via daemon event
  useEffect(() => {
    const unsub = window.sinapse?.daemon?.onEvent((event: any) => {
      const kind = event.kind || event.type;
      if (
        (!event.workspaceId || event.workspaceId === workspaceId) &&
        kind === "note_changed" &&
        event.note?.name === name
      ) {
        if (!isSavingRef.current) {
          setHasConflict(true);
        }
      }
    });
    return () => {
      unsub?.();
    };
  }, [workspaceId, name]);

  const handleCancel = () => {
    if (draftRef.current !== syncedContentRef.current) {
      const ok = window.confirm("Descartar alterações?");
      if (!ok) return;
    }
    onClose();
  };

  const handleSave = async () => {
    if (isSavingRef.current) return;
    // Set synchronously: the render-time sync below would let a second Ctrl+S through.
    isSavingRef.current = true;
    setIsSaving(true);
    setSaveError(null);
    try {
      await window.sinapse?.notes?.write({
        workspaceId,
        name,
        content: draftRef.current,
      });
      onSuccess?.();
      onClose();
    } catch (err: any) {
      console.error("Erro ao salvar nota:", err);
      setSaveError(err?.message || "Erro ao salvar nota");
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleReloadExternal = async () => {
    try {
      const fullNote = await window.sinapse?.notes?.read(workspaceId, name);
      if (fullNote && typeof fullNote.content === "string") {
        setDraft(fullNote.content);
        setSyncedContent(fullNote.content);
      } else {
        setDraft(contentRef.current);
        setSyncedContent(contentRef.current);
      }
    } catch (err) {
      console.error("Erro ao recarregar nota:", err);
      setDraft(contentRef.current);
      setSyncedContent(contentRef.current);
    }
    setHasConflict(false);
    setSaveError(null);
  };

  // Keyboard shortcuts: Escape cancels, Ctrl+S / Cmd+S saves
  useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;

      const nextVal = val.substring(0, start) + "  " + val.substring(end);
      setDraft(nextVal);

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = start + 2;
          textareaRef.current.selectionEnd = start + 2;
        }
      });
    }
    // Ctrl+S and Escape bubble up to the window listener; handling them here too would fire twice.
  };

  const displayTitle = title && title.trim() ? title : name;

  return ReactDOM.createPortal(
    <div
      className="dialog-backdrop nodrag nowheel"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div
        className="dialog-modal note-editor-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header note-editor-dialog-header">
          <div className="note-editor-dialog-titles">
            <h2 className="dialog-title" title={displayTitle}>
              {displayTitle}
            </h2>
            <span className="note-editor-dialog-name" title={name}>
              {name}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="dialog-close-btn"
            title="Fechar"
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>

        {hasConflict && (
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

        {saveError && <div className="dialog-error">{saveError}</div>}

        <div className="note-editor-dialog-body">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            className="note-editor-dialog-textarea"
            placeholder="Conteúdo em Markdown..."
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            autoFocus
          />
        </div>

        <div className="dialog-actions note-editor-dialog-actions">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSaving}
            className="dialog-btn dialog-btn-secondary"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="dialog-btn dialog-btn-primary"
          >
            {isSaving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
