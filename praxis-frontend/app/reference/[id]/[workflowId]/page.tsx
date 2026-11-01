import { ConnectorReferenceEditor } from "@/components/connector-reference-editor";
import { Suspense } from "react";
type Props = { params: Promise<{ id: string; workflowId: string }> };
export default function Page(props: Props) {
  return (
    <Suspense fallback={<p>Loading reference workspace…</p>}>
      <ReferenceWorkspace {...props} />
    </Suspense>
  );
}
async function ReferenceWorkspace({ params }: Props) {
  const { id, workflowId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[a-f0-9]{64}$/.test(workflowId))
    return <p>Invalid annotation link.</p>;
  return (
    <ConnectorReferenceEditor
      key={`${id}:${workflowId}`}
      analysisId={id}
      workflowId={workflowId}
    />
  );
}
