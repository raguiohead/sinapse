import { useState, useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ContextUsage } from "@sinapse/core";
import { ModelSelect } from "../components/ModelSelect";
import { ContextMeter } from "../components/ContextMeter";

export interface BrainNodeData {
  label?: string;
  anyThinking?: boolean;
}

export function BrainNode({ data }: NodeProps) {
  const nodeData = (data ?? {}) as BrainNodeData;
  const anyThinking = Boolean(nodeData.anyThinking);

  const [brainModel, setBrainModel] = useState<string | null>(null);
  const [brainUsage, setBrainUsage] = useState<ContextUsage | undefined>(undefined);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Initial fetch and subscriptions for brain model and context usage
  useEffect(() => {
    window.sinapse?.brain?.getInfo().then((info) => {
      if (info) {
        setBrainModel(info.model ?? null);
        setBrainUsage(info.usage);
      }
    });

    const unsubUsage = window.sinapse?.brain?.onUsage((usage) => {
      setBrainUsage(usage);
    });

    const unsubInfoChanged = window.sinapse?.brain?.onInfoChanged((info) => {
      setBrainModel(info.model ?? null);
    });

    return () => {
      if (unsubUsage) unsubUsage();
      if (unsubInfoChanged) unsubInfoChanged();
    };
  }, []);

  // Terminal lifecycle
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
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
        window.sinapse?.brain?.resize(term.cols, term.rows);
      } catch (err) {
        // Ignored if DOM not yet measured
      }
    };

    const timer = setTimeout(fitAndResize, 50);

    const unsubData = window.sinapse?.brain?.onData((termData: string) => {
      term.write(termData);
    });

    const onDataDisposable = term.onData((inputData: string) => {
      window.sinapse?.brain?.write(inputData);
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

  const handleModelChange = async (newModel: string | null) => {
    const modelLabel = newModel || "padrão";
    const confirmed = window.confirm(
      `Reiniciar o cérebro com o modelo ${modelLabel}? A conversa continua.`
    );
    if (!confirmed) return;

    try {
      await window.sinapse?.brain?.setModel(newModel);
    } catch (err) {
      console.error("Erro ao alterar modelo do cérebro:", err);
    }
  };

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
            <span className="brain-node-label">cérebro · claude</span>
          </div>
          <div className="brain-node-tag">orquestrador</div>
        </div>

        <div className="brain-node-controls nodrag">
          <ContextMeter usage={brainUsage} className="brain-context-meter" />
          <ModelSelect
            provider="claude"
            value={brainModel}
            resolvedModel={brainUsage?.model}
            onChange={handleModelChange}
            className="brain-model-select"
          />
        </div>
      </div>

      <div className="brain-terminal-wrapper nodrag nowheel" ref={containerRef} />
      <Handle
        type="source"
        position={Position.Right}
        id="brain-source"
        className="flow-handle brain-handle-source"
      />
    </div>
  );
}
