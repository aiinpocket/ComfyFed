/**
 * Bounded gunzip for `/api/agent/object_info` uploads, ported from
 * the former Python `bounded_gunzip`. Python has to drive `zlib.decompressobj`
 * chunk-by-chunk to bound the inflated size (a naive `gzip.decompress` fully
 * inflates before anything can be measured -- a decompression-bomb risk);
 * the Workers runtime's `DecompressionStream("gzip")` gives the same
 * incremental behavior for free via its `ReadableStream` interface, so this
 * just reads it chunk-by-chunk and aborts as soon as the running total
 * passes `maxBytes`.
 */

/** Thrown when the inflated stream passes its cap -- mirrors Python's
 * `ObjectInfoTooLarge` (mapped by the caller to a 413). */
export class ObjectInfoTooLarge extends Error {
  constructor() {
    super("decompressed object_info exceeds the size limit");
    this.name = "ObjectInfoTooLarge";
  }
}

/** Thrown for anything that isn't a valid (complete) gzip stream -- mirrors
 * Python's `zlib.error`/`OSError`/`EOFError` catch-all (mapped by the caller
 * to a 400). */
export class InvalidGzip extends Error {
  constructor(cause?: unknown) {
    super(`invalid or truncated gzip stream${cause ? `: ${String(cause)}` : ""}`);
    this.name = "InvalidGzip";
  }
}

export async function boundedGunzip(gzipBytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed Blob source: `gzipBytes` may be a
  // view over a larger buffer (e.g. sliced from a request body), and
  // `Blob`/`ReadableStream` construction wants its own bytes.
  const source = new Blob([gzipBytes.slice().buffer]).stream();
  const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ObjectInfoTooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ObjectInfoTooLarge) throw err;
    throw new InvalidGzip(err instanceof Error ? err.message : err);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
