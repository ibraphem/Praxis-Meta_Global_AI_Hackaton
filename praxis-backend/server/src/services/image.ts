import sharp from 'sharp';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import type { PreparedImage } from '../schemas/vision.js';

// Disable decoded-image caching; this service handles private photographs.
sharp.cache(false);

function contentFormat(bytes: Buffer): 'jpeg' | 'png' | 'webp' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return undefined;
}

/** Decode fully before inference, preserve resolution, rotate and strip metadata. */
export async function prepareImage(
  bytes: Buffer,
  config: Config,
): Promise<PreparedImage> {
  if (!bytes.length)
    throw new AppError(400, 'EMPTY_IMAGE', 'The image file is empty.');
  if (bytes.length > config.MAX_UPLOAD_BYTES)
    throw new AppError(
      413,
      'UPLOAD_TOO_LARGE',
      'The image exceeds the upload limit.',
    );
  const format = contentFormat(bytes);
  if (!format)
    throw new AppError(
      415,
      'UNSUPPORTED_IMAGE',
      'Upload a JPEG, PNG, or WebP photograph.',
    );
  try {
    // Metadata inspection does not decode the raster. Enforce the pixel budget before decoding.
    const metadata = await sharp(bytes, {
      limitInputPixels: false,
      failOn: 'warning',
    }).metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new AppError(
        422,
        'INVALID_IMAGE',
        'Upload a single-frame photograph.',
      );
    }
    if (metadata.width * metadata.height > config.MAX_IMAGE_PIXELS) {
      throw new AppError(
        413,
        'IMAGE_TOO_LARGE',
        'The image exceeds the decoded pixel limit.',
      );
    }
    const { data, info } = await sharp(bytes, {
      limitInputPixels: config.MAX_IMAGE_PIXELS,
      failOn: 'warning',
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      'INVALID_IMAGE',
      'The photograph could not be decoded.',
    );
  }
}
