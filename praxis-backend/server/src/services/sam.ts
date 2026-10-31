import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError, abortError, invalidProviderOutput } from '../lib/errors.js';
import type { AnalysisTrace, Stage } from '../lib/diagnostics.js';
import type { MetaClient } from '../lib/meta-client.js';
import type {
  ComponentType,
  Detection,
  PreparedImage,
} from '../schemas/vision.js';
import type { WirePrompt } from '../schemas/geometry.js';

const responseSchema = z.object({
  status: z.literal('completed'),
  output: z.array(
    z.object({
      type: z.literal('message'),
      content: z.array(
        z.object({ type: z.literal('output_text'), text: z.string() }),
      ),
    }),
  ),
});

const concepts: ReadonlyArray<readonly [ComponentType, string]> = [
  ['breadboard', 'complete solderless breadboard'],
  ['led', 'LED'],
  ['resistor', 'resistor'],
  // A generic visual concept has better recall than the domain-specific name.
  // Muse filters bare component legs and other non-jumper regions afterwards.
  ['jumper_wire', 'wire'],
];

/**
 * Read the documented single-image SAM wire grammar, not an assumed JSON list.
 * Retain native masks in private checkpoints. Only wire geometry is published; other categories remain box-only.
 * https://dev.meta.ai/docs/sam/reading-segmentation
 */
export function parseSamOutput<T extends string>(
  text: string,
  type: T,
  image: Pick<PreparedImage, 'width' | 'height'>,
  retainMasks = false,
): Array<Omit<Detection, 'type'> & { type: T }> {
  const source = text.trim();
  if (source === '') return [];
  if (!source.startsWith('<0f>')) throw invalidProviderOutput();
  let cursor = 4;
  const detections: Array<Omit<Detection, 'type'> & { type: T }> = [];
  const seen = new Set<number>();
  while (cursor < source.length) {
    const header = /^(\d+)<\|box;/.exec(source.slice(cursor));
    if (
      !header ||
      !header[1] ||
      !Number.isSafeInteger(Number(header[1])) ||
      seen.has(Number(header[1]))
    )
      throw invalidProviderOutput();
    seen.add(Number(header[1]));
    cursor += header[0].length;
    const boxEnd = source.indexOf('|>', cursor);
    if (boxEnd < 0) throw invalidProviderOutput();
    const fields = new Map<string, number>();
    for (const field of source.slice(cursor, boxEnd).split(';')) {
      const match = /^(x1|y1|x2|y2|w|h|c)=([0-9]+(?:\.[0-9]+)?)$/.exec(field);
      if (!match?.[1] || match[2] === undefined || fields.has(match[1]))
        throw invalidProviderOutput();
      fields.set(match[1], Number(match[2]));
    }
    const [x1, y1, x2, y2, width, height] = [
      'x1',
      'y1',
      'x2',
      'y2',
      'w',
      'h',
    ].map((key) => fields.get(key));
    if (
      x1 === undefined ||
      y1 === undefined ||
      x2 === undefined ||
      y2 === undefined ||
      width === undefined ||
      height === undefined ||
      ![x1, y1, x2, y2, width, height].every(Number.isSafeInteger) ||
      width !== image.width ||
      height !== image.height ||
      x2 < x1 ||
      y2 < y1 ||
      x2 >= width ||
      y2 >= height
    )
      throw invalidProviderOutput();
    const confidence = fields.get('c');
    if (
      confidence !== undefined &&
      (!Number.isFinite(confidence) || confidence > 1)
    )
      throw invalidProviderOutput();
    cursor = boxEnd + 2;
    const maskHeader =
      /^<\|mask;x=0;y=0(?:;c=([0-9]+(?:\.[0-9]+)?))?;data=(\d+),(\d+),([!~])/.exec(
        source.slice(cursor),
      );
    if (!maskHeader) throw invalidProviderOutput();
    if (
      maskHeader[1] !== undefined &&
      (confidence === undefined || Number(maskHeader[1]) !== confidence)
    )
      throw invalidProviderOutput();
    const maskHeight = Number(maskHeader[2]);
    const maskWidth = Number(maskHeader[3]);
    if (
      !Number.isSafeInteger(maskHeight) ||
      !Number.isSafeInteger(maskWidth) ||
      maskHeight < 1 ||
      maskWidth < 1 ||
      maskHeight > height ||
      maskWidth > width
    )
      throw invalidProviderOutput();
    cursor += maskHeader[0].length;
    const maskEnd = source.indexOf('|>', cursor);
    if (maskEnd <= cursor) throw invalidProviderOutput();
    const payload = maskHeader[4]! + source.slice(cursor, maskEnd);
    cursor = maskEnd + 2;
    // Native x2/y2 are inclusive; our width/height use half-open extents.
    detections.push({
      type,
      bbox: [x1, y1, x2 - x1 + 1, y2 - y1 + 1],
      ...(confidence === undefined ? {} : { confidence }),
      ...(retainMasks
        ? {
            samObjectId: Number(header[1]),
            encodedMask: {
              width: maskWidth,
              height: maskHeight,
              encoding:
                maskHeader[4] === '!'
                  ? ('one_bit' as const)
                  : ('lossless' as const),
              payload,
            },
          }
        : {}),
    });
    if (detections.length > 100) throw invalidProviderOutput();
    if (cursor < source.length) {
      if (source[cursor] !== ',' || cursor + 1 === source.length)
        throw invalidProviderOutput();
      cursor++;
    }
  }
  if (!detections.length) throw invalidProviderOutput();
  return detections;
}

export function decodeSamResponse<T extends string>(
  raw: unknown,
  type: T,
  image: Pick<PreparedImage, 'width' | 'height'>,
  retainMasks = false,
): Array<Omit<Detection, 'type'> & { type: T }> {
  const response = responseSchema.safeParse(raw);
  if (!response.success) throw invalidProviderOutput();
  const text = response.data.output
    .flatMap((message) => message.content.map((content) => content.text))
    .join('');
  return parseSamOutput(text, type, image, retainMasks);
}

/** One spatial prompt per hypothesized wire. Never mix a noun phrase with geometry. */
export function buildWirePrompt(
  prompts: WirePrompt[],
  image: Pick<PreparedImage, 'width' | 'height'>,
): string {
  if (!prompts.length || prompts.length > 16) throw invalidProviderOutput();
  const ids = new Set<number>();
  const point = (x: number, y: number) =>
    `<|point;x=${x};y=${y};w=${image.width};h=${image.height}|>`;
  return (
    '<0f>' +
    prompts
      .map((prompt) => {
        const [x, y, width, height] = prompt.bbox;
        if (
          !Number.isSafeInteger(prompt.id) ||
          prompt.id < 0 ||
          ids.has(prompt.id) ||
          !prompt.positivePoints.length ||
          prompt.positivePoints.length > 3 ||
          prompt.negativePoints.length > 3
        )
          throw invalidProviderOutput();
        ids.add(prompt.id);
        if (
          ![x, y, width, height].every(Number.isSafeInteger) ||
          x < 0 ||
          y < 0 ||
          width < 1 ||
          height < 1 ||
          x + width > image.width ||
          y + height > image.height
        )
          throw invalidProviderOutput();
        for (const [px, py] of [
          ...prompt.positivePoints,
          ...prompt.negativePoints,
        ])
          if (
            !Number.isSafeInteger(px) ||
            !Number.isSafeInteger(py) ||
            px < 0 ||
            py < 0 ||
            px >= image.width ||
            py >= image.height
          )
            throw invalidProviderOutput();
        if (
          prompt.positivePoints.some(
            ([px, py]) =>
              px < x || py < y || px >= x + width || py >= y + height,
          )
        )
          throw invalidProviderOutput();
        return (
          `${prompt.id}<|box;x1=${x};y1=${y};x2=${x + width - 1};y2=${y + height - 1};w=${image.width};h=${image.height}|>` +
          prompt.positivePoints.map(([px, py]) => point(px, py)).join('') +
          prompt.negativePoints.map(([px, py]) => '-' + point(px, py)).join('')
        );
      })
      .join(',')
  );
}

export function createWireRefiner(config: Config, client: MetaClient) {
  return async (
    image: PreparedImage,
    prompts: WirePrompt[],
    signal: AbortSignal,
    trace?: AnalysisTrace,
    timeoutMs = config.REFINEMENT_TIMEOUT_MS,
  ) => {
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
              { type: 'input_text', text: buildWirePrompt(prompts, image) },
              { type: 'input_image', image_url: image.dataUrl },
            ],
          },
        ],
        metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
      },
      signal,
      {
        stage: 'sam.wire_refine',
        imageDimensions: [{ width: image.width, height: image.height }],
        timeoutMs,
        maxRetries: 0,
        ...(trace ? { trace } : {}),
      },
    );
    const detections = decodeSamResponse(raw, 'jumper_wire', image, true);
    if (
      detections.some(
        (detection) =>
          !prompts.some((prompt) => prompt.id === detection.samObjectId),
      )
    )
      throw invalidProviderOutput();
    return detections;
  };
}

/** One concept per API request; an empty completed output is a valid no-match. */
export function createSamService(config: Config, client: MetaClient) {
  return async (
    image: PreparedImage,
    signal: AbortSignal,
    trace?: AnalysisTrace,
  ): Promise<Detection[]> => {
    const cancelled = new AbortController();
    const groupSignal = AbortSignal.any([signal, cancelled.signal]);
    const results: Detection[][] = new Array(concepts.length);
    let next = 0;
    let failed = false;
    let firstFailure: unknown;
    async function detect(
      type: ComponentType,
      concept: string,
    ): Promise<Detection[]> {
      if (groupSignal.aborted) throw abortError(groupSignal);
      const stage: Stage = `sam.${type}`;
      try {
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
                  { type: 'input_text', text: concept },
                  { type: 'input_image', image_url: image.dataUrl },
                ],
              },
            ],
            metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
          },
          groupSignal,
          {
            stage,
            imageDimensions: [{ width: image.width, height: image.height }],
            ...(trace ? { trace } : {}),
          },
        );
        return decodeSamResponse(raw, type, image, true);
      } catch (error) {
        if (error instanceof AppError && !error.details)
          throw new AppError(error.statusCode, error.code, error.message, {
            source: 'backend_provider',
            stage,
            model: config.META_SAM_MODEL,
            elapsedMs: 0,
          });
        throw error;
      }
    }
    async function worker() {
      while (!groupSignal.aborted) {
        const index = next++;
        const concept = concepts[index];
        if (!concept) return;
        try {
          results[index] = await detect(...concept);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstFailure = error;
            // Cancel AND settle sibling work before releasing the analysis slot.
            cancelled.abort(
              new AppError(
                499,
                'DEPENDENCY_CANCELLED',
                'A sibling model request failed.',
                { source: 'backend', elapsedMs: 0 },
              ),
            );
          }
          return;
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(config.SAM_CONCURRENCY, concepts.length) },
        () => worker(),
      ),
    );
    if (failed) throw firstFailure;
    if (signal.aborted) throw abortError(signal);
    const detections = results.flat();
    if (detections.length > 100) throw invalidProviderOutput();
    return detections;
  };
}
