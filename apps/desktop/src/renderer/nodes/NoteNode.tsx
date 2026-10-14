import { useState } from "react";
import { Handle, Position, NodeResizeControl, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { NoteEditorDialog } from "../components/NoteEditorDialog";

export interface NoteNodeData {
  workspaceId: string;
  name: string;
  title: string;
  content: string;
  updatedAt: number;
  createdBy?: string;
  contributors?: string[];
}

export function NoteNode({ data }: NodeProps) {
  const nodeData = (data ?? {}) as unknown as NoteNodeData;

  const [isEditorOpen, setIsEditorOpen] = useState(false);

  const handleDelete = async () => {
    const title = nodeData.title || nodeData.name;
    const ok = window.confirm(`Excluir a nota "${title}"?`);
    if (!ok) return;

    try {
      await window.sinapse?.notes?.delete(nodeData.workspaceId, nodeData.name);
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
      <Handle
        type="target"
        position={Position.Top}
        id="note-target"
        className="flow-handle note-handle-target"
      />
      <div className="note-node-header">
        <div className="note-header-info">
          <span className="note-title" title={nodeData.title || nodeData.name}>
            {nodeData.title || nodeData.name}
          </span>
          {formattedDate && <span className="note-time">{formattedDate}</span>}
        </div>
        <div className="note-actions">
          <button
            type="button"
            onClick={() => setIsEditorOpen(true)}
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
        </div>
      </div>

      <div
        className="note-body-wrapper nodrag nowheel"
        onDoubleClick={() => setIsEditorOpen(true)}
      >
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

      {isEditorOpen && (
        <NoteEditorDialog
          workspaceId={nodeData.workspaceId}
          name={nodeData.name}
          title={nodeData.title}
          content={nodeData.content || ""}
          onClose={() => setIsEditorOpen(false)}
        />
      )}

      <NodeResizeControl
        position="bottom-right"
        minWidth={260}
        minHeight={220}
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

