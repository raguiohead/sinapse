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
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  DaemonEvent,
  AgentStatus,
  Workspace,
  AgentState,
  NoteSummary,
  Note,
  TurnRecord,
} from "@sinapse/core";
// The routes subpath is browser-safe; the package root would pull the daemon (Fastify, node:*) into the renderer.
import { ORCHESTRATOR_AUTHOR, USER_AUTHOR } from "@sinapse/core/routes";
import type { DesktopSettings, CanvasLayout } from "../shared/ipc";

import { BrainNode } from "./nodes/BrainNode";
import { WorkerNode } from "./nodes/WorkerNode";
import { NoteNode } from "./nodes/NoteNode";
import { SynapseEdge, type SynapsePulse, type SynapseVariant } from "./edges/SynapseEdge";
import { TitleBar } from "./components/TitleBar";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { NewWorkerDialog } from "./components/NewWorkerDialog";
import { NewNoteDialog } from "./components/NewNoteDialog";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
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

function createInitialBrainNode(workspaceId: string): Node {
  return {
    id: "brain",
    type: "brain",
    position: { x: 100, y: 200 },
    width: 680,
    height: 460,
    data: { label: "Brain", anyThinking: false, workspaceId },
  };
}

/** Set when a workspace canvas is (re)loaded: restore the saved viewport, or fit once when there is none. */
interface ViewportRequest {
  viewport?: Viewport;
}

function AutoFit({
  requestRef,
  requestId,
}: {
  requestRef: { current: ViewportRequest | null };
  requestId: number;
}) {
  const { fitView, setViewport } = useReactFlow();
  const measured = useNodesInitialized();
  useEffect(() => {
    if (!requestRef.current || !measured) return;
    const timer = setTimeout(() => {
      const req = requestRef.current;
      if (!req) return;
      requestRef.current = null;
      if (req.viewport) setViewport(req.viewport);
      else fitView({ padding: 0.15, duration: 400 });
    }, 50);
    return () => clearTimeout(timer);
  }, [measured, requestId, requestRef, fitView, setViewport]);
  return null;
}

/** Same shape as the live log built in recordAgentActivity. */
function turnRecordLog(record: TurnRecord): string {
  let log = `> ${record.prompt}\n`;
  for (const e of record.events) {
    if (e.type === "text") log += e.data;
    else if (e.type === "tool_use") log += `⚙ ${extractToolName(e.data)}\n`;
  }
  return log.slice(-20_000);
}

const LAYOUT_SAVE_DELAY_MS = 600;

function nextWorkerPosition(nodes: Node[]): { x: number; y: number } {
  const brain = nodes.find((n) => n.id === "brain");
  const brainX = brain?.position.x ?? 100;
  const brainY = brain?.position.y ?? 200;
  const brainWidth = brain?.measured?.width ?? 720;
  const workers = nodes.filter((n) => n.type === "worker");
  const workerWidth = workers[0]?.measured?.width ?? 330;
  const workerHeight = Math.max(...workers.map((w) => w.measured?.height ?? 420), 420);
  const index = workers.length;
  const column = Math.floor(index / 3);
  const row = index % 3;
  return {
    x: brainX + brainWidth + 160 + column * (workerWidth + 80),
    y: brainY + row * (workerHeight + 60),
  };
}

function getAuthorNode(createdBy: string | undefined, nodes: Node[]): Node | undefined {
  if (!createdBy || createdBy === USER_AUTHOR) return undefined;
  if (createdBy === ORCHESTRATOR_AUTHOR) {
    return nodes.find((n) => n.id === "brain");
  }
  return nodes.find((n) => n.id === `worker-${createdBy}`);
}

function computeNotePosition(
  noteName: string,
  createdBy: string | undefined,
  nodes: Node[]
): { x: number; y: number } {
  // Lanes that can't collide: unauthored notes left of the brain, the brain's notes under it,
  // worker notes right of the whole worker grid (under a worker they'd land on the next worker in its column).
  const brain = nodes.find((n) => n.id === "brain");
  const brainX = brain?.position.x ?? 100;
  const brainY = brain?.position.y ?? 200;
  const brainHeight = brain?.measured?.height ?? 460;
  const otherNotes = nodes.filter((n) => n.type === "note" && n.id !== `note-${noteName}`);
  const stackBelow = (x: number, startY: number) => {
    const inLane = otherNotes.filter((n) => Math.abs(n.position.x - x) < 50);
    const bottom = Math.max(startY - 40, ...inLane.map((n) => n.position.y + (n.measured?.height ?? 420)));
    return { x, y: inLane.length ? bottom + 40 : startY };
  };

  const authorNode = getAuthorNode(createdBy, nodes);
  if (authorNode?.id === "brain") {
    return stackBelow(brainX, brainY + brainHeight + 60);
  }
  if (authorNode) {
    const workers = nodes.filter((n) => n.type === "worker");
    const gridRight = Math.max(...workers.map((w) => w.position.x + (w.measured?.width ?? 330)));
    return stackBelow(gridRight + 120, authorNode.position.y);
  }
  return stackBelow(brainX - 360 - 120, brainY);
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

interface WorkspaceCanvasState {
  nodes: Node[];
  edges: Edge[];
  agentState: Map<string, { status: AgentStatus; log: string; lastPrompt: string }>;
}

function buildEdges(
  workers: AgentState[],
  notes: (NoteSummary | Note)[],
  orchestratorProvider: "claude" | "agy"
): Edge[] {
  const edges: Edge[] = [];

  // 1. Brain -> worker edges & worker creator edges
  for (const worker of workers) {
    const workerNodeId = `worker-${worker.id}`;
    edges.push({
      id: `edge-brain-${workerNodeId}`,
      source: "brain",
      target: workerNodeId,
      type: "synapse",
      data: { pulse: "idle", provider: worker.provider, variant: "default" },
    });

    if (
      worker.createdBy &&
      worker.createdBy !== ORCHESTRATOR_AUTHOR &&
      worker.createdBy !== USER_AUTHOR
    ) {
      const creatorExists = workers.some((w) => w.id === worker.createdBy);
      if (creatorExists) {
        edges.push({
          id: `edge-creator-worker-${worker.createdBy}-${workerNodeId}`,
          source: `worker-${worker.createdBy}`,
          target: workerNodeId,
          type: "synapse",
          data: { pulse: "idle", provider: worker.provider, variant: "creator" },
        });
      }
    }
  }

  // 2. Note author & contributor edges
  for (const note of notes) {
    const noteNodeId = `note-${note.name}`;

    if (note.createdBy === ORCHESTRATOR_AUTHOR) {
      edges.push({
        id: `edge-author-brain-${noteNodeId}`,
        source: "brain",
        target: noteNodeId,
        type: "synapse",
        data: { pulse: "idle", provider: orchestratorProvider, variant: "author" },
      });
    } else if (note.createdBy && note.createdBy !== USER_AUTHOR) {
      const creatorWorker = workers.find((w) => w.id === note.createdBy);
      if (creatorWorker) {
        edges.push({
          id: `edge-author-worker-${note.createdBy}-${noteNodeId}`,
          source: `worker-${note.createdBy}`,
          target: noteNodeId,
          type: "synapse",
          data: { pulse: "idle", provider: creatorWorker.provider, variant: "author" },
        });
      }
    }

    for (const contrib of note.contributors || []) {
      if (contrib === ORCHESTRATOR_AUTHOR) {
        edges.push({
          id: `edge-contrib-brain-${noteNodeId}`,
          source: "brain",
          target: noteNodeId,
          type: "synapse",
          data: { pulse: "idle", provider: orchestratorProvider, variant: "contributor" },
        });
      } else if (contrib && contrib !== USER_AUTHOR) {
        const contribWorker = workers.find((w) => w.id === contrib);
        if (contribWorker) {
          edges.push({
            id: `edge-contrib-worker-${contrib}-${noteNodeId}`,
            source: `worker-${contrib}`,
            target: noteNodeId,
            type: "synapse",
            data: { pulse: "idle", provider: contribWorker.provider, variant: "contributor" },
          });
        }
      }
    }
  }

  return edges;
}

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("");
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const workspacesRef = useRef<Workspace[]>([]);
  workspacesRef.current = workspaces;

  // Canvas layout persistence (positions/sizes/viewport), debounced and stored by the main process.
  const layoutCacheRef = useRef<Map<string, CanvasLayout>>(new Map());
  const viewportRef = useRef<Viewport | undefined>(undefined);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRequestRef = useRef<ViewportRequest | null>(null);
  const [viewportRequestId, setViewportRequestId] = useState(0);

  const requestViewport = useCallback((viewport: Viewport | undefined) => {
    viewportRef.current = viewport;
    viewportRequestRef.current = { viewport };
    setViewportRequestId((n) => n + 1);
  }, []);

  const saveLayoutNow = useCallback(() => {
    if (layoutTimerRef.current) {
      clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = null;
    }
    const wsId = activeWorkspaceIdRef.current;
    const current = nodesRef.current;
    const brain = current.find((n) => n.id === "brain");
    // Only persist when the canvas on screen really belongs to the active, still-existing workspace.
    if (!wsId || !brain || (brain.data as any)?.workspaceId !== wsId) return;
    if (!workspacesRef.current.some((w) => w.id === wsId)) return;
    const layout: CanvasLayout = { nodes: {}, ...(viewportRef.current ? { viewport: viewportRef.current } : {}) };
    for (const n of current) {
      const width = n.width ?? n.measured?.width;
      const height = n.height ?? n.measured?.height;
      layout.nodes[n.id] = {
        x: n.position.x,
        y: n.position.y,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      };
    }
    layoutCacheRef.current.set(wsId, layout);
    window.sinapse?.layout?.save(wsId, layout).catch((err: unknown) => console.error("Erro ao salvar layout:", err));
  }, []);

  const scheduleLayoutSave = useCallback(() => {
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    layoutTimerRef.current = setTimeout(saveLayoutNow, LAYOUT_SAVE_DELAY_MS);
  }, [saveLayoutNow]);

  // Stored per-workspace canvas state: Map<workspaceId, WorkspaceCanvasState>
  const workspaceCanvasStateMapRef = useRef<Map<string, WorkspaceCanvasState>>(new Map());
  const prevActiveWorkspaceIdRef = useRef<string>("");

  // Thinking agent tracker: Map<workspaceId, Set<agentId>>
  const thinkingAgentsPerWsRef = useRef<Map<string, Set<string>>>(new Map());
  const [thinkingCounts, setThinkingCounts] = useState<Record<string, number>>({});

  const [daemonConnected, setDaemonConnected] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);

  // Modals and context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items?: ContextMenuItem[];
  } | null>(null);
  const [squadPresets, setSquadPresets] = useState<string[]>([]);
  const [isNewWorkerDialogOpen, setIsNewWorkerDialogOpen] = useState(false);
  const [isNewNoteDialogOpen, setIsNewNoteDialogOpen] = useState(false);
  const [isNewWorkspaceDialogOpen, setIsNewWorkspaceDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Per-agent state tracking for active workspace: agentId -> { status, log, lastPrompt }
  const agentStateMapRef = useRef<
    Map<string, { status: AgentStatus; log: string; lastPrompt: string }>
  >(new Map());

  // Every worker's activity, across all workspaces. Saved per-workspace canvases hold stale node data, and workers
  // created while their workspace is in the background have no saved state at all; cards are rehydrated from here.
  const agentActivityRef = useRef<
    Map<string, { status: AgentStatus; log: string; lastPrompt: string }>
  >(new Map());

  const recordAgentActivity = (event: DaemonEvent) => {
    const store = agentActivityRef.current;
    if (event.kind === "agent_deleted") {
      store.delete(event.agentId);
      return;
    }
    if (event.kind !== "turn_started" && event.kind !== "turn_event" && event.kind !== "turn_finished") return;
    const st = store.get(event.agentId) ?? { status: "idle" as AgentStatus, log: "", lastPrompt: "" };
    if (event.kind === "turn_started") {
      st.status = "thinking";
      st.lastPrompt = event.prompt;
      st.log = (st.log + (st.log ? `\n> ${event.prompt}\n` : `> ${event.prompt}\n`)).slice(-20_000);
    } else if (event.kind === "turn_event") {
      if (event.event.type === "text") st.log = (st.log + event.event.data).slice(-20_000);
      else if (event.event.type === "tool_use") st.log = (st.log + `⚙ ${extractToolName(event.event.data)}\n`).slice(-20_000);
    } else {
      st.status = event.status;
    }
    store.set(event.agentId, st);
  };

  const withAgentActivity = (nodes: Node[]): Node[] =>
    nodes.map((n) => {
      if (n.type !== "worker") return n;
      const st = agentActivityRef.current.get(String((n.data as any)?.id ?? n.id.replace(/^worker-/, "")));
      return st ? { ...n, data: { ...n.data, status: st.status, log: st.log, lastPrompt: st.lastPrompt } } : n;
    });

  // Track active pulse timers per edge
  const edgeTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || null;

  const updateThinkingState = useCallback((wsId: string, agentId: string, isThinking: boolean) => {
    let set = thinkingAgentsPerWsRef.current.get(wsId);
    if (!set) {
      set = new Set();
      thinkingAgentsPerWsRef.current.set(wsId, set);
    }
    if (isThinking) {
      set.add(agentId);
    } else {
      set.delete(agentId);
    }
    setThinkingCounts((prev) => ({
      ...prev,
      [wsId]: set.size,
    }));
  }, []);

  const pulseEdge = useCallback(
    (sourceId: string, targetId: string, durationMs = 1500, pulseType: SynapsePulse = "out") => {
      setEdges((eds) => {
        const targetEdge = eds.find((e) => e.source === sourceId && e.target === targetId);
        if (!targetEdge) return eds;

        const edgeId = targetEdge.id;
        const existingTimer = edgeTimersRef.current.get(edgeId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          edgeTimersRef.current.delete(edgeId);
        }

        const timer = setTimeout(() => {
          setEdges((currentEds) =>
            currentEds.map((e) =>
              e.id === edgeId ? { ...e, data: { ...e.data, pulse: "idle" } } : e
            )
          );
          edgeTimersRef.current.delete(edgeId);
        }, durationMs);

        edgeTimersRef.current.set(edgeId, timer);

        return eds.map((e) =>
          e.id === edgeId ? { ...e, data: { ...e.data, pulse: pulseType } } : e
        );
      });
    },
    [setEdges]
  );

  const deleteWorker = useCallback(
    async (agentId: string, workerName: string, status?: AgentStatus) => {
      const message =
        status === "thinking"
          ? `Excluir o worker "${workerName}"? O turno em andamento será interrompido e a sessão dele será perdida.`
          : `Excluir o worker "${workerName}"? A sessão dele será perdida.`;
      if (!window.confirm(message)) return;

      try {
        await window.sinapse?.workers?.delete(activeWorkspaceIdRef.current, agentId);
      } catch (err: any) {
        console.error("Erro ao excluir worker:", err);
        const errorMsg = err?.message || "Falha ao excluir worker";
        setNodes((nds) =>
          nds.map((n) =>
            n.id === `worker-${agentId}`
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
      const agentId = data.id;
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
              deleteWorker(agentId, workerName, status);
            },
          },
        ],
      });
    },
    [deleteWorker]
  );

  // Load canvas for a workspace from daemon
  const loadWorkspaceCanvas = useCallback(
    async (wsId: string) => {
      if (!wsId) return;
      try {
        const [workerList, summaries, brainInfo, savedLayout] = await Promise.all([
          window.sinapse?.workers?.list(wsId),
          window.sinapse?.notes?.list(wsId),
          window.sinapse?.brain?.getInfo(wsId).catch(() => null),
          window.sinapse?.layout?.get(wsId).catch(() => null),
        ]);

        // Last finished turn of each worker, from disk, so cards survive an app/daemon restart.
        const lastTurns = new Map<string, TurnRecord>();
        if (Array.isArray(workerList)) {
          await Promise.all(
            workerList.map(async (w) => {
              try {
                const records = await window.sinapse?.workers?.history(wsId, w.id, 1);
                const last = records?.[records.length - 1];
                if (last) lastTurns.set(w.id, last);
              } catch {}
            })
          );
        }

        const orchestratorProvider = brainInfo?.provider ?? "claude";

        const fullNotes: Note[] = Array.isArray(summaries)
          ? await Promise.all(
              summaries.map(async (s) => {
                try {
                  return await window.sinapse?.notes?.read(wsId, s.name);
                } catch {
                  return {
                    workspaceId: wsId,
                    name: s.name,
                    title: s.title,
                    content: "",
                    updatedAt: s.updatedAt,
                    createdBy: s.createdBy,
                    contributors: s.contributors || [],
                  };
                }
              })
            )
          : [];

        const brainNode = createInitialBrainNode(wsId);
        const brainSaved = savedLayout?.nodes?.["brain"];
        if (brainSaved) {
          brainNode.position = { x: brainSaved.x, y: brainSaved.y };
          if (brainSaved.width) brainNode.width = brainSaved.width;
          if (brainSaved.height) brainNode.height = brainSaved.height;
        }
        const newNodes: Node[] = [brainNode];
        const newAgentState = new Map<
          string,
          { status: AgentStatus; log: string; lastPrompt: string }
        >();

        const thinkingSet = new Set<string>();

        if (Array.isArray(workerList)) {
          for (const worker of workerList) {
            if (worker.status === "thinking") {
              thinkingSet.add(worker.id);
            }
            const lastTurn = lastTurns.get(worker.id);
            const histLog = lastTurn ? turnRecordLog(lastTurn) : "";
            const histPrompt = lastTurn?.prompt ?? "";
            newAgentState.set(worker.id, {
              status: worker.status || "idle",
              log: histLog,
              lastPrompt: histPrompt,
            });
            // Live activity (events received this session) wins over disk; otherwise seed it so new events append.
            if (lastTurn && !agentActivityRef.current.has(worker.id)) {
              agentActivityRef.current.set(worker.id, {
                status: worker.status || "idle",
                log: histLog,
                lastPrompt: histPrompt,
              });
            }
            const workerSaved = savedLayout?.nodes?.[`worker-${worker.id}`];
            newNodes.push({
              id: `worker-${worker.id}`,
              type: "worker",
              position: workerSaved ? { x: workerSaved.x, y: workerSaved.y } : nextWorkerPosition(newNodes),
              width: workerSaved?.width ?? 330,
              height: workerSaved?.height ?? 420,
              data: {
                id: worker.id,
                workspaceId: wsId,
                name: worker.name,
                provider: worker.provider,
                role: worker.role,
                status: worker.status || "idle",
                model: worker.model,
                usage: worker.usage,
                worktreeBranch: worker.worktree?.branch,
                worktreePath: worker.worktree?.path,
                log: histLog,
                lastPrompt: histPrompt,
              },
            });
          }
        }

        thinkingAgentsPerWsRef.current.set(wsId, thinkingSet);
        setThinkingCounts((prev) => ({ ...prev, [wsId]: thinkingSet.size }));

        for (const note of fullNotes) {
          const noteSaved = savedLayout?.nodes?.[`note-${note.name}`];
          const pos = noteSaved
            ? { x: noteSaved.x, y: noteSaved.y }
            : computeNotePosition(note.name, note.createdBy, newNodes);
          newNodes.push({
            id: `note-${note.name}`,
            type: "note",
            position: pos,
            width: noteSaved?.width ?? 360,
            height: noteSaved?.height ?? 420,
            data: {
              workspaceId: wsId,
              name: note.name,
              title: note.title,
              content: note.content,
              updatedAt: note.updatedAt,
              createdBy: note.createdBy,
              contributors: note.contributors || [],
            },
          });
        }

        const newEdges = buildEdges(
          Array.isArray(workerList) ? workerList : [],
          fullNotes,
          orchestratorProvider
        );

        agentStateMapRef.current = newAgentState;
        if (savedLayout) layoutCacheRef.current.set(wsId, savedLayout);
        if (wsId === activeWorkspaceIdRef.current) requestViewport(savedLayout?.viewport);
        setNodes(withAgentActivity(newNodes));
        setEdges(newEdges);

        workspaceCanvasStateMapRef.current.set(wsId, {
          nodes: newNodes,
          edges: newEdges,
          agentState: new Map(newAgentState),
        });
      } catch (err) {
        console.error("Erro ao carregar canvas do workspace:", err);
      }
    },
    [setNodes, setEdges, requestViewport]
  );

  // Switch workspace: save current canvas and restore target
  const switchWorkspace = useCallback(
    (targetWsId: string) => {
      const prevWsId = prevActiveWorkspaceIdRef.current;
      if (prevWsId && prevWsId !== targetWsId) saveLayoutNow();
      if (prevWsId && prevWsId !== targetWsId && nodesRef.current.length > 0) {
        workspaceCanvasStateMapRef.current.set(prevWsId, {
          nodes: nodesRef.current,
          edges: edgesRef.current,
          agentState: new Map(agentStateMapRef.current),
        });
      }

      // Clear edge timers from previous workspace
      for (const timer of edgeTimersRef.current.values()) {
        clearTimeout(timer);
      }
      edgeTimersRef.current.clear();

      prevActiveWorkspaceIdRef.current = targetWsId;
      setActiveWorkspaceId(targetWsId);

      if (workspaceCanvasStateMapRef.current.has(targetWsId)) {
        const saved = workspaceCanvasStateMapRef.current.get(targetWsId)!;
        agentStateMapRef.current = new Map(saved.agentState);
        setNodes(withAgentActivity(saved.nodes));
        setEdges(saved.edges);
        requestViewport(layoutCacheRef.current.get(targetWsId)?.viewport);
      } else {
        loadWorkspaceCanvas(targetWsId);
      }
    },
    [loadWorkspaceCanvas, setNodes, setEdges, saveLayoutNow, requestViewport]
  );

  // Initial load: settings, workspaces list, active workspace
  useEffect(() => {
    window.sinapse?.settings?.get().then((s) => {
      if (s) {
        setSettings(s);
        if (s.appearance?.motion) {
          document.documentElement.dataset.motion = s.appearance.motion;
        }
      }
    });

    const unsubSettings = window.sinapse?.settings?.onChanged((s) => {
      if (s) {
        setSettings(s);
        if (s.appearance?.motion) {
          document.documentElement.dataset.motion = s.appearance.motion;
        }
      }
    });

    window.sinapse?.workspaces?.list().then((list) => {
      if (Array.isArray(list)) {
        setWorkspaces(list);
      }
    });

    window.sinapse?.workspaces?.getActive().then((activeId) => {
      if (activeId) {
        switchWorkspace(activeId);
      }
    });

    const unsubActive = window.sinapse?.workspaces?.onActiveChanged((activeId) => {
      if (activeId && activeId !== activeWorkspaceIdRef.current) {
        switchWorkspace(activeId);
      }
    });

    return () => {
      if (unsubSettings) unsubSettings();
      if (unsubActive) unsubActive();
    };
  }, [switchWorkspace]);

  // Handle incoming DaemonEvents
  const handleDaemonEvent = useCallback(
    (event: DaemonEvent) => {
      recordAgentActivity(event);
      switch (event.kind) {
        case "workspace_created": {
          setWorkspaces((prev) => {
            if (prev.some((w) => w.id === event.workspace.id)) return prev;
            return [...prev, event.workspace];
          });
          break;
        }

        case "workspace_updated": {
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === event.workspace.id ? event.workspace : w))
          );
          break;
        }

        case "workspace_deleted": {
          setWorkspaces((prev) => prev.filter((w) => w.id !== event.workspaceId));
          workspaceCanvasStateMapRef.current.delete(event.workspaceId);
          thinkingAgentsPerWsRef.current.delete(event.workspaceId);
          setThinkingCounts((prev) => {
            const next = { ...prev };
            delete next[event.workspaceId];
            return next;
          });
          break;
        }

        case "agent_spawned": {
          const wsId = event.workspaceId;
          const agent = event.agent;
          const isThinking = agent.status === "thinking";
          updateThinkingState(wsId, agent.id, isThinking);

          if (wsId === activeWorkspaceIdRef.current) {
            const nodeId = `worker-${agent.id}`;
            const edgeId = `edge-brain-${nodeId}`;

            if (!agentStateMapRef.current.has(agent.id)) {
              agentStateMapRef.current.set(agent.id, {
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
                    id: agent.id,
                    workspaceId: wsId,
                    name: agent.name,
                    provider: agent.provider,
                    role: agent.role,
                    status: agent.status || "idle",
                    model: agent.model,
                    usage: agent.usage,
                    worktreeBranch: agent.worktree?.branch,
                    worktreePath: agent.worktree?.path,
                    log: "",
                    lastPrompt: "",
                  },
                },
              ];
            });

            setEdges((eds) => {
              let nextEds = eds;
              if (!nextEds.some((e) => e.id === edgeId)) {
                nextEds = addEdge(
                  {
                    id: edgeId,
                    source: "brain",
                    target: nodeId,
                    type: "synapse",
                    data: { pulse: "idle", provider: agent.provider, variant: "default" },
                  },
                  nextEds
                );
              }
              if (
                agent.createdBy &&
                agent.createdBy !== ORCHESTRATOR_AUTHOR &&
                agent.createdBy !== USER_AUTHOR
              ) {
                const creatorEdgeId = `edge-creator-worker-${agent.createdBy}-${nodeId}`;
                if (!nextEds.some((e) => e.id === creatorEdgeId)) {
                  nextEds = addEdge(
                    {
                      id: creatorEdgeId,
                      source: `worker-${agent.createdBy}`,
                      target: nodeId,
                      type: "synapse",
                      data: { pulse: "idle", provider: agent.provider, variant: "creator" },
                    },
                    nextEds
                  );
                }
              }
              return nextEds;
            });
          } else {
            // Update background workspace cache
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              const nodeId = `worker-${agent.id}`;
              if (!cached.nodes.some((n) => n.id === nodeId)) {
                cached.nodes.push({
                  id: nodeId,
                  type: "worker",
                  position: nextWorkerPosition(cached.nodes),
                  width: 330,
                  height: 420,
                  data: {
                    id: agent.id,
                    workspaceId: wsId,
                    name: agent.name,
                    provider: agent.provider,
                    role: agent.role,
                    status: agent.status || "idle",
                    model: agent.model,
                    usage: agent.usage,
                    worktreeBranch: agent.worktree?.branch,
                    worktreePath: agent.worktree?.path,
                    log: "",
                    lastPrompt: "",
                  },
                });
                cached.edges.push({
                  id: `edge-brain-${nodeId}`,
                  source: "brain",
                  target: nodeId,
                  type: "synapse",
                  data: { pulse: "idle", provider: agent.provider, variant: "default" },
                });
              }
            }
          }
          break;
        }

        case "agent_updated": {
          const wsId = event.workspaceId;
          const agent = event.agent;
          const isThinking = agent.status === "thinking";
          updateThinkingState(wsId, agent.id, isThinking);

          if (wsId === activeWorkspaceIdRef.current) {
            const nodeId = `worker-${agent.id}`;
            setNodes((nds) =>
              nds.map((n) =>
                n.id === nodeId
                  ? {
                      ...n,
                      data: {
                        ...n.data,
                        role: agent.role,
                        model: agent.model,
                        // Authoritative: a handoff clears it.
                        usage: agent.usage,
                        status: agent.status || n.data?.status,
                      },
                    }
                  : n
              )
            );
          } else {
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              cached.nodes = cached.nodes.map((n) =>
                n.id === `worker-${agent.id}`
                  ? {
                      ...n,
                      data: {
                        ...n.data,
                        role: agent.role,
                        model: agent.model,
                        usage: agent.usage,
                        status: agent.status || n.data?.status,
                      },
                    }
                  : n
              );
            }
          }
          break;
        }

        case "turn_started": {
          const wsId = event.workspaceId;
          updateThinkingState(wsId, event.agentId, true);

          if (wsId === activeWorkspaceIdRef.current) {
            const nodeId = `worker-${event.agentId}`;
            const st = agentStateMapRef.current.get(event.agentId) || {
              status: "idle",
              log: "",
              lastPrompt: "",
            };
            st.status = "thinking";
            st.lastPrompt = event.prompt;
            const promptHeader = st.log ? `\n> ${event.prompt}\n` : `> ${event.prompt}\n`;
            st.log = (st.log + promptHeader).slice(-20_000);
            agentStateMapRef.current.set(event.agentId, st);

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

            // Pulse edge brain -> worker
            const edgeId = `edge-brain-${nodeId}`;
            const existingTimer = edgeTimersRef.current.get(edgeId);
            if (existingTimer) {
              clearTimeout(existingTimer);
              edgeTimersRef.current.delete(edgeId);
            }
            setEdges((eds) =>
              eds.map((e) =>
                e.id === edgeId || (e.source === "brain" && e.target === nodeId)
                  ? { ...e, data: { ...e.data, pulse: "out" } }
                  : e
              )
            );
          } else {
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              const st = cached.agentState.get(event.agentId) || {
                status: "idle",
                log: "",
                lastPrompt: "",
              };
              st.status = "thinking";
              st.lastPrompt = event.prompt;
              cached.agentState.set(event.agentId, st);
              cached.nodes = cached.nodes.map((n) =>
                n.id === `worker-${event.agentId}`
                  ? { ...n, data: { ...n.data, status: "thinking", lastPrompt: event.prompt } }
                  : n
              );
            }
          }
          break;
        }

        case "turn_event": {
          const wsId = event.workspaceId;
          if (wsId === activeWorkspaceIdRef.current) {
            const nodeId = `worker-${event.agentId}`;
            const st = agentStateMapRef.current.get(event.agentId) || {
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
            agentStateMapRef.current.set(event.agentId, st);

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
          } else {
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              const st = cached.agentState.get(event.agentId);
              if (st) {
                if (event.event.type === "text") {
                  st.log = (st.log + event.event.data).slice(-20_000);
                } else if (event.event.type === "tool_use") {
                  const toolName = extractToolName(event.event.data);
                  st.log = (st.log + `⚙ ${toolName}\n`).slice(-20_000);
                }
              }
            }
          }
          break;
        }

        case "turn_finished": {
          const wsId = event.workspaceId;
          updateThinkingState(wsId, event.agentId, false);

          if (wsId === activeWorkspaceIdRef.current) {
            const nodeId = `worker-${event.agentId}`;
            const st = agentStateMapRef.current.get(event.agentId) || {
              status: event.status,
              log: "",
              lastPrompt: "",
            };
            st.status = event.status;
            agentStateMapRef.current.set(event.agentId, st);

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
          } else {
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              const st = cached.agentState.get(event.agentId);
              if (st) st.status = event.status;
              cached.nodes = cached.nodes.map((n) =>
                n.id === `worker-${event.agentId}`
                  ? {
                      ...n,
                      data: {
                        ...n.data,
                        status: event.status,
                        ...(event.usage ? { usage: event.usage } : {}),
                      },
                    }
                  : n
              );
            }
          }
          break;
        }

        case "agent_deleted": {
          const wsId = event.workspaceId;
          updateThinkingState(wsId, event.agentId, false);

          if (wsId === activeWorkspaceIdRef.current) {
            const nodeId = `worker-${event.agentId}`;
            agentStateMapRef.current.delete(event.agentId);

            setNodes((nds) => nds.filter((n) => n.id !== nodeId));
            setEdges((eds) =>
              eds.filter((e) => e.target !== nodeId && e.source !== nodeId)
            );
          } else {
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              const nodeId = `worker-${event.agentId}`;
              cached.agentState.delete(event.agentId);
              cached.nodes = cached.nodes.filter((n) => n.id !== nodeId);
              cached.edges = cached.edges.filter(
                (e) => e.target !== nodeId && e.source !== nodeId
              );
            }
          }
          break;
        }

        case "note_changed": {
          const wsId = event.workspaceId;
          const noteSummary = event.note;
          const changer = event.by;

          if (wsId === activeWorkspaceIdRef.current) {
            window.sinapse?.notes
              ?.read(wsId, noteSummary.name)
              .then((fullNote) => {
                const nodeId = `note-${fullNote.name}`;
                setNodes((nds) => {
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
                              createdBy: fullNote.createdBy,
                              contributors: fullNote.contributors || [],
                            },
                          }
                        : n
                    );
                  } else {
                    const pos = computeNotePosition(fullNote.name, fullNote.createdBy, nds);
                    return [
                      ...nds,
                      {
                        id: nodeId,
                        type: "note",
                        position: pos,
                        width: 360,
                        height: 420,
                        data: {
                          workspaceId: wsId,
                          name: fullNote.name,
                          title: fullNote.title,
                          content: fullNote.content,
                          updatedAt: fullNote.updatedAt,
                          createdBy: fullNote.createdBy,
                          contributors: fullNote.contributors || [],
                        },
                      },
                    ];
                  }
                });

                // Ensure author and contributor edges exist for this note
                setEdges((currentEdges) => {
                  let nextEdges = [...currentEdges];
                  const activeProvider = activeWorkspace?.orchestrator?.provider ?? "claude";

                  if (fullNote.createdBy === ORCHESTRATOR_AUTHOR) {
                    const authorEdgeId = `edge-author-brain-${nodeId}`;
                    if (!nextEdges.some((e) => e.id === authorEdgeId)) {
                      nextEdges.push({
                        id: authorEdgeId,
                        source: "brain",
                        target: nodeId,
                        type: "synapse",
                        data: { pulse: "idle", provider: activeProvider, variant: "author" },
                      });
                    }
                  } else if (
                    fullNote.createdBy &&
                    fullNote.createdBy !== USER_AUTHOR &&
                    nodesRef.current.some((n) => n.id === `worker-${fullNote.createdBy}`)
                  ) {
                    const authorEdgeId = `edge-author-worker-${fullNote.createdBy}-${nodeId}`;
                    if (!nextEdges.some((e) => e.id === authorEdgeId)) {
                      nextEdges.push({
                        id: authorEdgeId,
                        source: `worker-${fullNote.createdBy}`,
                        target: nodeId,
                        type: "synapse",
                        data: { pulse: "idle", provider: "claude", variant: "author" },
                      });
                    }
                  }

                  for (const contrib of fullNote.contributors || []) {
                    if (contrib === ORCHESTRATOR_AUTHOR) {
                      const contribEdgeId = `edge-contrib-brain-${nodeId}`;
                      if (!nextEdges.some((e) => e.id === contribEdgeId)) {
                        nextEdges.push({
                          id: contribEdgeId,
                          source: "brain",
                          target: nodeId,
                          type: "synapse",
                          data: { pulse: "idle", provider: activeProvider, variant: "contributor" },
                        });
                      }
                    } else if (
                      contrib &&
                      contrib !== USER_AUTHOR &&
                      nodesRef.current.some((n) => n.id === `worker-${contrib}`)
                    ) {
                      const contribEdgeId = `edge-contrib-worker-${contrib}-${nodeId}`;
                      if (!nextEdges.some((e) => e.id === contribEdgeId)) {
                        nextEdges.push({
                          id: contribEdgeId,
                          source: `worker-${contrib}`,
                          target: nodeId,
                          type: "synapse",
                          data: { pulse: "idle", provider: "claude", variant: "contributor" },
                        });
                      }
                    }
                  }

                  return nextEdges;
                });

                // Pulse edge from changer to note
                if (changer) {
                  let sourceId: string | null = null;
                  if (changer === ORCHESTRATOR_AUTHOR) {
                    sourceId = "brain";
                  } else if (changer !== USER_AUTHOR) {
                    sourceId = `worker-${changer}`;
                  }
                  if (sourceId) {
                    pulseEdge(sourceId, nodeId, 1500, "out");
                  }
                }
              })
              .catch((err) => console.error("Erro ao ler nota atualizada:", err));
          } else {
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              const nodeId = `note-${noteSummary.name}`;
              const idx = cached.nodes.findIndex((n) => n.id === nodeId);
              if (idx !== -1) {
                cached.nodes[idx] = {
                  ...cached.nodes[idx],
                  data: {
                    ...cached.nodes[idx].data,
                    title: noteSummary.title,
                    updatedAt: noteSummary.updatedAt,
                    createdBy: noteSummary.createdBy,
                    contributors: noteSummary.contributors || [],
                  },
                };
              }
            }
          }
          break;
        }

        case "note_deleted": {
          const wsId = event.workspaceId;
          const deletedName = event.name;
          const nodeId = `note-${deletedName}`;

          if (wsId === activeWorkspaceIdRef.current) {
            setNodes((nds) => nds.filter((n) => n.id !== nodeId));
            setEdges((eds) => eds.filter((e) => e.target !== nodeId && e.source !== nodeId));
          } else {
            const cached = workspaceCanvasStateMapRef.current.get(wsId);
            if (cached) {
              cached.nodes = cached.nodes.filter((n) => n.id !== nodeId);
              cached.edges = cached.edges.filter(
                (e) => e.target !== nodeId && e.source !== nodeId
              );
            }
          }
          break;
        }
      }
    },
    [activeWorkspace?.orchestrator?.provider, pulseEdge, setNodes, setEdges, updateThinkingState]
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const userMoved = changes.some(
        (c) =>
          (c.type === "position" && c.dragging !== true) ||
          (c.type === "dimensions" && c.resizing === false) ||
          c.type === "remove"
      );
      if (userMoved) scheduleLayoutSave();
    },
    [onNodesChange, scheduleLayoutSave]
  );

  // Nodes added/removed (workers, notes, workspace switch): persist so removed entries disappear from the layout.
  const nodeIdsKey = nodes.map((n) => n.id).join("|");
  useEffect(() => {
    if (nodeIdsKey) scheduleLayoutSave();
  }, [nodeIdsKey, scheduleLayoutSave]);

  // Sync anyThinking to brain node data
  useEffect(() => {
    const anyThinking = nodes.some(
      (n) => n.type === "worker" && n.data?.status === "thinking"
    );

    setNodes((current) => {
      const brainNode = current.find((n) => n.id === "brain");
      if (
        brainNode &&
        (brainNode.data?.anyThinking !== anyThinking ||
          brainNode.data?.workspaceId !== activeWorkspaceId)
      ) {
        return current.map((n) =>
          n.id === "brain"
            ? { ...n, data: { ...n.data, anyThinking, workspaceId: activeWorkspaceId } }
            : n
        );
      }
      return current;
    });
  }, [nodes, activeWorkspaceId, setNodes]);

  // Event bus and daemon status subscriptions
  useEffect(() => {
    const unsubStatus = window.sinapse?.daemon?.onStatus((status) => {
      setDaemonConnected(status.connected);
      if (status.connected && activeWorkspaceIdRef.current) {
        loadWorkspaceCanvas(activeWorkspaceIdRef.current);
      }
    });

    const unsubEvent = window.sinapse?.daemon?.onEvent((event: DaemonEvent) => {
      handleDaemonEvent(event);
    });

    return () => {
      if (unsubStatus) unsubStatus();
      if (unsubEvent) unsubEvent();
    };
  }, [loadWorkspaceCanvas, handleDaemonEvent]);

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
            data: { pulse: "idle", provider: "claude", variant: "default" },
          },
          eds
        )
      );
    },
    [setEdges]
  );

  const handlePaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
    window.sinapse?.squads
      ?.list()
      .then((catalog) => setSquadPresets(catalog.presets.map((p) => p.name)))
      .catch(() => setSquadPresets([]));
  }, []);

  const handleApplySquad = useCallback(async (preset: string) => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId) return;
    try {
      const result = await window.sinapse?.squads?.apply({ workspaceId, preset });
      if (!result) return;
      const notes = [
        ...result.skipped.map((s) => `"${s.name}" ignorado (${s.reason})`),
        ...result.failed.map((f) => `"${f.name}" falhou: ${f.error}`),
      ];
      if (notes.length > 0) window.alert(`Squad "${preset}":\n${notes.join("\n")}`);
    } catch (err: any) {
      window.alert(`Não foi possível aplicar o squad "${preset}": ${err?.message ?? err}`);
    }
  }, []);

  const activeThinkingCount = nodes.filter(
    (n) => n.type === "worker" && n.data?.status === "thinking"
  ).length;


  return (
    <div className="canvas-container">
      {/* Top 40px Chromatic Title Bar */}
      <TitleBar
        connected={daemonConnected}
        activeCount={activeThinkingCount}
        onOpenSettings={() => setIsSettingsOpen(true)}
        chromaticBar={settings?.appearance?.chromaticBar ?? "animada"}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        thinkingCounts={thinkingCounts}
        onNewWorkspace={() => setIsNewWorkspaceDialogOpen(true)}
      />

      {/* ReactFlow Canvas container */}
      <div className="flow-canvas-wrapper">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onMoveEnd={(_e, viewport) => {
            viewportRef.current = viewport;
            scheduleLayoutSave();
          }}
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
          <AutoFit requestRef={viewportRequestRef} requestId={viewportRequestId} />
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
          squadPresets={squadPresets}
          onApplySquad={handleApplySquad}
        />
      )}

      {/* New Worker Dialog */}
      {isNewWorkerDialogOpen && (
        <NewWorkerDialog
          workspaceId={activeWorkspaceId}
          workspaceDefaultFolder={activeWorkspace?.folder}
          defaults={settings?.workerDefaults}
          onClose={() => setIsNewWorkerDialogOpen(false)}
        />
      )}

      {/* New Note Dialog */}
      {isNewNoteDialogOpen && (
        <NewNoteDialog
          workspaceId={activeWorkspaceId}
          onClose={() => setIsNewNoteDialogOpen(false)}
        />
      )}

      {/* New Workspace Dialog */}
      {isNewWorkspaceDialogOpen && (
        <NewWorkspaceDialog
          onClose={() => setIsNewWorkspaceDialogOpen(false)}
        />
      )}

      {/* Settings Screen */}
      {isSettingsOpen && (
        <SettingsScreen
          activeWorkspaceId={activeWorkspaceId}
          workspaces={workspaces}
          onWorkspaceUpdated={(updated) => {
            setWorkspaces((prev) =>
              prev.map((w) => (w.id === updated.id ? updated : w))
            );
          }}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </div>
  );
}
