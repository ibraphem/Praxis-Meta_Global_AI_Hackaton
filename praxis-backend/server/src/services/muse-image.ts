import sharp from 'sharp';
import type { Candidate, PreparedImage } from '../schemas/vision.js';

/** Resizing is Muse-only. SAM masks and all persisted geometry stay in the original frame. */
export async function museInput(
  image: PreparedImage,
  candidates: Candidate[],
  maxDimension: number,
) {
  if (!maxDimension || Math.max(image.width, image.height) <= maxDimension)
    return { image, candidates };
  const { data, info } = await sharp(
    Buffer.from(image.dataUrl.split(',')[1]!, 'base64'),
  )
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  const sx = info.width / image.width,
    sy = info.height / image.height;
  return {
    image: {
      width: info.width,
      height: info.height,
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    },
    candidates: candidates.map((c) => {
      const [x, y, w, h] = c.bbox;
      const left = Math.floor(x * sx),
        top = Math.floor(y * sy);
      return {
        ...c,
        bbox: [
          left,
          top,
          Math.ceil((x + w) * sx) - left,
          Math.ceil((y + h) * sy) - top,
        ] as Candidate['bbox'],
      };
    }),
  };
}
