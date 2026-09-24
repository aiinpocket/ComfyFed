/**
 * Minimal ZIP writer for the console's "download selected" button (檔案頁,
 * 2026-09-20): stores entries uncompressed (method 0) with UTF-8 names, which
 * every unzip tool understands and which needs no dependency. Outputs are
 * already-compressed media (png / mp4 / webp), so deflating them would only
 * burn CPU in the browser for nothing.
 *
 * Layout written, per the PKWARE APPNOTE:
 *   [local file header + name + data] x N
 *   [central directory header + name] x N
 *   [end of central directory record]
 * Sizes are 32-bit, so the archive (and each entry) must stay under 4 GB; the
 * caller enforces that with `MAX_ZIP_BYTES` before fetching anything.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated (folders are implied). */
  path: string;
  data: Uint8Array;
  /** Wall-clock time recorded for the entry; defaults to now. */
  modified?: Date;
}

/** Hard cap on what the browser-side packer will attempt: past ~2 GB a
 * single Blob is unreliable in every browser, and ZIP32 tops out at 4 GB. */
export const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3), as ZIP requires. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair ZIP headers carry (2-second resolution, local time,
 * years before 1980 clamp to 1980). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

/** Bit 11 of the general-purpose flags: the filename is UTF-8. */
const FLAG_UTF8 = 0x0800;

class ByteSink {
  private chunks: Uint8Array[] = [];
  private length = 0;

  get size(): number {
    return this.length;
  }

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  u16(value: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value & 0xffff, true);
    this.push(b);
  }

  u32(value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    this.push(b);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.chunks) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  toBlob(): Blob {
    return new Blob(this.chunks as BlobPart[], { type: 'application/zip' });
  }
}

/**
 * Pack `entries` into a ZIP archive Blob. Throws when the combined payload
 * exceeds `MAX_ZIP_BYTES` or an entry path is empty, so a bad selection fails
 * before any bytes are written.
 */
export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (total > MAX_ZIP_BYTES) throw new Error('zip.too_large');

  const sink = new ByteSink();
  const central: Uint8Array[] = [];

  for (const entry of entries) {
    if (!entry.path) throw new Error('zip.empty_path');
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const offset = sink.size;

    // Local file header.
    sink.u32(0x04034b50);
    sink.u16(20); // version needed: 2.0
    sink.u16(FLAG_UTF8);
    sink.u16(0); // method: store
    sink.u16(time);
    sink.u16(date);
    sink.u32(crc);
    sink.u32(entry.data.length);
    sink.u32(entry.data.length);
    sink.u16(name.length);
    sink.u16(0); // extra length
    sink.push(name);
    sink.push(entry.data);

    // Central directory header, emitted after every entry's data.
    const header = new ByteSink();
    header.u32(0x02014b50);
    header.u16(20); // version made by
    header.u16(20); // version needed
    header.u16(FLAG_UTF8);
    header.u16(0);
    header.u16(time);
    header.u16(date);
    header.u32(crc);
    header.u32(entry.data.length);
    header.u32(entry.data.length);
    header.u16(name.length);
    header.u16(0); // extra
    header.u16(0); // comment
    header.u16(0); // disk number start
    header.u16(0); // internal attrs
    header.u32(0); // external attrs
    header.u32(offset);
    header.push(name);
    central.push(header.bytes());
  }

  const centralOffset = sink.size;
  for (const chunk of central) sink.push(chunk);
  const centralSize = sink.size - centralOffset;

  // End of central directory.
  sink.u32(0x06054b50);
  sink.u16(0); // this disk
  sink.u16(0); // disk with central dir
  sink.u16(entries.length);
  sink.u16(entries.length);
  sink.u32(centralSize);
  sink.u32(centralOffset);
  sink.u16(0); // comment length

  return sink.toBlob();
}

/**
 * Trigger a browser download of `blob` under `filename` via a temporary
 * object URL and a synthetic anchor click (the same mechanism a plain
 * `<a download>` uses, just for bytes assembled in memory).
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
