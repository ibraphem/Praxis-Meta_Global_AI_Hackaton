import type { CircuitInput, CircuitInspection } from "../automatic-circuit";
export function canConfirmMeasuredGrid(
  view: CircuitInspection,
  input: CircuitInput,
) {
  const fit = view.hybrid?.geometry.fit,
    n = view.hybrid?.numbering;
  return (
    input.boards.length > 0 &&
    (input.boards.every((b) => b.topologyState === "confirmed_manual") ||
      (!!fit &&
        !!n &&
        fit.observedRows === fit.rows &&
        n.firstPrintedRow === (n.rowDirection === "reverse" ? fit.rows : 1) &&
        n.rowDirection !== "unknown" &&
        n.columnDirection !== "unknown"))
  );
}
export function confirmClearProposals(
  view: CircuitInspection,
  draft: CircuitInput,
): CircuitInput {
  if (!view.hybrid || !canConfirmMeasuredGrid(view, draft))
    throw Error(
      "Check the printed board numbering before confirming connections.",
    );
  const input = structuredClone(draft);
  input.boards.forEach((b) => {
    b.topologyState = "confirmed_manual";
  });
  for (const c of input.components)
    if (c.state !== "rejected") c.state = "confirmed_manual";
  for (const e of view.hybrid.endpoints) {
    if (e.status !== "supported") continue;
    const a = input.associations.find((a) => a.terminalId === e.terminalId),
      t = input.terminals.find((t) => t.id === e.terminalId);
    if (
      a?.target &&
      t &&
      input.components.find((c) => c.id === t.componentId)?.state ===
        "confirmed_manual"
    ) {
      a.state = "confirmed_manual";
      t.position = e.position;
    }
  }
  for (const c of input.components)
    if (
      c.type === "jumper_wire" &&
      c.state === "confirmed_manual" &&
      c.terminalIds.length === 2 &&
      c.terminalIds.every((id) =>
        input.associations.some(
          (a) => a.terminalId === id && a.state === "confirmed_manual",
        ),
      )
    )
      c.continuity = "confirmed_manual";
  return input;
}
