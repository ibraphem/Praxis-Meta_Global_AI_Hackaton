import sharp from 'sharp';
import type { MaskGeometry } from '../schemas/geometry.js';
import type { BoundingBox, PreparedImage } from '../schemas/vision.js';

export interface GroundingWire {
  bbox: BoundingBox;
  mask: MaskGeometry;
}

function path(wire: GroundingWire, attributes: string) {
  const [x, y, width, height] = wire.bbox;
  // Callers validate numeric geometry with maskSchema, never arbitrary SVG markup.
  return `<g transform="translate(${x} ${y}) scale(${width / wire.mask.width} ${height / wire.mask.height})"><path d="${wire.mask.path}" fill-rule="evenodd" vector-effect="non-scaling-stroke" ${attributes}/></g>`;
}

/** Deterministic annotation, not generated scene content. Keep original pixel coordinates. */
export async function renderWireGrounding(
  image: PreparedImage,
  selected: GroundingWire,
  otherWires: GroundingWire[],
): Promise<PreparedImage> {
  const bytes = Buffer.from(image.dataUrl.split(',')[1]!, 'base64');
  const svg = (body: string) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}">${body}</svg>`,
    );
  const stroke = Math.max(1, Math.max(image.width, image.height) / 1000);
  const selectedAlpha = svg(
    path(selected, `fill="white" stroke="white" stroke-width="${stroke}"`),
  );
  const selectedPixels = await sharp(bytes)
    .ensureAlpha()
    .composite([{ input: selectedAlpha, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const background = await sharp(bytes)
    .modulate({ saturation: 0.2, brightness: 0.65 })
    .toBuffer();
  const otherRegions = svg(
    otherWires
      .map((wire) => path(wire, 'fill="black" opacity="0.45"'))
      .join(''),
  );
  const highlight = svg(
    path(
      selected,
      `fill="#22d3ee" fill-opacity="0.12" stroke="#22d3ee" stroke-opacity="0.9" stroke-width="${stroke}"`,
    ),
  );
  const annotated = await sharp(background)
    .composite([
      { input: otherRegions },
      // Selected pixels take precedence at crossings with neighboring masks.
      { input: selectedPixels },
      { input: highlight },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
  return {
    width: image.width,
    height: image.height,
    dataUrl: `data:image/jpeg;base64,${annotated.toString('base64')}`,
  };
}
