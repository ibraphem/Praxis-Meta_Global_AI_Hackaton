import { z } from 'zod';
const point = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  })
  .strict();
const dimensions = z
  .object({
    width: z.number().int().positive().max(16000),
    height: z.number().int().positive().max(16000),
  })
  .strict();
export const measuredGeometrySchema = z
  .object({
    version: z.literal('opencv-lattice-v1'),
    image: dimensions,
    processing: dimensions,
    status: z.enum(['measured', 'unresolved']),
    reason: z.string().max(2000),
    holeCount: z.number().int().min(0).max(4000),
    fit: z
      .object({
        rows: z.union([z.literal(30), z.literal(63)]),
        observedRows: z.number().int().min(18).max(63),
        anchors: z.tuple([point, point, point, point]),
        holes: z
          .array(
            point.extend({
              column: z.number().int().min(0).max(9),
              row: z.number().int().min(0).max(62),
            }),
          )
          .min(60)
          .max(1000),
        pitch: z.number().positive(),
        rmsPitch: z.number().min(0).max(0.13),
        inlierRatio: z.number().min(0.7).max(1),
        rails: z
          .array(
            z
              .object({
                first: point,
                last: point,
                count: z.union([z.literal(25), z.literal(50)]),
                layout: z.enum(['uniform', 'groups-of-five']),
                observedCount: z.number().int().min(18).max(50),
                rmsPitch: z.number().min(0).max(0.1),
              })
              .strict(),
          )
          .max(4)
          .optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const geometryUploadSchema = z
  .object({
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    geometry: measuredGeometrySchema,
  })
  .strict();
export const localEndpointSchema = z
  .object({
    terminalId: z.string().min(1).max(160),
    componentId: z.string().min(1).max(160),
    position: point.nullable(),
    basis: z.enum([
      'mask_endpoint',
      'chromatic_trace',
      'exposed_lead',
      'connector_footprint',
      'external_connector',
      'unresolved',
    ]),
    status: z.enum(['supported', 'external', 'ambiguous', 'unresolved']),
    reason: z.string().max(1000),
    candidates: z
      .array(
        z
          .object({
            boardId: z.string().max(160),
            holeId: z.string().max(80),
            distancePitch: z.number().finite().min(0),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export const hybridStateSchema = z
  .object({
    geometry: measuredGeometrySchema,
    numbering: z
      .object({
        firstPrintedRow: z.number().int().min(1).max(63).nullable(),
        rowDirection: z.enum(['forward', 'reverse', 'unknown']),
        columnDirection: z.enum(['forward', 'reverse', 'unknown']),
        note: z.string().max(2000),
      })
      .strict()
      .nullable(),
    wireMasks: z
      .array(
        z
          .object({
            id: z.string().max(160),
            bbox: z.tuple([
              z.number().nonnegative(),
              z.number().nonnegative(),
              z.number().positive(),
              z.number().positive(),
            ]),
            mask: z
              .object({
                path: z
                  .string()
                  .min(1)
                  .max(18000)
                  .regex(/^[MLZ0-9 .\-]+$/),
                width: z.number().int().positive().max(8192),
                height: z.number().int().positive().max(8192),
              })
              .strict(),
            componentId: z.string().max(160).nullable(),
          })
          .strict(),
      )
      .max(100),
    endpoints: z.array(localEndpointSchema).max(500),
    localStatus: z.enum(['pending', 'ready', 'unresolved']),
  })
  .strict();
export type MeasuredGeometry = z.infer<typeof measuredGeometrySchema>;
export type HybridState = z.infer<typeof hybridStateSchema>;
export type LocalEndpoint = z.infer<typeof localEndpointSchema>;
