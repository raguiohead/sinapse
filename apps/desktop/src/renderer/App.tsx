import { useState, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DaemonEvent, AgentStatus } from "@sinapse/core";
import type { DesktopSettings } from "../shared/ipc";

import { BrainNode } from "./nodes/BrainNode";
import { WorkerNode } from "./nodes/WorkerNode";
import { NoteNode } from "./nodes/NoteNode";
import { SynapseEdge } from "./edges/SynapseEdge";
import { TitleBar } from "./components/TitleBar";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { NewWorkerDialog } from "./components/NewWorkerDialog";
import { NewNoteDialog } from "./components/NewNoteDialog";
import { SettingsScreen } from "./components/SettingsScreen";
import type { WorkerNodeData } from "./nodes/WorkerNode";

const nodeTypes = {
  brain: BrainNode,
  worker: WorkerNode,
  note: NoteNode,
};

const edgeTypes = {
  synapse: SynapseEdge,
};

const initialNodes: Node[] = [
  {
    id: "brain",
    type: "brain",
    position: { x: 100, y: 200 },
    width: 680,
    height: 460,
    data: { label: "Brain", anyThinking: false },
  },
];

const initialEdges: Edge[] = [];

function AutoFit({
  workerCount,
  noteCount,
}: {
  workerCount: number;
  noteCount: number;
}) {
  const { fitView } = useReactFlow();
  const measured = useNodesInitialized();
  useEffect(() => {
    if (!measured) return;
    const timer = setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
    return () => clearTimeout(timer);
  }, [measured, workerCount, noteCount, fitView]);
  return null;
}

function nextWorkerPosition(nodes: Node[]): { x: number; y: number } {
  const brain = nodes.find((n) => n.id === "brain");
  const brainX = brain?.position.x ?? 100;
  const brainY = brain?.position.y ?? 200;
  const brainWidth = brain?.measured?.width ?? 720;
  const workers = nodes.filter((n) => n.type === "worker");
  const workerWidth = workers[0]?.measured?.width ?? 320;
  const workerHeight = Math.max(...workers.map((w) => w.measured?.height ?? 440), 440);
  const index = workers.length;
  const column = Math.floor(index / 3);
  const row = index % 3;
  return {
    x: brainX + brainWidth + 160 + column * (workerWidth + 80),
    y: brainY + row * (workerHeight + 60),
  };
}

function extractToolName(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed.name ||
      parsed.tool_name ||
      parsed.tool ||
      parsed.call?.name ||
      parsed.call?.tool_name ||
      "ferramenta"
    );
  } catch {
    return raw.slice(0, 30) || "ferramenta";
  }
}

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const [daemonConnected, setDaemonConnected] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);

  // Modals and context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items?: ContextMenuItem[];
  } | null>(null);
  const [isNewWorkerDialogOpen, setIsNewWorkerDialogOpen] = useState(false);
  const [isNewNoteDialogOpen, setIsNewNoteDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Per-agent state tracking: status, log string, lastPrompt
  const agentStateMapRef = useRef<
    Map<string, { status: AgentStatus; log: string; lastPrompt: string }>
  >(new Map());

  // Track active pulse timers per edge
  const edgeTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const deleteWorker = useCallback(
    async (workerName: string, status?: AgentStatus) => {
      const message =
        status === "thinking"
          ? `Excluir o worker "${workerName}"? O turno em andamento será interrompido e a sessão dele será perdida.`
          : `Excluir o worker "${workerName}"? A sessão dele será perdida.`;
      if (!window.confirm(message)) return;

      try {
        await window.sinapse?.workers?.delete(workerName);
      } catch (err: any) {
        console.error("Erro ao excluir worker:", err);
        const errorMsg = err?.message || "Falha ao excluir worker";
        setNodes((nds) =>
          nds.map((n) =>
            n.id === `worker-${workerName}`
              ? { ...n, data: { ...n.data, deleteError: errorMsg } }
              : n
          )
        );
      }
    },
    [setNodes]
  );

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault();
      e.stopPropagation();
      if (node.type !== "worker") {
        setContextMenu(null);
        return;
      }

      const data = node.data as unknown as WorkerNodeData;
      const workerName = data.name;
      const status = data.status;

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            type: "action",
            label: "Excluir worker",
            danger: true,
            icon: (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            ),
            action: () => {
              deleteWorker(workerName, status);
            },
          },
        ],
      });
    },
    [deleteWorker]
  );

  // Load settings once and apply motion dataset
  useEffect(() => {
    window.sinapse?.settings?.get().then((s) => {
      if (s) {
        setSettings(s);
        if (s.appearance?.motion) {
          document.documentElement.dataset.motion = s.appearance.motion;
        }
      }
    });

    const unsub = window.sinapse?.settings?.onChanged((s) => {
      if (s) {
        setSettings(s);
        if (s.appearance?.motion) {
          document.documentElement.dataset.motion = s.appearance.motion;
        }
      }
    });

    return () => {
      if (unsub) unsub();
    };
  }, []);

  // Global shortcut Ctrl+, (or Cmd+, on Mac) to open settings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setIsSettingsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "synapse",
            data: { pulse: "idle", provider: "claude" },
          },
          eds
        )
      );
    },
    [setEdges]
  );

  const syncExistingWorkers = useCallback(async () => {
    try {
      const workerList = await window.sinapse?.workers?.list();
      if (!Array.isArray(workerList)) return;

      setNodes((currentNodes) => {
        const nextNodes = [...currentNodes];
        for (const worker of workerList) {
          const nodeId = `worker-${worker.name}`;
          if (!agentStateMapRef.current.has(worker.name)) {
            agentStateMapRef.current.set(worker.name, {
              status: worker.status || "idle",
              log: "",
              lastPrompt: "",
            });
          }
          const st = agentStateMapRef.current.get(worker.name)!;

          const idx = nextNodes.findIndex((n) => n.id === nodeId);
          if (idx === -1) {
            nextNodes.push({
              id: nodeId,
              type: "worker",
              position: nextWorkerPosition(nextNodes),
              width: 330,
              height: 420,
              data: {
                name: worker.name,
                provider: worker.provider,
                role: worker.role,
                status: worker.status || st.status || "idle",
                model: worker.model,
                usage: worker.usage,
                log: st.log,
                lastPrompt: st.lastPrompt,
              },
            });
          } else {
            nextNodes[idx] = {
              ...nextNodes[idx],
              data: {
                ...nextNodes[idx].data,
                role: worker.role ?? nextNodes[idx].data.role,
                status: worker.status ?? nextNodes[idx].data.status,
                model: worker.model ?? nextNodes[idx].data.model,
                usage: worker.usage ?? nextNodes[idx].data.usage,
              },
            };
          }
        }
        return nextNodes;
      });

      setEdges((currentEdges) => {
        let nextEdges = [...currentEdges];
        for (const worker of workerList) {
          const nodeId = `worker-${worker.name}`;
          const edgeId = `edge-brain-${nodeId}`;
          if (
            !nextEdges.some(
              (e) => e.id === edgeId || (e.source === "brain" && e.target === nodeId)
            )
          ) {
            nextEdges = addEdge(
              {
                id: edgeId,
                source: "brain",
                target: nodeId,
                type: "synapse",
                data: { pulse: "idle", provider: worker.provider },
              },
              nextEdges
            );
          }
        }
        return nextEdges;
      });
    } catch (err) {
      console.log("Could not sync workers initially:", err);
    }
  }, [setNodes, setEdges]);

  const syncNotes = useCallback(async () => {
    try {
      const summaries = await window.sinapse?.notes?.list();
      if (!Array.isArray(summaries)) return;

      const fullNotes = await Promise.all(
        summaries.map(async (s) => {
          try {
            return await window.sinapse?.notes?.read(s.name);
          } catch {
            return {
              name: s.name,
              title: s.title,
              content: "",
              updatedAt: s.updatedAt,
            };
          }
        })
      );

      setNodes((currentNodes) => {
        const brain = currentNodes.find((n) => n.id === "brain");
        const brainX = brain?.position.x ?? 100;
        const brainY = brain?.position.y ?? 200;
        const brainHeight = brain?.measured?.height ?? 440;

        const nonNotes = currentNodes.filter((n) => n.type !== "note");
        const noteNodes: Node[] = fullNotes.map((n, i) => ({
          id: `note-${n.name}`,
          type: "note",
          position: {
            x: brainX + i * 400,
            y: brainY + brainHeight + 120,
          },
          width: 360,
          height: 420,
          data: {
            name: n.name,
            title: n.title,
            content: n.content,
            updatedAt: n.updatedAt,
          },
        }));

        return [...nonNotes, ...noteNodes];
      });
    } catch (err) {
      console.log("Could not sync notes initially:", err);
    }
  }, [setNodes]);

  // Handle incoming DaemonEvents from the bus
  const handleDaemonEvent = useCallback(
    (event: DaemonEvent) => {
      switch (event.kind) {
        case "agent_spawned": {
          const agent = event.agent;
          const nodeId = `worker-${agent.name}`;
          const edgeId = `edge-brain-${nodeId}`;

          if (!agentStateMapRef.current.has(agent.name)) {
            agentStateMapRef.current.set(agent.name, {
              status: agent.status || "idle",
              log: "",
              lastPrompt: "",
            });
          }

          setNodes((nds) => {
            if (nds.some((n) => n.id === nodeId)) return nds;
            return [
              ...nds,
              {
                id: nodeId,
                type: "worker",
                position: nextWorkerPosition(nds),
                width: 330,
                height: 420,
                data: {
                  name: agent.name,
                  provider: agent.provider,
                  role: agent.role,
                  status: agent.status || "idle",
                  model: agent.model,
                  usage: agent.usage,
                  log: "",
                  lastPrompt: "",
                },
              },
            ];
          });

          setEdges((eds) => {
            if (
              eds.some(
                (e) => e.id === edgeId || (e.source === "brain" && e.target === nodeId)
              )
            ) {
              return eds;
            }
            return addEdge(
              {
                id: edgeId,
                source: "brain",
                target: nodeId,
                type: "synapse",
                data: { pulse: "idle", provider: agent.provider },
              },
              eds
            );
          });
          break;
        }

        case "agent_updated": {
          const agent = event.agent;
          const nodeId = `worker-${agent.name}`;
          if (!nodesRef.current.some((n) => n.id === nodeId)) return;

          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      role: agent.role,
                      model: agent.model,
                      usage: agent.usage ?? n.data?.usage,
                      status: agent.status || n.data?.status,
                    },
                  }
                : n
            )
          );
          break;
        }

        case "turn_started": {
          const nodeId = `worker-${event.agentName}`;
          if (!nodesRef.current.some((n) => n.id === nodeId)) return;

          const st = agentStateMapRef.current.get(event.agentName) || {
            status: "idle",
            log: "",
            lastPrompt: "",
          };
          st.status = "thinking";
          st.lastPrompt = event.prompt;
          const promptHeader = st.log ? `\n> ${event.prompt}\n` : `> ${event.prompt}\n`;
          st.log = (st.log + promptHeader).slice(-20_000);
          agentStateMapRef.current.set(event.agentName, st);

          const edgeId = `edge-brain-${nodeId}`;

          const existingTimer = edgeTimersRef.current.get(edgeId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            edgeTimersRef.current.delete(edgeId);
          }

          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      status: "thinking",
                      log: st.log,
                      lastPrompt: st.lastPrompt,
                    },
                  }
                : n
            )
          );

          setEdges((eds) =>
            eds.map((e) =>
              e.id === edgeId || (e.source === "brain" && e.target === nodeId)
                ? { ...e, data: { ...e.data, pulse: "out" } }
                : e
            )
          );
          break;
        }

        case "turn_event": {
          const nodeId = `worker-${event.agentName}`;
          if (!nodesRef.current.some((n) => n.id === nodeId)) return;

          const st = agentStateMapRef.current.get(event.agentName) || {
            status: "thinking",
            log: "",
            lastPrompt: "",
          };

          if (event.event.type === "text") {
            st.log = (st.log + event.event.data).slice(-20_000);
          } else if (event.event.type === "tool_use") {
            const toolName = extractToolName(event.event.data);
            st.log = (st.log + `⚙ ${toolName}\n`).slice(-20_000);
          }
          agentStateMapRef.current.set(event.agentName, st);

          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      log: st.log,
                    },
                  }
                : n
            )
          );
          break;
        }

        case "turn_finished": {
          const nodeId = `worker-${event.agentName}`;
          if (!nodesRef.current.some((n) => n.id === nodeId)) return;

          const st = agentStateMapRef.current.get(event.agentName) || {
            status: event.status,
            log: "",
            lastPrompt: "",
          };
          st.status = event.status;
          agentStateMapRef.current.set(event.agentName, st);

          const edgeId = `edge-brain-${nodeId}`;

          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      status: event.status,
                      ...(event.usage ? { usage: event.usage } : {}),
                    },
                  }
                : n
            )
          );

          const existingTimer = edgeTimersRef.current.get(edgeId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            edgeTimersRef.current.delete(edgeId);
          }

          setEdges((eds) =>
            eds.map((e) =>
              e.id === edgeId || (e.source === "brain" && e.target === nodeId)
                ? { ...e, data: { ...e.data, pulse: "back" } }
                : e
            )
          );

          const backTimer = setTimeout(() => {
            setEdges((eds) =>
              eds.map((e) =>
                e.id === edgeId || (e.source === "brain" && e.target === nodeId)
                  ? { ...e, data: { ...e.data, pulse: "idle" } }
                  : e
              )
            );
            edgeTimersRef.current.delete(edgeId);
          }, 1500);

          edgeTimersRef.current.set(edgeId, backTimer);
          break;
        }

        case "agent_deleted": {
          const nodeId = `worker-${event.agentName}`;
          const edgeId = `edge-brain-${nodeId}`;

          const existingTimer = edgeTimersRef.current.get(edgeId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            edgeTimersRef.current.delete(edgeId);
          }

          agentStateMapRef.current.delete(event.agentName);

          setNodes((nds) => nds.filter((n) => n.id !== nodeId));
          setEdges((eds) =>
            eds.filter((e) => e.target !== nodeId && e.source !== nodeId && e.id !== edgeId)
          );
          break;
        }

        case "note_changed": {
          const noteSummary = event.note;
          window.sinapse?.notes
            ?.read(noteSummary.name)
            .then((fullNote) => {
              setNodes((nds) => {
                const nodeId = `note-${fullNote.name}`;
                const exists = nds.some((n) => n.id === nodeId);
                if (exists) {
                  return nds.map((n) =>
                    n.id === nodeId
                      ? {
                          ...n,
                          data: {
                            ...n.data,
                            title: fullNote.title,
                            content: fullNote.content,
                            updatedAt: fullNote.updatedAt,
                          },
                        }
                      : n
                  );
                } else {
                  const currentNotes = nds.filter((n) => n.type === "note");
                  const brain = nds.find((n) => n.id === "brain");
                  const brainX = brain?.position.x ?? 100;
                  const brainY = brain?.position.y ?? 200;
                  const brainHeight = brain?.measured?.height ?? 440;
                  return [
                    ...nds,
                    {
                      id: nodeId,
                      type: "note",
                      position: {
                        x: brainX + currentNotes.length * 400,
                        y: brainY + brainHeight + 120,
                      },
                      width: 360,
                      height: 420,
                      data: {
                        name: fullNote.name,
                        title: fullNote.title,
                        content: fullNote.content,
                        updatedAt: fullNote.updatedAt,
                      },
                    },
                  ];
                }
              });
            })
            .catch((err) => console.error("Erro ao ler nota atualizada:", err));
          break;
        }

        case "note_deleted": {
          const deletedName = event.name;
          setNodes((nds) => {
            const remaining = nds.filter((n) => n.id !== `note-${deletedName}`);
            const brain = remaining.find((n) => n.id === "brain");
            const brainX = brain?.position.x ?? 100;
            const brainY = brain?.position.y ?? 200;
            const brainHeight = brain?.measured?.height ?? 440;

            let noteIdx = 0;
            return remaining.map((n) => {
              if (n.type === "note") {
                const pos = {
                  x: brainX + noteIdx * 400,
                  y: brainY + brainHeight + 120,
                };
                noteIdx++;
                return { ...n, position: pos };
              }
              return n;
            });
          });
          break;
        }
      }
    },
    [setNodes, setEdges]
  );

  // Sync anyThinking to brain node data
  useEffect(() => {
    const anyThinking = nodes.some(
      (n) => n.type === "worker" && n.data?.status === "thinking"
    );

    setNodes((current) => {
      const brainNode = current.find((n) => n.id === "brain");
      if (brainNode && brainNode.data?.anyThinking !== anyThinking) {
        return current.map((n) =>
          n.id === "brain"
            ? { ...n, data: { ...n.data, anyThinking } }
            : n
        );
      }
      return current;
    });
  }, [nodes, setNodes]);

  // Initial sync & event bus subscriptions
  useEffect(() => {
    syncExistingWorkers();
    syncNotes();

    const unsubInfo = window.sinapse?.daemon?.onInfo(() => {
      syncExistingWorkers();
      syncNotes();
    });

    const unsubStatus = window.sinapse?.daemon?.onStatus((status) => {
      setDaemonConnected(status.connected);
      if (status.connected) {
        syncExistingWorkers();
        syncNotes();
      }
    });

    const unsubEvent = window.sinapse?.daemon?.onEvent((event: DaemonEvent) => {
      handleDaemonEvent(event);
    });

    return () => {
      if (unsubInfo) unsubInfo();
      if (unsubStatus) unsubStatus();
      if (unsubEvent) unsubEvent();

      for (const timer of edgeTimersRef.current.values()) {
        clearTimeout(timer);
      }
      edgeTimersRef.current.clear();
    };
  }, [syncExistingWorkers, syncNotes, handleDaemonEvent]);

  const handlePaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const activeCount = nodes.filter(
    (n) => n.type === "worker" && n.data?.status === "thinking"
  ).length;

  const workerCount = nodes.filter((n) => n.type === "worker").length;
  const noteCount = nodes.filter((n) => n.type === "note").length;

  return (
    <div className="canvas-container">
      {/* Top 40px Chromatic Title Bar */}
      <TitleBar
        connected={daemonConnected}
        activeCount={activeCount}
        onOpenSettings={() => setIsSettingsOpen(true)}
        chromaticBar={settings?.appearance?.chromaticBar ?? "animada"}
      />

      {/* ReactFlow Canvas container takes remaining viewport below title bar */}
      <div className="flow-canvas-wrapper">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneContextMenu={handlePaneContextMenu}
          onNodeContextMenu={handleNodeContextMenu}
          onPaneClick={() => setContextMenu(null)}
          onMoveStart={() => setContextMenu(null)}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background color="#151a28" gap={22} size={1.5} />
          <Controls className="flow-controls" />
          <AutoFit workerCount={workerCount} noteCount={noteCount} />
        </ReactFlow>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
          onNewWorker={() => setIsNewWorkerDialogOpen(true)}
          onNewNote={() => setIsNewNoteDialogOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />
      )}

      {/* New Worker Dialog */}
      {isNewWorkerDialogOpen && (
        <NewWorkerDialog
          defaults={settings?.workerDefaults}
          onClose={() => setIsNewWorkerDialogOpen(false)}
        />
      )}

      {/* New Note Dialog */}
      {isNewNoteDialogOpen && (
        <NewNoteDialog
          onClose={() => setIsNewNoteDialogOpen(false)}
        />
      )}

      {/* Settings Screen */}
      {isSettingsOpen && (
        <SettingsScreen
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </div>
  );
}
