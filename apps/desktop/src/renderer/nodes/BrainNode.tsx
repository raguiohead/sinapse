import { useState, useEffect, useRef } from "react";
import { Handle, Position, NodeResizeControl, type NodeProps } from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ContextUsage } from "@sinapse/core";
import { ContextMeter } from "../components/ContextMeter";

export interface BrainNodeData {
  label?: string;
  anyThinking?: boolean;
  workspaceId?: string;
}

export function BrainNode({ data }: NodeProps) {
  const nodeData = (data ?? {}) as BrainNodeData;
  const anyThinking = Boolean(nodeData.anyThinking);

  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(
    nodeData.workspaceId || ""
  );
  const [provider, setProvider] = useState<"claude" | "agy">("claude");
  const [brainModel, setBrainModel] = useState<string | null>(null);
  const [brainUsage, setBrainUsage] = useState<ContextUsage | undefined>(undefined);

  const activeWorkspaceIdRef = useRef<string>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fontSizeRef = useRef<number>(13);

  // Sync workspaceId from prop or from daemon onActiveChanged
  useEffect(() => {
    if (nodeData.workspaceId && nodeData.workspaceId !== activeWorkspaceIdRef.current) {
      setActiveWorkspaceId(nodeData.workspaceId);
    }
  }, [nodeData.workspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      window.sinapse?.workspaces?.getActive().then((wsId) => {
        if (wsId) setActiveWorkspaceId(wsId);
      });
    }

    const unsubActive = window.sinapse?.workspaces?.onActiveChanged((wsId) => {
      setActiveWorkspaceId(wsId);
    });

    return () => {
      if (unsubActive) unsubActive();
    };
  }, [activeWorkspaceId]);

  // Fetch info and listen to updates for the active workspace
  useEffect(() => {
    if (!activeWorkspaceId) return;

    window.sinapse?.brain?.getInfo(activeWorkspaceId).then((info) => {
      if (info) {
        setProvider(info.provider || "claude");
        setBrainModel(info.model ?? null);
        setBrainUsage(info.usage);
      }
    });

    const unsubUsage = window.sinapse?.brain?.onUsage((wsId, usage) => {
      if (wsId === activeWorkspaceIdRef.current) {
        setBrainUsage(usage);
      }
    });

    const unsubInfoChanged = window.sinapse?.brain?.onInfoChanged((info) => {
      if (info.workspaceId === activeWorkspaceIdRef.current) {
        setProvider(info.provider || "claude");
        setBrainModel(info.model ?? null);
        setBrainUsage(info.usage);
      }
    });

    return () => {
      if (unsubUsage) unsubUsage();
      if (unsubInfoChanged) unsubInfoChanged();
    };
  }, [activeWorkspaceId]);

  // Terminal replay on active workspace switch
  useEffect(() => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !activeWorkspaceId) return;

    term.reset();
    let isCancelled = false;

    window.sinapse?.brain?.replay(activeWorkspaceId).then((replayData) => {
      if (isCancelled || !term) return;
      if (replayData) {
        term.write(replayData);
      }
      try {
        fitAddon?.fit();
        window.sinapse?.brain?.resize(activeWorkspaceId, term.cols, term.rows);
      } catch (err) {
        // Ignored if DOM not ready
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [activeWorkspaceId]);

  // Settings subscription for terminal font size
  useEffect(() => {
    const applyFontSize = (size: number) => {
      fontSizeRef.current = size;
      const term = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      term.options.fontSize = size;
      try {
        fitAddon.fit();
        if (activeWorkspaceIdRef.current) {
          window.sinapse?.brain?.resize(activeWorkspaceIdRef.current, term.cols, term.rows);
        }
      } catch (err) {
        // Ignored if DOM not yet measured
      }
    };

    window.sinapse?.settings?.get().then((s) => {
      if (s?.appearance?.terminalFontSize) {
        applyFontSize(s.appearance.terminalFontSize);
      }
    });

    const unsubSettings = window.sinapse?.settings?.onChanged((s) => {
      if (s?.appearance?.terminalFontSize) {
        applyFontSize(s.appearance.terminalFontSize);
      }
    });

    return () => {
      if (unsubSettings) unsubSettings();
    };
  }, []);

  // Terminal lifecycle
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      lineHeight: 1.25,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      theme: {
        background: "#0e1018",
        foreground: "#e6e8ef",
        cursor: "#5eead4",
        selectionBackground: "#1c2030",
        black: "#07080d",
        red: "#f87171",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#6ea8fe",
        magenta: "#a78bfa",
        cyan: "#5eead4",
        white: "#e6e8ef",
      },
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const fitAndResize = () => {
      try {
        fitAddon.fit();
        if (activeWorkspaceIdRef.current) {
          window.sinapse?.brain?.resize(activeWorkspaceIdRef.current, term.cols, term.rows);
        }
      } catch (err) {
        // Ignored if DOM not yet measured
      }
    };

    const timer = setTimeout(fitAndResize, 50);

    const unsubData = window.sinapse?.brain?.onData((wsId: string, termData: string) => {
      if (wsId === activeWorkspaceIdRef.current) {
        term.write(termData);
      }
    });

    const onDataDisposable = term.onData((inputData: string) => {
      if (activeWorkspaceIdRef.current) {
        window.sinapse?.brain?.write(activeWorkspaceIdRef.current, inputData);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndResize();
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(timer);
      resizeObserver.disconnect();
      if (unsubData) unsubData();
      onDataDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  const modelChipLabel = brainUsage?.model ?? brainModel ?? "padrão";

  return (
    <div className={`brain-node-card ${anyThinking ? "brain-breathing" : ""}`}>
      <div className="brain-node-header">
        <div className="brain-node-title-group">
          <div className="brain-node-title">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              className="brain-header-glyph"
              aria-hidden="true"
            >
              <path
                d="M 5 8 C 11 8, 13 16, 19 16"
                stroke="url(#brain-glyph-grad)"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="5" cy="8" r="3.2" style={{ fill: "var(--accent-a)" }} />
              <circle cx="19" cy="16" r="3.2" style={{ fill: "var(--accent-b)" }} />
              <defs>
                <linearGradient
                  id="brain-glyph-grad"
                  x1="4"
                  y1="6"
                  x2="20"
                  y2="18"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" style={{ stopColor: "var(--accent-a)" }} />
                  <stop offset="100%" style={{ stopColor: "var(--accent-b)" }} />
                </linearGradient>
              </defs>
            </svg>
            <span className="brain-node-label">orquestrador · {provider}</span>
          </div>
        </div>

        <div className="brain-node-controls nodrag">
          <ContextMeter usage={brainUsage} className="brain-context-meter" />
          <span className="brain-model-chip" title="Modelo do orquestrador">
            {modelChipLabel}
          </span>
        </div>
      </div>

      <div className="brain-terminal-wrapper nodrag nowheel" ref={containerRef} />
      <Handle
        type="source"
        position={Position.Right}
        id="brain-source"
        className="flow-handle brain-handle-source"
      />
      <NodeResizeControl
        position="bottom-right"
        minWidth={520}
        minHeight={320}
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
