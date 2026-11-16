/**
 * Minimal, bounded parser for the CID portions of a PDF Encoding CMap.
 *
 * This deliberately does not equate source character codes, CIDs, or GIDs.
 * It parses source-code -> CID rules only; descendant-font CID -> GID
 * resolution is a separate stage.
 */
export interface CodeSpaceRange {
  low: number;
  high: number;
  byteLength: number;
}

export interface EncodingCMap {
  codeSpaces: CodeSpaceRange[];
  /** Keys include byte length: the numeric values <01> and <0001> are distinct codes. */
  codeToCid: Map<string, number>;
  maxCodeBytes: number;
}

/** Stable lookup key for a source code, preserving its original byte length. */
export function encodingCodeKey(value: number, byteLength: number): string {
  return `${byteLength}:${value}`;
}

const MAX_EXPANDED_MAPPINGS = 1_000_000;

function hexValue(token: string): { value: number; byteLength: number } {
  const hex = token.slice(1, -1).replace(/\\s+/g, '');
  if (!hex || hex.length % 2 !== 0 || hex.length > 8 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`Invalid CMap hex string: ${token}`);
  }
  return { value: Number.parseInt(hex, 16), byteLength: hex.length / 2 };
}

/** Parse codespacerange, begincidchar and begincidrange sections. */
export function parseEncodingCMap(source: string): EncodingCMap {
  // PDF comments run to end-of-line. Tokenization keeps hex strings atomic.
  const withoutComments = source.replace(/%[^\\r\\n]*/g, '');
  const tokens = withoutComments.match(/<[^<>]*>|\\[|\\]|-?\\d+|[A-Za-z][A-Za-z0-9]*|[^\\s]/g) ?? [];
  const codeSpaces: CodeSpaceRange[] = [];
  const codeToCid = new Map<string, number>();
  let maxCodeBytes = 0;
  let expanded = 0;

  const add = (code: number, byteLength: number, cid: number) => {
    if (!Number.isSafeInteger(code) || !Number.isSafeInteger(cid) || cid < 0) {
      throw new Error('Invalid CMap code or CID');
    }
    if (++expanded > MAX_EXPANDED_MAPPINGS) {
      throw new Error('CMap expands beyond the safe mapping limit');
    }
    codeToCid.set(encodingCodeKey(code, byteLength), cid);
  };

  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i];
    if (op === 'begincodespacerange') {
      while (i + 1 < tokens.length && tokens[i + 1] !== 'endcodespacerange') {
        const lo = tokens[++i];
        const hi = tokens[++i];
        if (!lo?.startsWith('<') || !hi?.startsWith('<')) {
          throw new Error('Malformed CMap codespacerange');
        }
        const low = hexValue(lo);
        const high = hexValue(hi);
        if (low.byteLength !== high.byteLength || low.value > high.value) {
          throw new Error('Invalid CMap codespacerange bounds');
        }
        codeSpaces.push({ low: low.value, high: high.value, byteLength: low.byteLength });
        maxCodeBytes = Math.max(maxCodeBytes, low.byteLength);
      }
      if (tokens[i + 1] !== 'endcodespacerange') throw new Error('Unterminated codespacerange');
      i++;
    } else if (op === 'begincidchar') {
      while (i + 1 < tokens.length && tokens[i + 1] !== 'endcidchar') {
        const src = tokens[++i];
        const cid = tokens[++i];
        if (!src?.startsWith('<') || !/^-?\\d+$/.test(cid ?? '')) {
          throw new Error('Malformed CMap cidchar');
        }
        const code = hexValue(src);
        add(code.value, code.byteLength, Number(cid));
      }
      if (tokens[i + 1] !== 'endcidchar') throw new Error('Unterminated cidchar');
      i++;
    } else if (op === 'begincidrange') {
      while (i + 1 < tokens.length && tokens[i + 1] !== 'endcidrange') {
        const firstToken = tokens[++i];
        const lastToken = tokens[++i];
        const cidToken = tokens[++i];
        if (!firstToken?.startsWith('<') || !lastToken?.startsWith('<') ||
            !/^-?\\d+$/.test(cidToken ?? '')) {
          throw new Error('Malformed CMap cidrange');
        }
        const first = hexValue(firstToken);
        const last = hexValue(lastToken);
        const firstCid = Number(cidToken);
        if (first.byteLength !== last.byteLength || first.value > last.value) {
          throw new Error('Invalid CMap cidrange bounds');
        }
        const count = last.value - first.value + 1;
        if (count > MAX_EXPANDED_MAPPINGS - expanded) {
          throw new Error('CMap expands beyond the safe mapping limit');
        }
        for (let offset = 0; offset < count; offset++) {
          add(first.value + offset, first.byteLength, firstCid + offset);
        }
        maxCodeBytes = Math.max(maxCodeBytes, first.byteLength);
      }
      if (tokens[i + 1] !== 'endcidrange') throw new Error('Unterminated cidrange');
      i++;
    }
  }

  return { codeSpaces, codeToCid, maxCodeBytes };
}

/** Identity-H and Identity-V are predefined two-byte source-code -> CID maps. */
export function identityEncodingCMap(name: string): EncodingCMap | null {
  if (name !== 'Identity-H' && name !== 'Identity-V') return null;
  return {
    codeSpaces: [{ low: 0, high: 0xffff, byteLength: 2 }],
    codeToCid: new Map(),
    maxCodeBytes: 2,
  };
}
