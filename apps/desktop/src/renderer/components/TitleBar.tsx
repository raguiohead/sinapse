import { useState, useEffect } from "react";

export interface TitleBarProps {
  connected: boolean;
  activeCount: number;
  onOpenSettings: () => void;
  chromaticBar?: "animada" | "estatica" | "desligada";
}

export function TitleBar({
  connected,
  activeCount,
  onOpenSettings,
  chromaticBar = "animada",
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    window.sinapse?.windowControls?.isMaximized?.().then((max) => {
      setIsMaximized(Boolean(max));
    });

    const unsub = window.sinapse?.windowControls?.onMaximizedChanged?.((max) => {
      setIsMaximized(Boolean(max));
    });

    return () => {
      if (unsub) unsub();
    };
  }, []);

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    window.sinapse?.windowControls?.toggleMaximize?.();
  };

  return (
    <header className="title-bar" onDoubleClick={handleDoubleClick}>
      <div className="title-bar-left">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          className="title-glyph"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="title-glyph-grad"
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
          <path
            d="M 5 8 C 11 8, 13 16, 19 16"
            stroke="url(#title-glyph-grad)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="5" cy="8" r="3" style={{ fill: "var(--accent-a)" }} />
          <circle cx="19" cy="16" r="3" style={{ fill: "var(--accent-b)" }} />
        </svg>

        <span className="title-wordmark">sinapse</span>

        <div className="title-divider" />

        <div className="title-status">
          <span
            className={`daemon-dot ${connected ? "dot-online" : "dot-offline"}`}
            title={connected ? "Daemon conectado" : "Daemon desconectado"}
          />
          <span className="title-active-count">
            {activeCount} {activeCount === 1 ? "ativo" : "ativos"}
          </span>
        </div>
      </div>

      <div className="title-bar-right">
        <button
          type="button"
          onClick={onOpenSettings}
          className="title-bar-btn"
          title="Configurações"
          aria-label="Configurações"
        >
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
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => window.sinapse?.windowControls?.minimize?.()}
          className="title-bar-btn"
          title="Minimizar"
          aria-label="Minimizar"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => window.sinapse?.windowControls?.toggleMaximize?.()}
          className="title-bar-btn"
          title={isMaximized ? "Restaurar" : "Maximizar"}
          aria-label={isMaximized ? "Restaurar" : "Maximizar"}
        >
          {isMaximized ? (
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
              <rect x="4" y="8" width="12" height="12" rx="1.5" />
              <path d="M8 4h10a2 2 0 0 1 2 2v10" />
            </svg>
          ) : (
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
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={() => window.sinapse?.windowControls?.close?.()}
          className="title-bar-btn title-bar-close"
          title="Fechar"
          aria-label="Fechar"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
      </div>

      {chromaticBar !== "desligada" && (
        <div
          className={`chromatic-strip ${
            chromaticBar === "animada" ? "chromatic-animated" : "chromatic-static"
          }`}
        />
      )}
    </header>
  );
}
