import { getBezierPath, type EdgeProps } from "@xyflow/react";

export type SynapsePulse = "idle" | "out" | "back";

export interface SynapseEdgeData {
  pulse?: SynapsePulse;
  provider?: "claude" | "agy" | string;
}

export function SynapseEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const edgeData = (data ?? {}) as SynapseEdgeData;
  const pulse: SynapsePulse = edgeData.pulse ?? "idle";
  const provider = edgeData.provider ?? "claude";

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const safeId = id.replace(/[^a-zA-Z0-9-_]/g, "_");
  const providerColor = provider === "agy" ? "var(--agy)" : "var(--claude)";
  const isBack = pulse === "back";
  const isOut = pulse === "out";
  const isActive = isOut || isBack;
  const particleColor = isBack ? providerColor : "var(--accent-a)";

  // Negative begins start each particle mid-flight, so none sits at the SVG origin before moving.
  const delays = [0, -0.6, -1.2];

  return (
    <>
      <defs>
        <linearGradient
          id={`synapse-grad-${safeId}`}
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" style={{ stopColor: "var(--accent-a)" }} />
          <stop offset="100%" style={{ stopColor: "var(--accent-b)" }} />
        </linearGradient>
        <filter
          id={`synapse-glow-${safeId}`}
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Main Bezier path */}
      <path
        id={`edgepath-${safeId}`}
        d={edgePath}
        className={`synapse-edge-path ${pulse !== "idle" ? "synapse-active" : ""}`}
        style={{
          stroke:
            pulse === "idle"
              ? "var(--edge-idle)"
              : isBack
              ? providerColor
              : `url(#synapse-grad-${safeId})`,
          strokeWidth: pulse === "idle" ? 1.5 : 2.5,
          filter: pulse !== "idle" ? `url(#synapse-glow-${safeId})` : undefined,
          fill: "none",
        }}
        markerEnd={markerEnd}
      />

      {/* Glowing particles travelling along the path */}
      {isActive && (
        <g className="synapse-particles" filter={`url(#synapse-glow-${safeId})`}>
          {delays.map((delay, idx) => (
            <circle
              key={idx}
              r={3}
              style={{ fill: particleColor }}
              className="synapse-particle"
            >
              <animateMotion
                dur="1.8s"
                repeatCount="indefinite"
                begin={`${delay}s`}
                path={edgePath}
                keyPoints={isBack ? "1;0" : "0;1"}
                keyTimes="0;1"
                calcMode="linear"
              />
            </circle>
          ))}
        </g>
      )}
    </>
  );
}
