import { z } from "zod";
import { inventorySchema } from "../../praxis-backend/server/src/shared/automatic-circuit";
import { circuitInputSchema } from "../../praxis-backend/server/src/schemas/connectivity";
import { projection } from "./circuit-session";
import { hybridStateSchema } from "../../praxis-backend/server/src/shared/hybrid-geometry";
import { automaticDiagnosisSchema } from "../../praxis-backend/server/src/shared/automatic-diagnosis";
export type { CircuitInspection } from "../../praxis-backend/server/src/shared/automatic-circuit";
export type { CircuitInput } from "../../praxis-backend/server/src/schemas/connectivity";
export const inspectionSchema = z
  .object({
    id: z.uuid(),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    image: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    createdAt: z.number(),
    revision: z.number().int().nonnegative(),
    status: z.enum(["queued", "running", "needs_review", "reviewed", "failed"]),
    stage: z.string(),
    model: z.string(),
    requestCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    error: z.string().nullable(),
    observations: inventorySchema.nullable(),
    input: circuitInputSchema.nullable(),
    graph: projection.nullable(),
    reviewedAt: z.number().nullable(),
    reviewer: z.string().nullable(),
    hybrid: hybridStateSchema.optional(),
    diagnosis: automaticDiagnosisSchema.optional(),
  })
  .strict();
export function parseInspection(raw: unknown, id?: string) {
  const v = inspectionSchema.parse(raw);
  if (
    (id && v.id !== id) ||
    (v.input &&
      (v.input.analysisId !== v.id || v.input.imageHash !== v.imageHash))
  )
    throw Error("Inspection image does not match.");
  return v;
}
