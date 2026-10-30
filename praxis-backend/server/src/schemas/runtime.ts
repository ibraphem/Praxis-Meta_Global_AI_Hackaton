import { z } from 'zod';
export const runtimeSchema = z
  .object({
    buildId: z.string().regex(/^[a-f0-9]{64}$/),
    representation: z.enum(['source', 'compiled']),
    algorithms: z
      .object({
        candidateLayer: z.literal('sam-candidate-layer-v1'),
        wireSelection: z.literal('preserve-wire-evidence-v1'),
        interpretation: z.literal('incremental-experiments-v2'),
      })
      .strict(),
  })
  .strict();
