import { useState, useCallback, useEffect, useRef, type FormEvent } from "react";
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

import { BrainNode } from "./nodes/BrainNode";
import { WorkerNode } from "./nodes/WorkerNode";
import { NoteNode } from "./nodes/NoteNode";
import { SynapseEdge } from "./edges/SynapseEdge";
import { HeaderBar } from "./components/HeaderBar";
import { ModelSelect } from "./components/ModelSelect";
import type { WorkerSpawnPayload } from "../shared/ipc";

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
    data: { label: "Brain", anyThinking: false },
  },
];

const initialEdges: Edge[] = [];

const NOTE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

  const [daemonConnected, setDaemonConnected] = useState(false);

  // Worker spawn toolbar state
  const [isWorkerToolbarOpen, setIsWorkerToolbarOpen] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"claude" | "agy">("claude");
  const [role, setRole] = useState("");
  const [spawnModel, setSpawnModel] = useState<string | null>(null);
  const [isSpawning, setIsSpawning] = useState(false);
  const [workerErrorMessage, setWorkerErrorMessage] = useState<string | null>(null);

  // Note creation toolbar state
  const [isNoteToolbarOpen, setIsNoteToolbarOpen] = useState(false);
  const [newNoteName, setNewNoteName] = useState("");
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [noteErrorMessage, setNoteErrorMessage] = useState<string | null>(null);

  // Per-agent state tracking: status, log string, lastPrompt
  const agentStateMapRef = useRef<
    Map<string, { status: AgentStatus; log: string; lastPrompt: string }>
  >(new Map());

  // Track active pulse timers per edge
  const edgeTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

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

          const nodeId = `worker-${event.agentName}`;
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

          const nodeId = `worker-${event.agentName}`;
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
          const st = agentStateMapRef.current.get(event.agentName) || {
            status: event.status,
            log: "",
            lastPrompt: "",
          };
          st.status = event.status;
          agentStateMapRef.current.set(event.agentName, st);

          const nodeId = `worker-${event.agentName}`;
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

  const handleSpawn = async (e: FormEvent) => {
    e.preventDefault();
    const workerName = name.trim();
    if (!workerName || isSpawning) return;

    setIsSpawning(true);
    setWorkerErrorMessage(null);

    try {
      const payload: WorkerSpawnPayload = {
        name: workerName,
        provider,
        cwd: "",
        role: role.trim() || "Agente worker",
        autonomy: "edit" as const,
        ...(spawnModel ? { model: spawnModel } : {}),
      };

      await window.sinapse?.workers?.spawn(payload);

      setName("");
      setRole("");
      setSpawnModel(null);
      setIsWorkerToolbarOpen(false);
    } catch (err: any) {
      console.error("Erro ao criar worker:", err);
      setWorkerErrorMessage(err?.message || "Erro ao criar worker");
    } finally {
      setIsSpawning(false);
    }
  };

  const handleCreateNote = async (e: FormEvent) => {
    e.preventDefault();
    const raw = newNoteName.toLowerCase().trim();
    if (!raw || isCreatingNote) return;

    if (!NOTE_NAME_REGEX.test(raw)) {
      setNoteErrorMessage(
        "Nome inválido. Use 1 a 64 caracteres: letras minúsculas, números, - ou _, começando por letra ou número."
      );
      return;
    }

    setIsCreatingNote(true);
    setNoteErrorMessage(null);

    try {
      await window.sinapse?.notes?.write({
        name: raw,
        content: `# ${raw}\n\n`,
      });
      setNewNoteName("");
      setIsNoteToolbarOpen(false);
    } catch (err: any) {
      console.error("Erro ao criar nota:", err);
      setNoteErrorMessage(err?.message || "Erro ao criar nota");
    } finally {
      setIsCreatingNote(false);
    }
  };

  const activeCount = nodes.filter(
    (n) => n.type === "worker" && n.data?.status === "thinking"
  ).length;

  const workerCount = nodes.filter((n) => n.type === "worker").length;
  const noteCount = nodes.filter((n) => n.type === "note").length;

  return (
    <div className="canvas-container">
      {/* Top-left Header Bar */}
      <HeaderBar connected={daemonConnected} activeCount={activeCount} />

      {/* Floating Toolbar at Top-Right */}
      <div className="spawn-toolbar-container">
        <div className="toolbar-pills-row">
          <button
            type="button"
            onClick={() => {
              setIsWorkerToolbarOpen(!isWorkerToolbarOpen);
              setIsNoteToolbarOpen(false);
            }}
            className={`toolbar-pill-btn ${isWorkerToolbarOpen ? "pill-active" : ""}`}
          >
            <span className="pill-plus">+</span> worker
          </button>
          <button
            type="button"
            onClick={() => {
              setIsNoteToolbarOpen(!isNoteToolbarOpen);
              setIsWorkerToolbarOpen(false);
            }}
            className={`toolbar-pill-btn ${isNoteToolbarOpen ? "pill-active" : ""}`}
          >
            <span className="pill-plus">+</span> nota
          </button>
        </div>

        {/* Worker Creation Panel */}
        {isWorkerToolbarOpen && (
          <div className="spawn-toolbar-panel">
            <div className="toolbar-header">
              <span className="toolbar-title">+ Novo Worker</span>
              <button
                type="button"
                onClick={() => setIsWorkerToolbarOpen(false)}
                className="toolbar-close-btn"
                title="Fechar"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSpawn} className="toolbar-form">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome do worker (ex: revisor)"
                className="toolbar-input"
                required
                autoFocus
              />

              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as "claude" | "agy");
                  setSpawnModel(null);
                }}
                className="toolbar-select"
              >
                <option value="claude">Claude</option>
                <option value="agy">AGY (Gemini 3.8 Flash)</option>
              </select>

              <ModelSelect
                provider={provider}
                value={spawnModel}
                onChange={(m) => setSpawnModel(m)}
                className="toolbar-model-select"
              />

              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Função (ex: Revisor de código)"
                className="toolbar-input"
              />

              <div className="toolbar-actions">
                <button
                  type="submit"
                  disabled={isSpawning || !name.trim()}
                  className="toolbar-spawn-btn"
                >
                  {isSpawning ? "Criando..." : "+ Criar"}
                </button>
              </div>
            </form>
            {workerErrorMessage && (
              <div className="toolbar-error">{workerErrorMessage}</div>
            )}
          </div>
        )}

        {/* Note Creation Panel */}
        {isNoteToolbarOpen && (
          <div className="spawn-toolbar-panel">
            <div className="toolbar-header">
              <span className="toolbar-title">+ Nova Nota</span>
              <button
                type="button"
                onClick={() => setIsNoteToolbarOpen(false)}
                className="toolbar-close-btn"
                title="Fechar"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateNote} className="toolbar-form">
              <input
                type="text"
                value={newNoteName}
                onChange={(e) => {
                  setNewNoteName(e.target.value.toLowerCase());
                  setNoteErrorMessage(null);
                }}
                placeholder="identificador-da-nota"
                className="toolbar-input"
                required
                autoFocus
              />
              <div className="toolbar-hint">
                Apenas letras minúsculas, números, - e _ (máx. 64)
              </div>
              <div className="toolbar-actions">
                <button
                  type="submit"
                  disabled={isCreatingNote || !newNoteName.trim()}
                  className="toolbar-spawn-btn"
                >
                  {isCreatingNote ? "Criando..." : "+ Criar"}
                </button>
              </div>
            </form>
            {noteErrorMessage && (
              <div className="toolbar-error">{noteErrorMessage}</div>
            )}
          </div>
        )}
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
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
  );
}
