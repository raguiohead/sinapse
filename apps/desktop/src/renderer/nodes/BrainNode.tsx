import { useEffect, useRef } from "react";
import { Handle, Position } from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function BrainNode() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.25,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      theme: {
        background: "#0d0d15",
        foreground: "#d4d4d8",
        cursor: "#a1a1aa",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#38bdf8",
        white: "#f4f4f5",
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

    window.sinapse?.brain?.onData((data: string) => {
      term.write(data);
    });

    const onDataDisposable = term.onData((data: string) => {
      window.sinapse?.brain?.write(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndResize();
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(timer);
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  return (
    <div className="brain-node-card">
      <div className="brain-node-header">
        <div className="brain-node-title">
          <span className="brain-node-icon">🧠</span>
          <span className="brain-node-label">Brain (Claude)</span>
        </div>
        <div className="brain-node-tag">orchestrator</div>
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
