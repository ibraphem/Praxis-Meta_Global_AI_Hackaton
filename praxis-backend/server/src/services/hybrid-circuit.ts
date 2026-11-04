import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { PreparedImage } from '../schemas/vision.js';
import type { CircuitInput } from '../schemas/connectivity.js';
import type {
  HybridState,
  MeasuredGeometry,
} from '../shared/hybrid-geometry.js';
import { inventorySchema } from '../shared/automatic-circuit.js';
import {
  calibrateBoard,
  project,
  registerRail,
} from '../shared/calibration.js';
import { circuitVisionRequest } from './automatic-circuit.js';
import { decodeSamResponse } from './sam.js';
import { museInput } from './muse-image.js';
import { simplifyPath } from './wire-geometry.js';
import { decodeMaskToSVGPath } from '@meta-sam/parser';
import { maskSchema } from '../schemas/geometry.js';

const semanticSchema = z
  .object({
    numbering: z
      .object({
        firstPrintedRow: z.number().int().min(1).max(63).nullable(),
        rowDirection: z.enum(['forward', 'reverse', 'unknown']),
        columnDirection: z.enum(['forward', 'reverse', 'unknown']),
        note: z.string().max(2000),
      })
      .strict(),
    components: z
      .array(
        inventorySchema.shape.components.element
          .extend({ wireMaskId: z.string().max(80).nullable() })
          .strict(),
      )
      .max(24),
    warnings: inventorySchema.shape.warnings,
  })
  .strict();
export async function proposeHybridCircuit(args: {
  config: Config;
  client: MetaClient;
  image: PreparedImage;
  id: string;
  imageHash: string;
  geometry: MeasuredGeometry;
  signal: AbortSignal;
  request: () => void;
  checkpoint: (value: {
    input: CircuitInput;
    observations: z.infer<typeof inventorySchema>;
    hybrid: HybridState;
    warnings: string[];
    stage: string;
  }) => void;
}) {
  const { image, geometry, config, client, signal } = args,
    full = (await museInput(image, [], 1600)).image;
  const wireMasks: HybridState['wireMasks'] = [],
    segmentationWarnings: string[] = [];
  try {
    args.request();
    const raw = await client.post(
      'responses',
      {
        model: config.META_SAM_MODEL,
        stream: false,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'wire' },
              { type: 'input_image', image_url: image.dataUrl },
            ],
          },
        ],
        metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
      },
      signal,
      {
        stage: 'sam.jumper_wire',
        maxRetries: 0,
        timeoutMs: config.CIRCUIT_INSPECTION_REQUEST_TIMEOUT_MS,
        imageDimensions: [{ width: image.width, height: image.height }],
      },
    );
    const detections = decodeSamResponse(raw, 'jumper_wire', image, true);
    let pixels = 0,
      pathBytes = 0;
    for (const [index, d] of detections.entries()) {
      const encoded = d.encodedMask;
      if (
        !encoded ||
        encoded.width * encoded.height > 4000000 ||
        pixels + encoded.width * encoded.height > 12000000
      )
        continue;
      pixels += encoded.width * encoded.height;
      try {
        const path = simplifyPath(decodeMaskToSVGPath(encoded));
        const checked = maskSchema.safeParse({
          format: 'svg_path',
          width: encoded.width,
          height: encoded.height,
          path,
        });
        if (!checked.success || pathBytes + path.length > 120000) continue;
        pathBytes += path.length;
        wireMasks.push({
          id: `mask_${index + 1}`,
          bbox: d.bbox,
          mask: { path, width: encoded.width, height: encoded.height },
          componentId: null,
        });
      } catch {}
    }
  } catch {
    signal.throwIfAborted();
    segmentationWarnings.push(
      'Wire segmentation was unavailable. Local endpoint suggestions remain unresolved; no model request was repeated.',
    );
  }
  let annotation = full;
  if (geometry.fit) {
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}">`;
    const rows = new Map<number, { x: number; y: number; column: number }>();
    for (const h of geometry.fit.holes)
      if (!rows.has(h.row) || h.column < rows.get(h.row)!.column)
        rows.set(h.row, h);
    for (const [row, p] of rows)
      svg += `<text x="${p.x}" y="${p.y}" font-size="${image.width / 65}" fill="#00ffcc" stroke="#000" stroke-width="2" paint-order="stroke">R${row}</text>`;
    for (const m of wireMasks) {
      const b = m.bbox;
      svg += `<g transform="translate(${b[0]} ${b[1]}) scale(${b[2] / m.mask.width} ${b[3] / m.mask.height})"><path d="${m.mask.path}" fill="#ff8533" fill-opacity=".15" stroke="#ff8533" stroke-width="3"/></g><text x="${b[0]}" y="${Math.max(45, b[1] + 35)}" font-size="${image.width / 65}" fill="#ff8533" stroke="black" stroke-width="2" paint-order="stroke">${m.id}</text>`;
    }
    svg += '</svg>';
    const overlay = await sharp(
      Buffer.from(image.dataUrl.split(',')[1]!, 'base64'),
    )
      .composite([{ input: Buffer.from(svg) }])
      .jpeg()
      .toBuffer();
    annotation = (
      await museInput(
        {
          ...image,
          dataUrl: `data:image/jpeg;base64,${overlay.toString('base64')}`,
        },
        [],
        1600,
      )
    ).image;
  }
  args.request();
  const semantics = await circuitVisionRequest(
    config,
    client,
    semanticSchema,
    'circuit_semantics',
    `Identify the components and readable breadboard numbering in IMAGE 1. IMAGE 2 has computer-measured row markers R0, R1 etc; they are temporary geometry indices, NOT printed breadboard row numbers. The measured board has ${geometry.fit?.rows ?? 'unknown'} rows and ${geometry.fit?.observedRows ?? 0} observed row positions. Return firstPrintedRow: the printed physical row number of measured row R0, or null if unreadable. rowDirection=forward if printed numbers increase with R index, reverse if decrease, unknown otherwise. columnDirection=forward if the measured first five-column bank (left for upright boards, upper for sideways boards) is printed a-e in increasing order, reverse if it is j-f; unknown if unreadable. Do not predict hole centres or terminal positions. IMAGE 2 also shows orange segmentation candidates labelled mask_N. These may represent a complete wire, a fragment, a component lead or an unrelated cable. For each inventoried jumper wire, set wireMaskId to its one visually corresponding mask ID, or null when ambiguous/absent. Never assign the same mask to two components. Bare resistor or LED legs are not jumper wires. Candidate IDs: ${wireMasks.map((m) => m.id).join(', ')}. Inventory up to 24 distinct objects, including short wires, keeping each power module as one assembly. Component bbox is only a COARSE whole-object search region [left,top,width,height] normalized 0–999 in IMAGE 1; include its leads and both connector housings where visible. Do not invent hidden pinouts, polarity from wire colour, or expected wiring.`,
    [full, annotation],
    signal,
  );
  const warnings = [...segmentationWarnings, ...semantics.warnings];
  const hybrid: HybridState = {
    geometry,
    numbering: semantics.numbering,
    wireMasks,
    endpoints: [],
    localStatus: 'pending',
  };
  const input: CircuitInput = {
    schemaVersion: 'praxis-connectivity-input-v1',
    analysisId: args.id,
    imageHash: args.imageHash,
    revision: 0,
    validationScope: 'photograph',
    coverage: { state: 'unresolved', evidence: [] },
    boards: [],
    components: [],
    terminals: [],
    associations: [],
  };
  if (geometry.fit) {
    const fit = geometry.fit;
    let anchors = fit.anchors;
    const mapping = semantics.numbering;
    if (mapping.rowDirection === 'reverse')
      anchors = [anchors[3], anchors[2], anchors[1], anchors[0]];
    if (mapping.columnDirection === 'reverse')
      anchors = [anchors[1], anchors[0], anchors[3], anchors[2]];
    // Missing rows need a reviewed origin, rather than silently shifting every hole ID.
    const expectedFirst = mapping.rowDirection === 'reverse' ? fit.rows : 1;
    if (
      mapping.firstPrintedRow !== expectedFirst ||
      fit.observedRows !== fit.rows ||
      mapping.rowDirection === 'unknown' ||
      mapping.columnDirection === 'unknown'
    )
      warnings.push(
        'Printed grid origin or orientation is uncertain. Check the board numbering before confirming connections.',
      );
    const calibration = calibrateBoard('board_1', fit.rows, image, anchors);
    // Only dimensions belong in persisted calibration metadata.
    calibration.image = { width: image.width, height: image.height };
    input.boards.push({
      id: 'board_1',
      revision: 1,
      calibration,
      rails: (fit.rails ?? []).flatMap((r, index) => {
        try {
          return [
            registerRail(
              calibration,
              {
                id: `R${index + 1}`,
                label: 'unmarked',
                count: r.count,
                layout: r.layout,
                connectivity: 'unknown',
                splitAfter: null,
              },
              r.first,
              r.last,
            ),
          ];
        } catch {
          return [];
        }
      }),
      topologyState: 'unresolved',
      evidence: [],
    });
  } else
    warnings.push(`Local grid detection needs attention: ${geometry.reason}`);
  for (const [index, c] of semantics.components.entries()) {
    if (
      c.type === 'jumper_wire' &&
      c.wireMaskId &&
      semantics.components.filter((other) => other.wireMaskId === c.wireMaskId)
        .length === 1
    ) {
      const m = wireMasks.find((m) => m.id === c.wireMaskId);
      if (m) m.componentId = `part_${index + 1}`;
    }
    const id = `part_${index + 1}`,
      x = (c.bbox[0] / 999) * (image.width - 1),
      y = (c.bbox[1] / 999) * (image.height - 1);
    input.components.push({
      id,
      label: c.label,
      type: c.type,
      objectRef: { kind: 'manual', id },
      bbox: [
        x,
        y,
        Math.max(1, Math.min((c.bbox[2] / 999) * image.width, image.width - x)),
        Math.max(
          1,
          Math.min((c.bbox[3] / 999) * image.height, image.height - y),
        ),
      ],
      terminalIds: [],
      state: 'unresolved',
      continuity: 'unresolved',
      evidence: [],
    });
    const count = ['jumper_wire', 'resistor', 'led', 'capacitor'].includes(
      c.type,
    )
      ? 2
      : 0;
    for (let n = 0; n < count; n++) {
      const terminalId = `${id}_terminal_${n + 1}`;
      input.components[index]!.terminalIds.push(terminalId);
      input.terminals.push({
        id: terminalId,
        componentId: id,
        label: `Contact ${n + 1}`,
        position: null,
        role: null,
        roleState: 'unresolved',
        evidence: [],
      });
      input.associations.push({
        id: `association_${terminalId}`,
        terminalId,
        type: 'insertion',
        target: null,
        state: 'unresolved',
        evidence: [],
        originalProposalRef: terminalId,
      });
    }
  }
  const observations: z.infer<typeof inventorySchema> = {
    boards: input.boards.map((b) => ({
      rows: b.calibration.rows,
      landmarks: [
        'a1',
        'j1',
        `j${b.calibration.rows}`,
        `a${b.calibration.rows}`,
        'a15',
        'j15',
      ].map((hole) => {
        const col = 'abcdefghij'.indexOf(hole[0]!),
          p = project(b.calibration as Parameters<typeof project>[0], {
            x: col < 5 ? col : col + 2,
            y: Number(hole.slice(1)) - 1,
          });
        return {
          hole,
          position: [
            (p.x / (image.width - 1)) * 999,
            (p.y / (image.height - 1)) * 999,
          ],
        };
      }),
      rails: [],
      note: 'Grid geometry measured locally by OpenCV. Labels are semantic proposals.',
    })),
    components: semantics.components.map(({ wireMaskId, ...component }) => {
      void wireMaskId;
      return component;
    }),
    warnings: semantics.warnings,
  };
  const checkpoint = (stage: string) =>
    args.checkpoint({ input, observations, hybrid, warnings, stage });
  checkpoint('Matching measured wire endpoints to the board grid');
  return { input, observations, hybrid, warnings };
}
