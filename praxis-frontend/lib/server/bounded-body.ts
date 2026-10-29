/** A bounded stream failure is separate from either proxy's HTTP policy. */
export class BoundedReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Bound chunked uploads too; Content-Length alone cannot enforce a limit. */
export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BoundedReadError(
          413,
          "BODY_TOO_LARGE",
          "The photograph is too large. Use a file under 8 MB.",
        );
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
