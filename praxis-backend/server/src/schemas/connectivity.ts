import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const connectionStateSchema = z.enum([
  'confirmed_auto',
  'confirmed_manual',
  'unresolved',
  'rejected',
]);
export const circuitPointSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  })
  .strict();
export const circuitProofSchema = z
  .object({
    id,
    source: z.enum([
      'workspace_import',
      'scene_observation',
      'human_review',
      'registered_topology',
      'derived',
      'synthetic_fixture',
    ]),
    reviewer: z.string().min(1).max(100).nullable(),
    note: z.string().max(2000),
    timestamp: z.number().int().nonnegative(),
  })
  .strict();
const proofs = z.array(circuitProofSchema).max(200);
export const circuitBoardSchema = z
  .object({
    id,
    revision: z.number().int().positive(),
    calibration: z
      .object({
        breadboardId: id,
        templateId: z.literal('standard-10-column-v1'),
        rows: z.union([z.literal(30), z.literal(63)]),
        image: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict(),
        anchors: z.tuple([
          circuitPointSchema,
          circuitPointSchema,
          circuitPointSchema,
          circuitPointSchema,
        ]),
        forward: z.array(z.number().finite()).length(9),
        inverse: z.array(z.number().finite()).length(9),
      })
      .strict(),
    rails: z
      .array(
        z
          .object({
            id: z.string().regex(/^R[1-4]$/),
            label: z.enum(['unmarked', 'positive', 'negative']),
            count: z.union([z.literal(25), z.literal(50)]),
            layout: z.enum(['uniform', 'groups-of-five']),
            first: circuitPointSchema.extend({
              x: z.number().finite(),
              y: z.number().finite(),
            }),
            last: circuitPointSchema.extend({
              x: z.number().finite(),
              y: z.number().finite(),
            }),
            connectivity: z.enum(['unknown', 'continuous', 'split']),
            splitAfter: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(4),
    topologyState: connectionStateSchema,
    evidence: proofs,
  })
  .strict();
export const circuitComponentSchema = z
  .object({
    id,
    label: z.string().min(1).max(160),
    type: z.string().min(1).max(100),
    objectRef: z
      .object({ kind: z.enum(['baseline', 'scene', 'manual']), id })
      .strict(),
    bbox: z
      .tuple([
        z.number().nonnegative(),
        z.number().nonnegative(),
        z.number().positive(),
        z.number().positive(),
      ])
      .nullable(),
    terminalIds: z.array(id).max(16),
    state: connectionStateSchema,
    continuity: connectionStateSchema,
    evidence: proofs,
  })
  .strict();
export const circuitTerminalSchema = z
  .object({
    id,
    componentId: id,
    label: z.string().min(1).max(100),
    role: z.string().min(1).max(80).nullable(),
    roleState: connectionStateSchema,
    position: circuitPointSchema.nullable(),
    evidence: proofs,
  })
  .strict();
export const circuitTargetSchema = z.union([
  z
    .object({
      kind: z.literal('hole'),
      boardId: id,
      holeId: id,
      calibrationRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal('terminal'), terminalId: id }).strict(),
]);
export const circuitAssociationSchema = z
  .object({
    id,
    terminalId: id,
    target: circuitTargetSchema.nullable(),
    type: z.enum([
      'insertion',
      'conductive_contact',
      'housing_entry',
      'proximity',
    ]),
    state: connectionStateSchema,
    evidence: proofs,
    originalProposalRef: z.string().max(200).nullable(),
  })
  .strict();
export const circuitInputSchema = z
  .object({
    schemaVersion: z.literal('praxis-connectivity-input-v1'),
    analysisId: z.uuid(),
    imageHash: hash,
    revision: z.number().int().nonnegative(),
    validationScope: z
      .enum(['photograph', 'synthetic_fixture'])
      .default('photograph'),
    coverage: z
      .object({ state: connectionStateSchema, evidence: proofs })
      .strict()
      .default({ state: 'unresolved', evidence: [] }),
    boards: z.array(circuitBoardSchema).max(10),
    components: z.array(circuitComponentSchema).max(500),
    terminals: z.array(circuitTerminalSchema).max(2000),
    associations: z.array(circuitAssociationSchema).max(4000),
  })
  .strict();
export const circuitReferenceSchema = z
  .object({
    schemaVersion: z.literal('praxis-reference-circuit-v1'),
    id,
    version: z.number().int().positive(),
    name: z.string().min(1).max(200),
    qualification: z.enum(['verified_human', 'synthetic_fixture', 'draft']),
    schematicSource: z.string().min(1).max(2000),
    reviewer: z.string().min(1).max(100),
    components: z
      .array(
        z
          .object({
            id,
            type: z.string().min(1).max(100),
            terminalRoles: z.array(z.string().min(1).max(80)).min(1).max(16),
            value: z.string().max(100).nullable(),
            partNumber: z.string().max(100).nullable(),
            package: z.string().max(100).nullable().default(null),
            pinoutSource: z.string().max(2000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    nets: z
      .array(z.object({ id, terminals: z.array(id).min(1).max(300) }).strict())
      .max(300),
    rules: z
      .array(
        z
          .object({
            id,
            kind: z.literal('required_conductive_path'),
            from: id,
            to: id,
            jumper: id,
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type CircuitInput = z.infer<typeof circuitInputSchema>;
export type CircuitBoard = z.infer<typeof circuitBoardSchema>;
export type CircuitComponent = z.infer<typeof circuitComponentSchema>;
export type CircuitTerminal = z.infer<typeof circuitTerminalSchema>;
export type CircuitAssociation = z.infer<typeof circuitAssociationSchema>;
export type CircuitProof = z.infer<typeof circuitProofSchema>;
export type CircuitReference = z.infer<typeof circuitReferenceSchema>;
export const confirmed = (state: z.infer<typeof connectionStateSchema>) =>
  state === 'confirmed_manual' || state === 'confirmed_auto';
