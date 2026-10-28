import type { ImageSize } from "@/lib/breadboard/calibration";
import type {
  WireAssignment,
  AssignmentValidity,
} from "@/lib/wires/assignments";
import type { WireEndpointReview } from "@/lib/wires/proposals";

/** Mark insertion observations only. A straight line would invent a physical wire path. */
export function WireEndpointOverlay({
  assignment,
  image,
  validity,
  review,
}: {
  assignment?: WireAssignment;
  review?: WireEndpointReview;
  image: ImageSize;
  validity: AssignmentValidity;
}) {
  if (validity.status === "stale") return null;
  const radius = Math.max(image.width, image.height) / 90;
  if (review)
    return (
      <svg
        className="endpoint-overlay"
        viewBox={`0 0 ${image.width} ${image.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="AI proposed and user-reviewed insertion positions; electrical contact unknown"
      >
        {review.endpoints.map((endpoint, index) => {
          const original = endpoint.originalProposal.proposedImagePosition;
          const position = endpoint.finalPosition ?? original;
          const observation = endpoint.observation;
          const snapped =
            observation?.resolution.status === "resolved"
              ? observation.resolution.imagePosition
              : null;
          const p =
            snapped ?? (position ? { x: position[0], y: position[1] } : null);
          const pending = review.pendingCorrections[index];
          return (
            <g key={endpoint.role}>
              {original && endpoint.reviewStatus === "corrected" && (
                <g className="endpoint-proposed endpoint-original">
                  <circle
                    cx={original[0]}
                    cy={original[1]}
                    r={radius}
                    vectorEffect="non-scaling-stroke"
                  />
                  <title>
                    Original AI proposal {endpoint.role}; superseded by
                    correction
                  </title>
                </g>
              )}
              {p && (
                <g className={`endpoint-${endpoint.reviewStatus}`}>
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
                    {endpoint.role}
                    {endpoint.reviewStatus === "unknown" ? " ?" : ""}
                  </text>
                  <title>{`Endpoint ${endpoint.role}: ${endpoint.reviewStatus}; ${endpoint.finalHole ? `${endpoint.finalHole.boardId}:${endpoint.finalHole.holeId}` : "no reviewed hole"}; electrical contact unknown`}</title>
                </g>
              )}
              {pending && (
                <g className="endpoint-pending">
                  <circle
                    cx={pending.selectedImagePosition.x}
                    cy={pending.selectedImagePosition.y}
                    r={radius * 1.3}
                    vectorEffect="non-scaling-stroke"
                  />
                  <title>
                    Endpoint {endpoint.role}: pending correction, awaiting
                    confirmation
                  </title>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    );
  if (!assignment) return null;
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
