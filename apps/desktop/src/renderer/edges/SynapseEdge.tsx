import { getBezierPath, type EdgeProps } from "@xyflow/react";

export type SynapsePulse = "idle" | "out" | "back";
/** "pin": a note pinned to a worker (note -> worker); deleting the edge unpins it. */
export type SynapseVariant = "default" | "author" | "contributor" | "creator" | "pin";

export interface SynapseEdgeData {
  pulse?: SynapsePulse;
  provider?: "claude" | "codex" | "agy" | string;
  variant?: SynapseVariant;
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
  selected,
}: EdgeProps) {
  const edgeData = (data ?? {}) as SynapseEdgeData;
  const pulse: SynapsePulse = edgeData.pulse ?? "idle";
  const provider = edgeData.provider ?? "claude";
  const variant: SynapseVariant = edgeData.variant ?? "default";

  const isContributor = variant === "contributor";
  const isCreator = variant === "creator";
  const isPin = variant === "pin";

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const safeId = id.replace(/[^a-zA-Z0-9-_]/g, "_");
  const providerColor =
    provider === "agy"
      ? "var(--agy)"
      : provider === "codex"
      ? "var(--codex)"
      : "var(--claude)";
  const isBack = pulse === "back";
  const isOut = pulse === "out";
  const isActive = isOut || isBack;
  const particleColor = isBack ? providerColor : "var(--accent-a)";

  const strokeWidth = isContributor
    ? pulse === "idle"
      ? 1
      : 1.8
    : pulse === "idle"
    ? 1.5
    : 2.5;

  const strokeDasharray = isCreator ? "5 4" : isPin ? "3 5" : undefined;

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

      {/* Pins are deletable: give the thin dashed line a wider click target. */}
      {isPin && (
        <path
          d={edgePath}
          fill="none"
          stroke="transparent"
          strokeWidth={16}
          className="react-flow__edge-interaction"
        />
      )}

      {/* Main Bezier path */}
      <path
        id={`edgepath-${safeId}`}
        d={edgePath}
        className={`synapse-edge-path ${pulse !== "idle" ? "synapse-active" : ""} ${
          isContributor ? "synapse-variant-contributor" : ""
        } ${isCreator ? "synapse-variant-creator" : ""} ${isPin ? "synapse-variant-pin" : ""}`}
        style={{
          stroke: isPin
            ? "var(--note-pin)"
            : pulse === "idle"
              ? "var(--edge-idle)"
              : isBack
              ? providerColor
              : `url(#synapse-grad-${safeId})`,
          strokeWidth: isPin ? (selected ? 2.5 : 1.5) : strokeWidth,
          strokeDasharray,
          filter: pulse !== "idle" ? `url(#synapse-glow-${safeId})` : undefined,
          fill: "none",
          opacity: isContributor ? 0.5 : isPin && !selected ? 0.7 : 1,
        }}
        markerEnd={markerEnd}
      />

      {/* Glowing particles travelling along the path */}
      {isActive && (
        <g
          className="synapse-particles"
          filter={`url(#synapse-glow-${safeId})`}
          style={{ opacity: isContributor ? 0.5 : 1 }}
        >
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
