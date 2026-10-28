import type { ImageSize } from "@/lib/breadboard/calibration";
import type {
  WireAssignment,
  AssignmentValidity,
} from "@/lib/wires/assignments";

/** Mark insertion observations only. A straight line would invent a physical wire path. */
export function WireEndpointOverlay({
  assignment,
  image,
  validity,
}: {
  assignment: WireAssignment;
  image: ImageSize;
  validity: AssignmentValidity;
}) {
  if (validity.status === "stale") return null;
  const radius = Math.max(image.width, image.height) / 90;
  return (
    <svg
      className="endpoint-overlay"
      viewBox={`0 0 ${image.width} ${image.height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Manually selected wire insertion positions; electrical contact unknown"
    >
      {assignment.endpoints.map((endpoint, index) => {
        if (!endpoint) return null;
        const resolved = endpoint.resolution.status === "resolved";
        const p =
          endpoint.resolution.status === "resolved"
            ? endpoint.resolution.imagePosition
            : endpoint.selectedImagePosition;
        if (p.x < 0 || p.y < 0 || p.x >= image.width || p.y >= image.height)
          return null;
        return (
          <g
            key={index}
            className={resolved ? "endpoint-resolved" : "endpoint-unknown"}
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={radius}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={Math.min(image.width - radius, p.x + radius)}
              y={Math.max(radius * 2, p.y - radius)}
              fontSize={Math.max(image.width, image.height) / 55}
            >
              {index + 1}
              {resolved ? "" : " ?"}
            </text>
            <title>{`Endpoint ${index + 1}: manual selection; ${endpoint.boardId}:${endpoint.resolution.status === "resolved" ? endpoint.resolution.holeId : "unknown hole"}; electrical contact unknown`}</title>
          </g>
        );
      })}
    </svg>
  );
}
