import { useState, useEffect, useRef } from "react";
import type { Workspace } from "@sinapse/core";

export interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  thinkingCounts: Record<string, number>;
  onNewWorkspace: () => void;
}

function abbreviateFolder(folder: string): string {
  if (!folder) return "";
  return folder.replace(/^\/(home|Users)\/[^/]+/, "~");
}

export function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  thinkingCounts,
  onNewWorkspace,
}: WorkspaceSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  // Total items in dropdown: workspaces + "＋ Novo workspace"
  const totalItems = workspaces.length + 1;

  // Sync focused index to active workspace when opened
  useEffect(() => {
    if (isOpen) {
      setInlineError(null);
      const activeIdx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
      setFocusedIndex(activeIdx >= 0 ? activeIdx : 0);
    }
  }, [isOpen, workspaces, activeWorkspaceId]);

  // Outside click to close
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  const handleSelect = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) {
      setIsOpen(false);
      return;
    }
    setInlineError(null);
    try {
      await window.sinapse?.workspaces?.setActive(workspaceId);
      setIsOpen(false);
    } catch (err: any) {
      console.error("Erro ao ativar workspace:", err);
      setInlineError(err?.message || "Erro ao ativar workspace");
    }
  };

  const handleDelete = async (ws: Workspace, e: React.MouseEvent) => {
    e.stopPropagation();
    if (workspaces.length <= 1) return;

    const confirmed = window.confirm(
      `Apagar o workspace "${ws.name}"? Os workers dele são interrompidos e removidos, e as notas e a sessão do orquestrador são apagadas. A pasta do projeto (${ws.folder}) não é tocada.`
    );
    if (!confirmed) return;

    setInlineError(null);
    try {
      if (ws.id === activeWorkspaceId) {
        const nextWorkspace = workspaces.find((w) => w.id !== ws.id);
        if (nextWorkspace) {
          await window.sinapse?.workspaces?.setActive(nextWorkspace.id);
        }
      }
      await window.sinapse?.workspaces?.delete(ws.id);
    } catch (err: any) {
      console.error("Erro ao apagar workspace:", err);
      setInlineError(err?.message || "Erro ao apagar workspace");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev + 1) % totalItems);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev - 1 + totalItems) % totalItems);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIndex === workspaces.length) {
        setIsOpen(false);
        onNewWorkspace();
      } else if (workspaces[focusedIndex]) {
        handleSelect(workspaces[focusedIndex].id);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className="workspace-selector-container nodrag"
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className={`workspace-selector-btn ${isOpen ? "open" : ""}`}
        onClick={() => setIsOpen((prev) => !prev)}
        title={`Workspace ativo: ${activeWorkspace?.name || "Selecionar workspace"}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="workspace-selector-name">
          {activeWorkspace?.name || "Workspace"}
        </span>
        <span className="workspace-selector-arrow" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen && (
        <div className="workspace-dropdown" role="listbox">
          {inlineError && (
            <div className="workspace-dropdown-error" role="alert">
              {inlineError}
            </div>
          )}

          <div className="workspace-list-container">
            {workspaces.map((ws, idx) => {
              const isActive = ws.id === activeWorkspaceId;
              const isFocused = idx === focusedIndex;
              const thinkingCount = thinkingCounts[ws.id] || 0;
              const canDelete = workspaces.length > 1;

              return (
                <div
                  key={ws.id}
                  role="option"
                  aria-selected={isActive}
                  className={`workspace-row ${isActive ? "active" : ""} ${
                    isFocused ? "focused" : ""
                  }`}
                  onClick={() => handleSelect(ws.id)}
                  onMouseEnter={() => setFocusedIndex(idx)}
                >
                  <div className="workspace-row-left">
                    <span className="workspace-check-slot">
                      {isActive ? (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="workspace-check-icon"
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : null}
                    </span>

                    <div className="workspace-row-info">
                      <span className="workspace-row-name" title={ws.name}>
                        {ws.name}
                      </span>
                      <span
                        className="workspace-row-folder"
                        title={ws.folder}
                      >
                        {abbreviateFolder(ws.folder)}
                      </span>
                    </div>
                  </div>

                  <div className="workspace-row-actions">
                    {thinkingCount > 0 && (
                      <span
                        className="workspace-thinking-count"
                        title={`${thinkingCount} ${
                          thinkingCount === 1 ? "worker pensando" : "workers pensando"
                        }`}
                      >
                        {thinkingCount}
                      </span>
                    )}

                    {canDelete && (
                      <button
                        type="button"
                        onClick={(e) => handleDelete(ws, e)}
                        className="workspace-delete-btn"
                        title="Apagar workspace"
                        aria-label={`Apagar workspace ${ws.name}`}
                      >
                        <svg
                          width="12"
                          height="12"
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
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="workspace-divider" role="separator" />

          <button
            type="button"
            className={`workspace-new-btn ${
              focusedIndex === workspaces.length ? "focused" : ""
            }`}
            onClick={() => {
              setIsOpen(false);
              onNewWorkspace();
            }}
            onMouseEnter={() => setFocusedIndex(workspaces.length)}
          >
            <span className="workspace-new-plus">＋</span>
            <span>Novo workspace</span>
          </button>
        </div>
      )}
    </div>
  );
}
