import type { EndpointResolutionDiagnostics } from "@/lib/wires/proposals";
export function EndpointResolutionDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: EndpointResolutionDiagnostics;
}) {
  return (
    <details className="endpoint-diagnostics">
      <summary>Inspect hole ranking and rejection diagnostics</summary>
      <p>
        Resolver: {diagnostics.reason.replaceAll("_", " ")}. Ranked candidates
        are diagnostics only; nearest does not establish insertion or
        acceptance.
      </p>
      {diagnostics.boards.map((board) => (
        <div key={board.boardId}>
          <strong>
            {board.boardId} · revision {board.calibrationRevision} ·{" "}
            {board.diagnosis.reason.replaceAll("_", " ")}
          </strong>
          <p>
            Strict limit: {board.diagnosis.policy.snapRadiusPitch} hole pitches
            · Required ambiguity margin:{" "}
            {board.diagnosis.policy.ambiguityMarginPitch}
          </p>
          <ol>
            {board.diagnosis.candidates.map((candidate) => (
              <li key={candidate.holeId}>
                {candidate.holeId}: {candidate.normalizedDistance.toFixed(4)}{" "}
                pitches · {candidate.distancePx.toFixed(2)} px
              </li>
            ))}
          </ol>
        </div>
      ))}
    </details>
  );
}
