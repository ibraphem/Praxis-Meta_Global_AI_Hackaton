import sharp from 'sharp';
import type { BoundingBox, PreparedImage } from '../schemas/vision.js';
export interface FocusFrame {
  bbox: BoundingBox;
  image: PreparedImage;
}
export function focusBox(
  image: { width: number; height: number },
  box: BoundingBox,
): BoundingBox {
  const pad = Math.max(24, Math.ceil(Math.max(box[2], box[3]) * 0.12)),
    x = Math.max(0, box[0] - pad),
    y = Math.max(0, box[1] - pad);
  return [
    x,
    y,
    Math.min(image.width, box[0] + box[2] + pad) - x,
    Math.min(image.height, box[1] + box[3] + pad) - y,
  ];
}
export async function extractFrame(
  image: PreparedImage,
  bbox: BoundingBox,
  maxDimension = 1600,
): Promise<FocusFrame> {
  const [left, top, width, height] = bbox;
  const { data, info } = await sharp(
    Buffer.from(image.dataUrl.split(',')[1]!, 'base64'),
  )
    .extract({ left, top, width, height })
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92 })
    .toBuffer({ resolveWithObject: true });
  return {
    bbox,
    image: {
      width: info.width,
      height: info.height,
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    },
  };
}
export function frameToOriginal(
  point: [number, number],
  frame: FocusFrame,
): [number, number] {
  return [
    frame.bbox[0] + (point[0] * frame.bbox[2]) / frame.image.width,
    frame.bbox[1] + (point[1] * frame.bbox[3]) / frame.image.height,
  ];
}
export async function gridReference(
  image: PreparedImage,
  points: [number, number][],
): Promise<PreparedImage> {
  const circles = points
    .map(
      ([x, y]) =>
        `<circle cx="${x}" cy="${y}" r="2" fill="none" stroke="#d946ef" stroke-width="1"/>`,
    )
    .join('');
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}">${circles}</svg>`,
  );
  const data = await sharp(Buffer.from(image.dataUrl.split(',')[1]!, 'base64'))
    .composite([{ input: svg }])
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    ...image,
    dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
  };
}
