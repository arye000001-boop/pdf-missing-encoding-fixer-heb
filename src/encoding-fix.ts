import * as mupdf from 'mupdf';
import { decodeGid, normalizeFontName } from './tag-decode';
import { buildHebrewNameCodeMap, buildTagFontDecoders, decodeCp1255Glyph } from './textmap';
import { identityEncodingCMap, parseEncodingCMap } from './cmap';
import { buildType0HebrewMap, buildVariableToUnicodeCMap, parseCidToGidMap } from './cid-map';

export interface EncodingFixProgress {
  font: number;
  fontCount: number;
  /** PostScript name of the font currently being repaired. */
  name: string;
}

export interface EncodingFixResult {
  bytes: Uint8Array;
  /** Font names whose ToUnicode CMap was (re)written. */
  fixedFonts: string[];
}

/** Simple (single-byte, code→glyph) font subtypes the probe handles. */
const SIMPLE_SUBTYPES = new Set(['Type1', 'TrueType', 'Type3', 'MMType1']);

/**
 * Repair a Tag/Sappir-style PDF *in place* by rewriting the broken `/ToUnicode`
 * CMap of every lost-mapping font, leaving the page content — the original
 * embedded glyphs, vectors and images — completely untouched. The result looks
 * byte-for-byte identical when rendered but its existing text layer becomes
 * correct, copy-pasteable Hebrew. No rasterisation, no invisible overlay, so the
 * output stays small and keeps selectable vector text.
 *
 * The mechanism: mupdf never exposes the source byte *code* (only the glyph-id),
 * so for each font we synthesise a throwaway probe page that shows all 256
 * single-byte codes in that font and read back the glyph-ids in content order
 * (code `i` → `gids[i]`). The shared GID-decoder (`alpha` solved per font
 * program by {@link buildTagFontDecoders}) turns each glyph-id into its Hebrew
 * letter, giving a correct `code → Unicode` table we serialise as a ToUnicode
 * CMap and graft onto the font dictionary.
 */
export function fixPdfEncoding(
  srcBytes: Uint8Array,
  opts?: { onProgress?: (p: EncodingFixProgress) => void },
): EncodingFixResult {
  const doc = mupdf.Document.openDocument(srcBytes, 'application/pdf').asPDF();
  if (!doc) throw new Error('Not a PDF');

  const decoders = buildTagFontDecoders(doc);
  // `alpha` is a property of the embedded font program, keyed by PostScript
  // name (what the render device reports and what `/BaseFont` carries).
  const alphaByName = new Map(
    [...decoders.lost].map(([name, r]) => [normalizeFontName(name), r.alpha]),
  );

  // Collect the target font dictionaries first: probing mutates the page tree
  // (add/delete a page), so we must not iterate objects while doing it. Each
  // dictionary is handled individually — two subsets can share a `/BaseFont`
  // yet carry different `/Encoding /Differences`, hence different code maps.
  type Target =
    | { objNum: number; name: string; kind: 'named'; table: Map<number, string> }
    | { objNum: number; name: string; kind: 'lost'; alpha: number }
    | { objNum: number; name: string; kind: 'cp1255' }
    | { objNum: number; name: string; kind: 'type0'; table: Map<string, string> };
  const targets: Target[] = [];
  const objCount = doc.countObjects();
  for (let i = 1; i < objCount; i++) {
    let o: mupdf.PDFObject;
    try {
      o = doc.newIndirect(i).resolve();
    } catch {
      continue;
    }
    if (!o || !o.isDictionary()) continue;
    const type = o.get('Type');
    if (!type || !type.isName() || type.asName() !== 'Font') continue;
    const sub = o.get('Subtype');
    if (!sub || !sub.isName()) continue;
    const bf = o.get('BaseFont');
    const name = bf && bf.isName() ? bf.asName() : '';

    // Type0 support is deliberately limited to CIDFontType2, whose
    // CIDToGIDMap is specified by PDF as Identity or a two-byte stream.
    if (sub.asName() === 'Type0') {
      // Preserve existing maps until all supported ToUnicode operators can
      // be merged without dropping source mappings.
      const existingToUnicode = o.get('ToUnicode');
      if (existingToUnicode && !existingToUnicode.isNull()) continue;
      const fontKey = normalizeFontName(name);\n      const alpha = alphaByName.get(fontKey);
      if (alpha === undefined) continue;
      try {
        const encodingObj = o.get('Encoding');
        let encoding = encodingObj?.isName()
          ? identityEncodingCMap(encodingObj.asName())
          : null;
        if (!encoding && encodingObj?.isStream()) {
          const cmapBytes = encodingObj.readStream();
          encoding = parseEncodingCMap(new TextDecoder('latin1').decode(cmapBytes.asUint8Array()));
        }
        if (!encoding) continue;

        const descendants = o.get('DescendantFonts');
        if (!descendants?.isArray() || descendants.length < 1) continue;
        const descendant = descendants.get(0).resolve();
        if (!descendant?.isDictionary()) continue;
        const descendantSubtype = descendant.get('Subtype');
        if (!descendantSubtype?.isName() || descendantSubtype.asName() !== 'CIDFontType2') continue;

        const cidToGidObj = descendant.get('CIDToGIDMap');
        let cidToGid: Map<number, number> | null = null;
        if (cidToGidObj?.isName()) {
          if (cidToGidObj.asName() !== 'Identity') continue;
        } else if (cidToGidObj?.isStream()) {
          cidToGid = parseCidToGidMap(cidToGidObj.readStream().asUint8Array());
        }
        const table = buildType0HebrewMap(encoding, cidToGid, alpha);
        if (table.size > 0) targets.push({ objNum: i, name, kind: 'type0', table });
      } catch {
        // Unsupported or malformed CMaps are left untouched; never guess.
      }
      continue;
    }

    if (!SIMPLE_SUBTYPES.has(sub.asName())) continue;
    const namedTable = buildHebrewNameCodeMap(o);
    if (namedTable.size >= 3) {
      targets.push({ objNum: i, name, kind: 'named', table: namedTable });
      continue;
    }
    const alpha = alphaByName.get(name);
    if (alpha !== undefined) targets.push({ objNum: i, name, kind: 'lost', alpha });
    else if (decoders.cp1255.has(fontKey))
      targets.push({ objNum: i, name, kind: 'cp1255' });
  }

  const fixedFonts: string[] = [];
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    opts?.onProgress?.({ font: t + 1, fontCount: targets.length, name: target.name });
    if (target.kind === 'named') {
      if (target.table.size === 0) continue;
      let merged: Map<number, string>;
      try {
        merged = readExistingSimpleToUnicode(doc.newIndirect(target.objNum).resolve());
      } catch {
        // Do not overwrite a nontrivial CMap we cannot safely preserve.
        continue;
      }
      for (const [code, letter] of target.table) merged.set(code, letter);
      const cmap = buildToUnicodeCMap(merged);
      const stream = doc.addStream(cmap, doc.newDictionary());
      doc.newIndirect(target.objNum).put('ToUnicode', stream);
      if (!fixedFonts.includes(target.name)) fixedFonts.push(target.name);
      continue;
    }
    if (target.kind === 'type0') {
      const cmap = buildVariableToUnicodeCMap(target.table);
      const stream = doc.addStream(cmap, doc.newDictionary());
      doc.newIndirect(target.objNum).put('ToUnicode', stream);
      if (!fixedFonts.includes(target.name)) fixedFonts.push(target.name);
      continue;
    }
    // Recover this dictionary's code→glyph map by probing, then decode each
    // glyph according to the font's regime: GID-alphabet for `lost`, codepage
    // lookup on mupdf's mojibake unicode for `cp1255`.
    const glyphs = probeFontGlyphs(doc, target.objNum);
    if (glyphs.length !== 256) continue;
    const table = new Map<number, string>();
    for (let code = 0; code < 256; code++) {
      const { gid, uni } = glyphs[code];
      const ch =
        target.kind === 'lost'
          ? decodeGid(target.alpha, gid, uni)
          : gid === 0
            ? '' // unused code slot — no glyph
            : decodeCp1255Glyph(target.name, uni);
      if (ch) table.set(code, ch);
    }
    if (table.size === 0) continue;
    const cmap = buildToUnicodeCMap(table);
    const stream = doc.addStream(cmap, doc.newDictionary());
    doc.newIndirect(target.objNum).put('ToUnicode', stream);
    if (!fixedFonts.includes(target.name)) fixedFonts.push(target.name);
  }

  // garbage-collect the orphaned old ToUnicode streams and compress.
  const bytes = doc
    .saveToBuffer('garbage=2,compress=yes')
    .asUint8Array();
  return { bytes, fixedFonts };
}

/**
 * Recover one font dictionary's per-code glyph identity. Builds a throwaway page
 * that shows every byte 0x00–0xFF in `fontObjNum` and runs it through a
 * capturing device: glyph-ids arrive in content order, so the k-th `showGlyph`
 * is code k. Returns `[{gid, uni}]` indexed by code (empty if alignment breaks
 * or a Type3 CharProc throws), then removes the probe page so the document is
 * unchanged.
 */
function probeFontGlyphs(
  doc: mupdf.PDFDocument,
  fontObjNum: number,
): { gid: number; uni: number }[] {
  const fontObj = doc.newIndirect(fontObjNum);
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put('F', fontObj);
  resources.put('Font', fonts);

  let hex = '';
  for (let c = 0; c < 256; c++) hex += c.toString(16).padStart(2, '0');
  const content = `BT /F 10 Tf 0 100 Td <${hex}> Tj ET`;

  const pageObj = doc.addPage([0, 0, 4000, 200], 0, resources, content);
  doc.insertPage(-1, pageObj);
  const pageIdx = doc.countPages() - 1;

  const glyphs: { gid: number; uni: number }[] = [];
  const page = doc.loadPage(pageIdx);
  const device = new mupdf.Device({
    fillText: (text) =>
      text.walk({
        showGlyph(_font, _trm, gid, uni) {
          glyphs.push({ gid, uni: uni || 0 });
        },
      }),
  });
  try {
    page.run(device, mupdf.Matrix.identity);
  } catch {
    // A Type3 glyph whose CharProc needs absent resources can throw; bail out
    // for this font rather than emit a partial map.
    glyphs.length = 0;
  } finally {
    device.close();
    device.destroy();
    page.destroy();
    doc.deletePage(pageIdx);
  }
  return glyphs;
}

/** Hex-encode a string as big-endian UTF-16 (the ToUnicode `bfchar` dst form). */
function utf16beHex(s: string): string {
  let h = '';
  for (let i = 0; i < s.length; i++) {
    h += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return h;
}

/**
 * Serialise a single-byte `code → string` table as a PDF ToUnicode CMap.
 * `bfchar` blocks are capped at 100 entries each, per the spec.
 */

/** Read the existing one-byte ToUnicode mappings so a Hebrew repair does not
 * erase punctuation, Latin letters, or other valid characters in the font. */
function readExistingSimpleToUnicode(font: mupdf.PDFObject): Map<number, string> {
  const result = new Map<number, string>();
  const obj = font.get('ToUnicode');
  if (!obj || obj.isNull()) return result;
  if (!obj.isStream()) throw new Error('Unsupported existing ToUnicode object');
  const bytes = obj.readStream().asUint8Array();
  const source = new TextDecoder('latin1').decode(bytes);
  if (/beginbfrange[\s\S]*?\[[\s\S]*?\]/.test(source)) {
    throw new Error('Array-form ToUnicode bfrange is not supported for safe merge');
  }
  const readHex = (value: string) => value.slice(1, -1).replace(/\s+/g, '');
  const decodeUtf16 = (hex: string): string => {
    if (!hex || hex.length % 4 !== 0) throw new Error('Invalid UTF-16 ToUnicode destination');
    let out = '';
    for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  for (const block of source.matchAll(/\d+\s+beginbfchar([\s\S]*?)endbfchar/g)) {
    const pairs = [...block[1].matchAll(/(<[0-9A-Fa-f\s]+>)\s*(<[0-9A-Fa-f\s]+>)/g)];
    for (const pair of pairs) {
      const src = readHex(pair[1]);
      if (src.length !== 2) continue;
      result.set(parseInt(src, 16), decodeUtf16(readHex(pair[2])));
    }
  }
  for (const block of source.matchAll(/\d+\s+beginbfrange([\s\S]*?)endbfrange/g)) {
    const lines = block[1].match(/<[^>]+>\s*<[^>]+>\s*<[^>]+>/g) ?? [];
    for (const line of lines) {
      const parts = [...line.matchAll(/<([^>]+)>/g)].map((m) => m[1].replace(/\s+/g, ''));
      if (parts.length !== 3 || parts[0].length !== 2 || parts[1].length !== 2) continue;
      const first = parseInt(parts[0], 16), last = parseInt(parts[1], 16);
      const dest = parseInt(parts[2], 16);
      if (last < first || last - first > 255 || !Number.isFinite(dest)) throw new Error('Unsafe ToUnicode bfrange');
      for (let code = first; code <= last; code++) {
        result.set(code, String.fromCharCode(dest + code - first));
      }
    }
  }
  return result;
}

function buildToUnicodeCMap(table: Map<number, string>): string {
  const entries = [...table.entries()].sort((a, b) => a[0] - b[0]);
  const head =
    '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\n' +
    'begincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n' +
    '/CMapType 2 def\n' +
    '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n';

  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [code, ch] of chunk) {
      const src = code.toString(16).padStart(2, '0').toUpperCase();
      body += `<${src}> <${utf16beHex(ch)}>\n`;
    }
    body += 'endbfchar\n';
  }

  const tail =
    'endcmap\n' +
    'CMapName currentdict /CMap defineresource pop\n' +
    'end\nend\n';
  return head + body + tail;
}

/** Report which fonts a PDF carries that need ToUnicode restoration. */
export function inspectPdfEncoding(srcBytes: Uint8Array): {
  pageCount: number;
  lostFonts: string[];
  complexFonts: string[];
} {
  const doc = mupdf.Document.openDocument(srcBytes, 'application/pdf').asPDF();
  if (!doc) throw new Error('Not a PDF');
  const decoders = buildTagFontDecoders(doc);
  const complexFonts = new Set<string>();
  // Type0 fonts use multi-byte character codes and a descendant CIDFont.
  // The current single-byte probe cannot safely infer their source-code map.
  // Report them explicitly instead of silently implying the file was fully
  // inspected or attempting to write a corrupt one-byte ToUnicode CMap.
  for (let i = 1; i < doc.countObjects(); i++) {
    let obj: mupdf.PDFObject;
    try {
      obj = doc.newIndirect(i).resolve();
    } catch {
      continue;
    }
    if (!obj || !obj.isDictionary()) continue;
    const type = obj.get('Type');
    const subtype = obj.get('Subtype');
    if (
      type?.isName() && type.asName() === 'Font' &&
      subtype?.isName() && subtype.asName() === 'Type0'
    ) {
      const baseFont = obj.get('BaseFont');
      if (baseFont?.isName()) {
        const rawName = baseFont.asName();
        complexFonts.add(rawName.split('+').pop() ?? rawName);
      } else {
        complexFonts.add(`Type0 font object ${i}`);
      }
    }
  }
  return {
    pageCount: doc.countPages(),
    lostFonts: [
      ...decoders.namedGlyphs.keys(),
      ...decoders.lost.keys(),
      ...decoders.cp1255.keys(),
    ].map((f) => f.split('+').pop() ?? f),
    complexFonts: [...complexFonts],
  };
}
