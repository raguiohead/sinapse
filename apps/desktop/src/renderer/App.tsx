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
import { SynapseEdge } from "./edges/SynapseEdge";
import { HeaderBar } from "./components/HeaderBar";

const nodeTypes = {
  brain: BrainNode,
  worker: WorkerNode,
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

function AutoFit({ workerCount }: { workerCount: number }) {
  const { fitView } = useReactFlow();
  const measured = useNodesInitialized();
  useEffect(() => {
    if (!measured) return;
    const timer = setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
    return () => clearTimeout(timer);
  }, [measured, workerCount, fitView]);
  return null;
}

function nextWorkerPosition(nodes: Node[]): { x: number; y: number } {
  const brain = nodes.find((n) => n.id === "brain");
  const brainX = brain?.position.x ?? 100;
  const brainY = brain?.position.y ?? 200;
  const brainWidth = brain?.measured?.width ?? 720;
  const workers = nodes.filter((n) => n.type === "worker");
  const workerWidth = workers[0]?.measured?.width ?? 320;
  const index = workers.length;
  const column = Math.floor(index / 3);
  const row = index % 3;
  return {
    x: brainX + brainWidth + 160 + column * (workerWidth + 80),
    y: brainY + row * 420,
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
  const [isToolbarOpen, setIsToolbarOpen] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"claude" | "agy">("claude");
  const [role, setRole] = useState("");
  const [isSpawning, setIsSpawning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Per-agent state tracking: status, log string (capped at 20_000 chars), lastPrompt
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

          if (!nextNodes.some((n) => n.id === nodeId)) {
            nextNodes.push({
              id: nodeId,
              type: "worker",
              position: nextWorkerPosition(nextNodes),
              data: {
                name: worker.name,
                provider: worker.provider,
                role: worker.role,
                status: worker.status || st.status || "idle",
                log: st.log,
                lastPrompt: st.lastPrompt,
              },
            });
          } else {
            const idx = nextNodes.findIndex((n) => n.id === nodeId);
            if (idx >= 0 && worker.status && nextNodes[idx].data.status !== worker.status) {
              nextNodes[idx] = {
                ...nextNodes[idx],
                data: {
                  ...nextNodes[idx].data,
                  status: worker.status,
                },
              };
            }
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

          // Cancel any scheduled idle timer for this edge
          const existingTimer = edgeTimersRef.current.get(edgeId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            edgeTimersRef.current.delete(edgeId);
          }

          // Update worker node data
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

          // Edge pulse = "out"
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

          // Update worker node status
          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      status: event.status,
                    },
                  }
                : n
            )
          );

          // Clear any existing timer
          const existingTimer = edgeTimersRef.current.get(edgeId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            edgeTimersRef.current.delete(edgeId);
          }

          // Set edge pulse = "back" for 1500ms, then "idle"
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

    const unsubInfo = window.sinapse?.daemon?.onInfo(() => {
      syncExistingWorkers();
    });

    const unsubStatus = window.sinapse?.daemon?.onStatus((status) => {
      setDaemonConnected(status.connected);
      if (status.connected) {
        syncExistingWorkers();
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
  }, [syncExistingWorkers, handleDaemonEvent]);

  const handleSpawn = async (e: FormEvent) => {
    e.preventDefault();
    const workerName = name.trim();
    if (!workerName || isSpawning) return;

    setIsSpawning(true);
    setErrorMessage(null);

    try {
      const payload = {
        name: workerName,
        provider,
        cwd: "", // Main process resolves this to user's home directory
        role: role.trim() || "Agente worker",
        autonomy: "edit" as const,
      };

      await window.sinapse?.workers?.spawn(payload);

      setName("");
      setRole("");
      setIsToolbarOpen(false);
    } catch (err: any) {
      console.error("Erro ao criar worker:", err);
      setErrorMessage(err?.message || "Erro ao criar worker");
    } finally {
      setIsSpawning(false);
    }
  };

  const activeCount = nodes.filter(
    (n) => n.type === "worker" && n.data?.status === "thinking"
  ).length;

  const workerCount = nodes.filter((n) => n.type === "worker").length;

  return (
    <div className="canvas-container">
      {/* Top-left Header Bar */}
      <HeaderBar connected={daemonConnected} activeCount={activeCount} />

      {/* Floating Collapsible Spawn Toolbar at Top-Right */}
      <div className="spawn-toolbar-container">
        {!isToolbarOpen ? (
          <button
            type="button"
            onClick={() => setIsToolbarOpen(true)}
            className="toolbar-pill-btn"
          >
            <span className="pill-plus">+</span> worker
          </button>
        ) : (
          <div className="spawn-toolbar-panel">
            <div className="toolbar-header">
              <span className="toolbar-title">+ Novo Worker</span>
              <button
                type="button"
                onClick={() => setIsToolbarOpen(false)}
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
                onChange={(e) => setProvider(e.target.value as "claude" | "agy")}
                className="toolbar-select"
              >
                <option value="claude">Claude</option>
                <option value="agy">AGY (Gemini 3.8 Flash)</option>
              </select>

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
            {errorMessage && <div className="toolbar-error">{errorMessage}</div>}
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
        <AutoFit workerCount={workerCount} />
      </ReactFlow>
    </div>
  );
}
