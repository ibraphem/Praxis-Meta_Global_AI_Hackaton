import type { Point, Rows } from "./calibration";

/** Named slots stay stable while a single mistaken reference is replaced. */
export function referenceNames(rows: Rows): [string, string, string, string] {
  return ["a1", "j1", `j${rows}`, `a${rows}`];
}
export function referenceTarget(
  anchors: Point[],
  editing: number | null,
): number | null {
  if (
    editing !== null &&
    Number.isInteger(editing) &&
    editing >= 0 &&
    editing < anchors.length
  )
    return editing;
  return anchors.length < 4 ? anchors.length : null;
}
export function placeReference(
  anchors: Point[],
  editing: number | null,
  point: Point,
): Point[] {
  const target = referenceTarget(anchors, editing);
  if (target === null) return anchors;
  const next = anchors.map((anchor) => ({ ...anchor }));
  next[target] = { ...point };
  return next;
}
export function referenceInstruction(
  rows: Rows,
  anchors: Point[],
  editing: number | null,
  valid: boolean,
  error: string,
): string {
  const target = referenceTarget(anchors, editing);
  if (target !== null)
    return `${target < anchors.length ? "Replace" : "Set"} ${referenceNames(rows)[target]}: click the center of that terminal hole. ${target < anchors.length ? "Other references will stay in place." : `Reference ${target + 1} of 4.`}`;
  if (error || !valid)
    return "Correct the reference points. No valid grid is available. Choose a reference below, then click its actual hole center.";
  return "Check the grid across the entire board, including interior holes. Confirm only if it aligns. Select any reference below to correct it.";
}
