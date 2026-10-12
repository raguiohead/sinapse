import { useState, useCallback, useEffect, type FormEvent } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { BrainNode } from "./nodes/BrainNode";
import { WorkerNode } from "./nodes/WorkerNode";

const nodeTypes = {
  brain: BrainNode,
  worker: WorkerNode,
};

const initialNodes: Node[] = [
  {
    id: "brain",
    type: "brain",
    position: { x: 100, y: 200 },
    data: { label: "Brain" },
  },
];

const initialEdges: Edge[] = [];

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"claude" | "agy">("claude");
  const [role, setRole] = useState("");
  const [isSpawning, setIsSpawning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            animated: true,
            style: { stroke: "#6366f1", strokeWidth: 2 },
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
      if (!Array.isArray(workerList) || workerList.length === 0) return;

      setNodes((currentNodes) => {
        const nextNodes = [...currentNodes];
        for (const worker of workerList) {
          const nodeId = `worker-${worker.name}`;
          if (!nextNodes.some((n) => n.id === nodeId)) {
            const rightmostX = nextNodes.reduce((max, n) => {
              const width = n.type === "brain" ? 640 : 320;
              return Math.max(max, n.position.x + width);
            }, 100);

            nextNodes.push({
              id: nodeId,
              type: "worker",
              position: { x: rightmostX + 60, y: 200 },
              data: {
                name: worker.name,
                provider: worker.provider,
                role: worker.role,
                status: worker.status || "idle",
              },
            });
          }
        }
        return nextNodes;
      });

      setEdges((currentEdges) => {
        let nextEdges = [...currentEdges];
        for (const worker of workerList) {
          const nodeId = `worker-${worker.name}`;
          const edgeId = `edge-brain-${nodeId}`;
          if (!nextEdges.some((e) => e.id === edgeId || (e.source === "brain" && e.target === nodeId))) {
            nextEdges = addEdge(
              {
                id: edgeId,
                source: "brain",
                target: nodeId,
                animated: true,
                style: { stroke: "#6366f1", strokeWidth: 2 },
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

  useEffect(() => {
    syncExistingWorkers();
    window.sinapse?.daemon?.onInfo(() => {
      syncExistingWorkers();
    });
  }, [syncExistingWorkers]);

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
        cwd: ".",
        role: role.trim() || "Worker agent",
        autonomy: "full" as const,
      };

      await window.sinapse?.workers?.spawn(payload);

      const rightmostX = nodes.reduce((max, node) => {
        const nodeWidth = node.type === "brain" ? 640 : 320;
        return Math.max(max, node.position.x + nodeWidth);
      }, 100);

      const newNodeId = `worker-${workerName}`;
      const newNode: Node = {
        id: newNodeId,
        type: "worker",
        position: { x: rightmostX + 60, y: 200 },
        data: {
          name: workerName,
          provider,
          role: role.trim() || "Worker agent",
          status: "idle",
        },
      };

      setNodes((nds) => [...nds, newNode]);
      setEdges((eds) =>
        addEdge(
          {
            id: `edge-brain-${newNodeId}`,
            source: "brain",
            target: newNodeId,
            animated: true,
            style: { stroke: "#6366f1", strokeWidth: 2 },
          },
          eds
        )
      );

      setName("");
      setRole("");
    } catch (err: any) {
      console.error("Failed to spawn worker:", err);
      setErrorMessage(err?.message || "Failed to spawn worker");
    } finally {
      setIsSpawning(false);
    }
  };

  return (
    <div className="canvas-container">
      {/* Floating Toolbar at Top-Right */}
      <div className="spawn-toolbar">
        <div className="toolbar-header">
          <span className="toolbar-title">⚡ Spawn Worker</span>
        </div>
        <form onSubmit={handleSpawn} className="toolbar-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Worker name (e.g. coder)"
            className="toolbar-input"
            required
          />

          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as "claude" | "agy")}
            className="toolbar-select"
          >
            <option value="claude">Claude</option>
            <option value="agy">Agy</option>
          </select>

          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role (e.g. Code reviewer)"
            className="toolbar-input"
          />

          <button
            type="submit"
            disabled={isSpawning || !name.trim()}
            className="toolbar-spawn-btn"
          >
            {isSpawning ? "Spawning..." : "+ Spawn"}
          </button>
        </form>
        {errorMessage && <div className="toolbar-error">{errorMessage}</div>}
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background color="#1a1a2e" gap={20} size={1.5} />
        <Controls className="flow-controls" />
      </ReactFlow>
    </div>
  );
}
