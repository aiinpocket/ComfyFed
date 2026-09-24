/**
 * The store-only ZIP writer behind the Files page's batch download. The
 * archive is parsed back by hand here (local headers, central directory,
 * end record) so a wrong offset or CRC fails loudly rather than as a
 * "corrupt archive" dialog on the user's side.
 */
import { describe, expect, it } from 'vitest';

import { MAX_ZIP_BYTES, buildZip, crc32 } from './zip';

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function u32(view: DataView, at: number): number {
  return view.getUint32(at, true);
}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true);
}

describe('crc32', () => {
  it('matches the reference vectors', () => {
    const encoder = new TextEncoder();
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(encoder.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('buildZip', () => {
  it('writes one stored entry per file with a consistent central directory', async () => {
    const encoder = new TextEncoder();
    const hello = encoder.encode('hello');
    const world = encoder.encode('world!!');
    const bytes = await bytesOf(
      buildZip([
        { path: 'chroma-t2i/2026-09-20/a.png', data: hello, modified: new Date(2026, 8, 20, 10, 30) },
        { path: '中文/b.mp4', data: world, modified: new Date(2026, 8, 20, 10, 30) },
      ]),
    );
    const view = new DataView(bytes.buffer);

    // First local header at offset 0.
    expect(u32(view, 0)).toBe(0x04034b50);
    expect(u16(view, 6)).toBe(0x0800); // UTF-8 flag
    expect(u16(view, 8)).toBe(0); // stored
    expect(u32(view, 14)).toBe(crc32(hello));
    expect(u32(view, 18)).toBe(hello.length);
    expect(u32(view, 22)).toBe(hello.length);
    const name1Len = u16(view, 26);
    expect(new TextDecoder().decode(bytes.slice(30, 30 + name1Len))).toBe('chroma-t2i/2026-09-20/a.png');
    expect(bytes.slice(30 + name1Len, 30 + name1Len + hello.length)).toEqual(hello);

    // End of central directory is the last 22 bytes (no comment).
    const eocd = bytes.length - 22;
    expect(u32(view, eocd)).toBe(0x06054b50);
    expect(u16(view, eocd + 10)).toBe(2); // entries
    const centralSize = u32(view, eocd + 12);
    const centralOffset = u32(view, eocd + 16);
    expect(centralOffset + centralSize).toBe(eocd);

    // Walk the central directory: two headers whose local-header offsets
    // point at real local headers with matching names.
    let at = centralOffset;
    const names: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      expect(u32(view, at)).toBe(0x02014b50);
      const nameLen = u16(view, at + 28);
      const localOffset = u32(view, at + 42);
      const name = new TextDecoder().decode(bytes.slice(at + 46, at + 46 + nameLen));
      names.push(name);
      expect(u32(view, localOffset)).toBe(0x04034b50);
      const localNameLen = u16(view, localOffset + 26);
      expect(new TextDecoder().decode(bytes.slice(localOffset + 30, localOffset + 30 + localNameLen))).toBe(name);
      at += 46 + nameLen;
    }
    expect(names).toEqual(['chroma-t2i/2026-09-20/a.png', '中文/b.mp4']);
    expect(at).toBe(eocd);
  });

  it('produces an empty archive for no entries', async () => {
    const bytes = await bytesOf(buildZip([]));
    expect(bytes.length).toBe(22);
    expect(u32(new DataView(bytes.buffer), 0)).toBe(0x06054b50);
  });

  it('refuses an entry without a path and a payload over the size cap', () => {
    expect(() => buildZip([{ path: '', data: new Uint8Array(1) }])).toThrow('zip.empty_path');
    const huge = { path: 'x', data: { length: MAX_ZIP_BYTES + 1 } as unknown as Uint8Array };
    expect(() => buildZip([huge])).toThrow('zip.too_large');
  });
});
