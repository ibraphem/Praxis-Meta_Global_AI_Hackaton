import { createAnalysisJobProxy } from "@/lib/server/analysis-job-proxy";
const proxy = createAnalysisJobProxy();
export async function GET(
  request: Request,
  context: RouteContext<"/api/analyses/[id]/[action]">,
) {
  const { id, action } = await context.params;
  if (
    ![
      "connectivity",
      "connectivity-evidence",
      "image",
      "automatic-targeting-evidence",
      "connector-annotation",
      "connector-annotation-image",
      "connector-validation-evidence",
      "connector-junction-evidence",
    ].includes(action)
  )
    return new Response(null, { status: 404 });
  return proxy(
    request,
    action as
      | "connectivity"
      | "connectivity-evidence"
      | "image"
      | "automatic-targeting-evidence"
      | "connector-annotation"
      | "connector-annotation-image"
      | "connector-validation-evidence"
      | "connector-junction-evidence",
    id,
  );
}
export async function POST(
  request: Request,
  context: RouteContext<"/api/analyses/[id]/[action]">,
) {
  const { id, action } = await context.params;
  if (
    ![
      "save-connectivity-workspace",
      "review-connectivity",
      "build-connectivity",
      "register-connectivity-reference",
      "compare-connectivity",
      "save-connector-reference",
      "freeze-connector-reference",
      "evaluate-connector-reference",
      "prepare-connector-junctions",
      "run-connector-junctions",
      "review-connector-junction",
      "freeze-junction-reference",
      "evaluate-connector-junctions",
      "prepare-automatic-targeting",
      "run-automatic-targeting",
      "evaluate-automatic-targeting",
      "release-automatic-targeting",
      "retry-muse",
      "retry-scene",
      "start-scene",
      "reconcile-scene",
      "discover-terminals",
      "guide-scene",
      "refresh-scene",
      "retry-sam",
      "audit-wires",
      "recover-wires",
      "recover-short-wires",
      "verify-wire",
      "retry-wire-crop",
      "verify-wire-extension",
      "wire-identities",
      "interpret-recovery",
    ].includes(action)
  )
    return new Response(null, { status: 404 });
  return proxy(
    request,
    action as
      | "save-connectivity-workspace"
      | "review-connectivity"
      | "build-connectivity"
      | "register-connectivity-reference"
      | "compare-connectivity"
      | "save-connector-reference"
      | "freeze-connector-reference"
      | "evaluate-connector-reference"
      | "prepare-connector-junctions"
      | "run-connector-junctions"
      | "review-connector-junction"
      | "freeze-junction-reference"
      | "evaluate-connector-junctions"
      | "prepare-automatic-targeting"
      | "run-automatic-targeting"
      | "evaluate-automatic-targeting"
      | "release-automatic-targeting"
      | "retry-muse"
      | "retry-scene"
      | "start-scene"
      | "reconcile-scene"
      | "discover-terminals"
      | "guide-scene"
      | "refresh-scene"
      | "retry-sam"
      | "audit-wires"
      | "recover-wires"
      | "recover-short-wires"
      | "verify-wire"
      | "retry-wire-crop"
      | "verify-wire-extension"
      | "wire-identities"
      | "interpret-recovery",
    id,
  );
}
