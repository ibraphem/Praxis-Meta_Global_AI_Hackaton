import type { Failure } from "@/lib/diagnostics";
import { Icon } from "./icons";

const sourceLabels = {
  backend: "Backend service",
  backend_provider: "Backend → Meta request",
  backend_analysis: "Backend analysis deadline",
  meta_api: "Meta API response",
  frontend_proxy: "Frontend server",
  client: "Client cancellation",
};

/** The primary message stays readable; diagnostic details are available for inspection. */
export function AnalysisError({
  failure,
  onDismiss,
}: {
  failure: Failure;
  onDismiss: () => void;
}) {
  const details = failure.details;
  return (
    <div className="analysis-error">
      <div className="error-banner" role="alert">
        <Icon name="info" width="18" height="18" />
        <span>{failure.message}</span>
        <button
          className="icon-button"
          type="button"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
          <Icon name="close" width="15" height="15" />
        </button>
      </div>
      {failure.requestId && (
        <details className="error-diagnostics" open>
          <summary>
            Analysis diagnostics <code>{failure.code}</code>
          </summary>
          <dl>
            {details && (
              <>
                <div>
                  <dt>Source</dt>
                  <dd>{sourceLabels[details.source]}</dd>
                </div>
                {details.stage && (
                  <div>
                    <dt>Stage</dt>
                    <dd>
                      <code>{details.stage}</code>
                    </dd>
                  </div>
                )}
                {details.phase && (
                  <div>
                    <dt>Phase</dt>
                    <dd>
                      {details.phase === "awaiting_response"
                        ? "Waiting for response headers"
                        : "Reading response body"}
                    </dd>
                  </div>
                )}
                {!!details.activeStages?.length && (
                  <div>
                    <dt>Active when stopped</dt>
                    <dd>{details.activeStages.join(", ")}</dd>
                  </div>
                )}
                {details.model && (
                  <div>
                    <dt>Model</dt>
                    <dd>{details.model}</dd>
                  </div>
                )}
                {details.attempt !== undefined && (
                  <div>
                    <dt>Attempt</dt>
                    <dd>{details.attempt}</dd>
                  </div>
                )}
                <div>
                  <dt>Elapsed at source</dt>
                  <dd>{(details.elapsedMs / 1000).toFixed(2)} seconds</dd>
                </div>
                {details.timeoutMs !== undefined && (
                  <div>
                    <dt>Deadline</dt>
                    <dd>{(details.timeoutMs / 1000).toFixed(2)} seconds</dd>
                  </div>
                )}
                {details.totalElapsedMs !== undefined && (
                  <div>
                    <dt>Total backend time</dt>
                    <dd>
                      {(details.totalElapsedMs / 1000).toFixed(2)} seconds
                    </dd>
                  </div>
                )}
                {details.upstreamStatus !== undefined && (
                  <div>
                    <dt>Meta / upstream status</dt>
                    <dd>{details.upstreamStatus}</dd>
                  </div>
                )}
              </>
            )}
            <div>
              <dt>Request ID</dt>
              <dd>
                <code>{failure.requestId}</code>
              </dd>
            </div>
          </dl>
          {!!details?.timings?.length && (
            <div className="timing-scroll">
              <table>
                <caption>Recorded stages and attempts</caption>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Attempt</th>
                    <th>Duration</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {details.timings.map((timing, index) => (
                    <tr key={index}>
                      <td>
                        {timing.stage}
                        {timing.kind === "retry_delay" ? " (retry wait)" : ""}
                      </td>
                      <td>{timing.attempt ?? "—"}</td>
                      <td>{(timing.durationMs / 1000).toFixed(2)}s</td>
                      <td>{timing.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="raw-error">
            <summary>View diagnostic JSON</summary>
            <pre tabIndex={0}>
              {JSON.stringify({ error: failure }, null, 2)}
            </pre>
          </details>
        </details>
      )}
    </div>
  );
}
