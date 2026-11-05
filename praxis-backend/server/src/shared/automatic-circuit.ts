import { z } from 'zod';
import type { CircuitInput } from '../schemas/connectivity.js';
import type { connectionProjection } from '../services/connection-projection.js';
import type { HybridState } from './hybrid-geometry.js';
import type { AutomaticDiagnosis } from './automatic-diagnosis.js';

export const normalizedPoint = z.tuple([
  z.number().finite().min(0).max(999),
  z.number().finite().min(0).max(999),
]);
export const gridLandmarkSchema = z
  .object({
    hole: z.string().regex(/^[a-j][1-9][0-9]?$/),
    position: normalizedPoint,
  })
  .strict();
export const boardObservationSchema = z
  .object({
    rows: z.union([z.literal(30), z.literal(63)]),
    landmarks: z.array(gridLandmarkSchema).min(6).max(24),
    rails: z
      .array(
        z
          .object({
            label: z.enum(['positive', 'negative', 'unmarked']),
            count: z.union([z.literal(25), z.literal(50)]),
            layout: z.enum(['uniform', 'groups-of-five']),
            first: normalizedPoint,
            last: normalizedPoint,
          })
          .strict(),
      )
      .max(4),
    note: z.string().max(1200),
  })
  .strict();
export const inventorySchema = z
  .object({
    boards: z.array(boardObservationSchema).max(2),
    components: z
      .array(
        z
          .object({
            label: z.string().min(1).max(100),
            type: z.enum([
              'jumper_wire',
              'resistor',
              'led',
              'switch_assembly',
              'power_module',
              'capacitor',
              'transistor',
              'integrated_circuit',
              'connector',
              'unknown',
            ]),
            bbox: z.tuple([
              z.number().min(0).max(999),
              z.number().min(0).max(999),
              z.number().min(1).max(999),
              z.number().min(1).max(999),
            ]),
          })
          .strict(),
      )
      .max(24),
    warnings: z.array(z.string().max(1200)).max(20),
  })
  .strict();
export const terminalObservationSchema = z
  .object({
    terminals: z
      .array(
        z
          .object({
            label: z.string().min(1).max(80),
            position: normalizedPoint.nullable(),
            evidence: z.enum([
              'visible_insertion',
              'visible_contact',
              'occluded',
              'insufficient',
            ]),
            role: z.string().min(1).max(80).nullable(),
            marking: z.string().min(1).max(120).nullable(),
          })
          .strict(),
      )
      .max(16),
    note: z.string().max(1200),
  })
  .strict();
export interface CircuitInspection {
  id: string;
  imageHash: string;
  image: { width: number; height: number };
  createdAt: number;
  revision: number;
  status: 'queued' | 'running' | 'needs_review' | 'reviewed' | 'failed';
  stage: string;
  model: string;
  requestCount: number;
  warnings: string[];
  error: string | null;
  observations: z.infer<typeof inventorySchema> | null;
  input: CircuitInput | null;
  graph: ReturnType<typeof connectionProjection> | null;
  reviewedAt: number | null;
  reviewer: string | null;
  hybrid?: HybridState;
  diagnosis?: AutomaticDiagnosis;
}
