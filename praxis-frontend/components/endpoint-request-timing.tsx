import { useEffect, useState } from "react";
import {
  timingBreakdown,
  type EndpointRequestTiming as RequestTiming,
} from "@/lib/wires/request-timing";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** The running clock stops on success, failure, cancellation, and discarded replies. */
export function EndpointRequestTiming({ timing }: { timing: RequestTiming }) {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (timing.status !== "running") return;
    const interval = setInterval(
      () => setElapsedMs(Math.max(0, performance.now() - timing.startedAtMs)),
      250,
    );
    return () => clearInterval(interval);
  }, [timing.status, timing.startedAtMs]);
  const parts = timingBreakdown(timing);
  return (
    <div className="endpoint-timing" aria-label="Endpoint request timing">
      <p>
        Endpoint request: <strong>{timing.status}</strong> ·{" "}
        <span aria-live="off">{seconds(timing.elapsedMs ?? elapsedMs)}</span>{" "}
        total
      </p>
      {timing.server && (
        <p>
          Backend: {seconds(timing.server.elapsedMs)}
          {parts.preparationMs !== null &&
            ` · Image preparation: ${seconds(parts.preparationMs)}`}
          {parts.groundingMs !== null &&
            ` · Visual grounding: ${seconds(parts.groundingMs)}`}
          {parts.museMs !== null &&
            ` · Muse: ${seconds(parts.museMs)}${parts.attempts > 1 ? ` (${parts.attempts} attempts)` : ""}`}
        </p>
      )}
      {timing.status === "running" && (
        <small>
          Preparing visual references and waiting for Muse. You can cancel this
          request.
        </small>
      )}
      {timing.server?.requestId && (
        <small>Request ID: {timing.server.requestId}</small>
      )}
    </div>
  );
}
