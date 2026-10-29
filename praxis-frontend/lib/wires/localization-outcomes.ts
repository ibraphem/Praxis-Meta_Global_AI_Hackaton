import type { EndpointResponse } from "./proposals";

export type EndpointOutcome =
  | "localized"
  | "abstained"
  | "no_anchor"
  | "crop_fragment"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "missing";

/** Derive from response evidence and actual crop availability, including older exports. */
export function endpointOutcomes(
  response: Pick<EndpointResponse, "endpoints" | "localization"> | null,
  execution = "missing",
): [EndpointOutcome, EndpointOutcome] {
  if (!response) {
    const unavailable: EndpointOutcome =
      execution === "failed" ||
      execution === "timed_out" ||
      execution === "interrupted"
        ? execution
        : "missing";
    return [unavailable, unavailable];
  }
  const local = response.localization;
  if (!local && ["failed", "timed_out", "interrupted"].includes(execution))
    return [execution, execution] as [EndpointOutcome, EndpointOutcome];
  return response.endpoints.map((e) => {
    if (local?.status === "crop_fragment") return "crop_fragment";
    if (local?.status === "failed" || local?.status === "timed_out") {
      const coarse = local.coarseEndpoints.find((c) => c.role === e.role);
      return local.frames.some((f) => f.role === e.role) ||
        coarse?.proposedImagePosition ||
        coarse?.connectorJunctionPosition
        ? local.status
        : "no_anchor";
    }
    if (
      local?.status === "no_anchor" ||
      (local && !local.frames.some((f) => f.role === e.role))
    )
      return "no_anchor";
    return e.evidence === "visible_insertion" && e.proposedImagePosition
      ? "localized"
      : "abstained";
  }) as [EndpointOutcome, EndpointOutcome];
}

export const endpointOutcomeLabels: Record<EndpointOutcome, string> = {
  localized:
    "Visible insertion proposed; strict hole resolution still required",
  abstained: "Model abstained from insertion localization",
  no_anchor: "Close-up skipped: no coarse anchor",
  crop_fragment: "Localization blocked: mask ends at a crop boundary",
  failed: "Close-up failed: insertion result unavailable",
  timed_out: "Close-up timed out: upstream outcome unknown",
  interrupted: "Attempt interrupted: insertion result unavailable",
  missing: "No result recorded",
};
