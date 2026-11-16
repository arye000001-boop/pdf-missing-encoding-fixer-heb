import { decodeGid } from './tag-decode';
import { encodingCodeKey, type EncodingCMap } from './cmap';

export type SourceUnicodeMap = Map<string, string>;

/** Decode a PDF CIDToGIDMap stream (two-byte, big-endian GIDs indexed by CID). */
export function parseCidToGidMap(bytes: Uint8Array): Map<number, number> {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error('CIDToGIDMap stream has an odd byte length');
  }
  if (bytes.byteLength > 0x20000) {
    throw new Error('CIDToGIDMap stream exceeds the 16-bit CID limit');
  }
  const result = new Map<number, number>();
  for (let cid = 0; cid < bytes.byteLength / 2; cid++) {
    const gid = (bytes[cid * 2] << 8) | bytes[cid * 2 + 1];
    result.set(cid, gid);
  }
  return result;
}

/**
 * Build source-code -> Unicode entries for a Type0 font when its Encoding
 * CMap and CID->GID mapping are known. Only the alphabet window is emitted:
 * callers must have a trusted per-font alpha calibration before using this.
 */
export function buildType0HebrewMap(
  encoding: EncodingCMap,
  cidToGid: Map<number, number> | null,
  alpha: number,
): SourceUnicodeMap {
  if (!Number.isSafeInteger(alpha) || alpha < 0) {
    throw new Error('Invalid Type0 glyph alphabet base');
  }

  const result: SourceUnicodeMap = new Map();

  // Identity-H/V means source code == CID. The CIDToGIDMap may in turn be
  // Identity or a stream. Enumerate only the 27 calibrated Hebrew glyphs.
  if (encoding.identity) {
    // For Identity-H/V, source code equals CID. If CIDToGIDMap is a stream,
    // enumerate its entries; otherwise the CID and GID spaces are identical.
    const cids = cidToGid
      ? [...cidToGid.keys()]
      : Array.from({ length: 27 }, (_, index) => alpha + index);
    for (const cid of cids) {
      const gid = cidToGid ? cidToGid.get(cid) : cid;
      if (gid === undefined) continue;
      const letter = decodeGid(alpha, gid, 0);
      if (letter) result.set(encodingCodeKey(cid, 2), letter);
    }
    return result;
  }

  for (const [sourceKey, cid] of encoding.codeToCid) {
    const [lengthText, valueText] = sourceKey.split(':');
    const byteLength = Number(lengthText);
    const code = Number(valueText);
    if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 4) continue;
    const gid = cidToGid ? cidToGid.get(cid) : cid;
    if (gid === undefined) continue;
    const letter = decodeGid(alpha, gid, 0);
    if (letter) result.set(encodingCodeKey(code, byteLength), letter);
  }

  return result;
}

/** Serialize variable-length source-code -> Unicode entries as a ToUnicode CMap. */
export function buildVariableToUnicodeCMap(table: SourceUnicodeMap): string {
  const entries = [...table.entries()].map(([key, value]) => {
    const [lengthText, codeText] = key.split(':');
    const byteLength = Number(lengthText);
    const code = Number(codeText);
    if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 4 ||
        !Number.isSafeInteger(code) || code < 0 || code >= 2 ** (byteLength * 8)) {
      throw new Error('Invalid source code in ToUnicode map');
    }
    return { byteLength, code, value };
  }).sort((a, b) => a.byteLength - b.byteLength || a.code - b.code);

  const lengths = [...new Set(entries.map((entry) => entry.byteLength))];
  if (lengths.length === 0) throw new Error('Cannot write an empty ToUnicode CMap');

  const codespaces = lengths.map((length) => {
    const max = (2 ** (length * 8) - 1).toString(16).padStart(length * 2, '0').toUpperCase();
    return `<${'00'.repeat(length)}> <${max}>\n`;
  }).join('');

  const utf16 = (value: string) => {
    let hex = '';
    for (let i = 0; i < value.length; i++) {
      hex += value.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    }
    return hex;
  };

  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const entry of chunk) {
      const src = entry.code.toString(16).padStart(entry.byteLength * 2, '0').toUpperCase();
      body += `<${src}> <${utf16(entry.value)}>\n`;
    }
    body += 'endbfchar\n';
  }

  return '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    `${lengths.length} begincodespacerange\n${codespaces}endcodespacerange\n` +
    body + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
}
