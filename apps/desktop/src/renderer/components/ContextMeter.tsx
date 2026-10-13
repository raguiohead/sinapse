import type { ContextUsage } from "@sinapse/core";

export interface ContextMeterProps {
  usage?: ContextUsage;
  className?: string;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    const val = count / 1_000_000;
    return val % 1 === 0 ? `${val}M` : `${val.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const val = Math.round(count / 1_000);
    return `${val}k`;
  }
  return `${count}`;
}

function getBarColor(ratio: number): string {
  if (ratio < 0.6) return "var(--accent-a)";
  if (ratio <= 0.85) return "var(--thinking)";
  return "var(--error)";
}

export function ContextMeter({ usage, className = "" }: ContextMeterProps) {
  if (!usage || typeof usage.usedTokens !== "number") {
    return (
      <div className={`context-meter ${className}`} title="Sem uso de contexto registrado">
        <div className="context-meter-track">
          <div className="context-meter-bar" style={{ width: "0%" }} />
        </div>
        <span className="context-meter-label">sem uso ainda</span>
      </div>
    );
  }

  const used = usage.usedTokens;
  const windowTokens = usage.windowTokens;

  if (!windowTokens || windowTokens <= 0) {
    return (
      <div className={`context-meter ${className}`} title={`${used} tokens`}>
        <div className="context-meter-track">
          <div className="context-meter-bar" style={{ width: "0%" }} />
        </div>
        <span className="context-meter-label">{formatTokens(used)} tokens</span>
      </div>
    );
  }

  const ratio = used / windowTokens;
  const percentage = Math.round(ratio * 100);
  const barWidth = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  const barColor = getBarColor(ratio);
  const prefix = usage.windowEstimated ? "≈" : "";
  const label = `${prefix}${formatTokens(used)} / ${formatTokens(windowTokens)} · ${percentage}%`;

  return (
    <div
      className={`context-meter ${className}`}
      title={`${used.toLocaleString("pt-BR")} de ${windowTokens.toLocaleString("pt-BR")} tokens (${percentage}%)`}
    >
      <div className="context-meter-track">
        <div
          className="context-meter-bar"
          style={{ width: barWidth, backgroundColor: barColor }}
        />
      </div>
      <span className="context-meter-label">{label}</span>
    </div>
  );
}
