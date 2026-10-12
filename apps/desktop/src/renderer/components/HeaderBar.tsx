interface HeaderBarProps {
  connected: boolean;
  activeCount: number;
}

export function HeaderBar({ connected, activeCount }: HeaderBarProps) {
  return (
    <header className="header-bar">
      <div className="header-brand">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          className="header-glyph"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="header-glyph-grad"
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
            stroke="url(#header-glyph-grad)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="5" cy="8" r="3" style={{ fill: "var(--accent-a)" }} />
          <circle cx="19" cy="16" r="3" style={{ fill: "var(--accent-b)" }} />
        </svg>
        <span className="header-wordmark">sinapse</span>
      </div>

      <div className="header-divider" />

      <div className="header-status">
        <span
          className={`daemon-dot ${connected ? "dot-online" : "dot-offline"}`}
          title={connected ? "Daemon conectado" : "Daemon desconectado"}
        />
        <span className="header-active-count">
          {activeCount} {activeCount === 1 ? "ativo" : "ativos"}
        </span>
      </div>
    </header>
  );
}
