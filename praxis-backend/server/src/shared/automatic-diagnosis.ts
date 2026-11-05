import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const holeTarget = z
  .object({
    boardId: id,
    holeId: id,
    position: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict(),
  })
  .strict();

export const automaticDiagnosisSchema = z
  .object({
    status: z.enum([
      'repair_ready',
      'no_fault',
      'needs_intent',
      'no_safe_repair',
    ]),
    sourceRevision: z.number().int().nonnegative(),
    sourceImageHash: z.string().regex(/^[a-f0-9]{64}$/),
    verificationOf: z.uuid().nullable(),
    requestedGoal: z.string().max(500),
    intendedBehavior: z.string().min(1).max(1000),
    confidence: z.enum(['high', 'medium', 'low']),
    assumptions: z.array(z.string().min(1).max(500)).max(12),
    relationships: z
      .array(
        z
          .object({
            fromTerminalId: id,
            toTerminalId: id,
            reason: z.string().min(1).max(500),
            satisfied: z.boolean(),
          })
          .strict(),
      )
      .max(24),
    explanation: z.string().min(1).max(2000),
    repair: z
      .object({
        id,
        componentId: id,
        terminalId: id,
        targetTerminalId: id,
        from: holeTarget,
        to: holeTarget,
        instruction: z.string().min(1).max(1000),
        rationale: z.string().min(1).max(1000),
        safety: z.string().min(1).max(500),
      })
      .strict()
      .nullable(),
    model: z.string().min(1).max(100),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type AutomaticDiagnosis = z.infer<typeof automaticDiagnosisSchema>;
