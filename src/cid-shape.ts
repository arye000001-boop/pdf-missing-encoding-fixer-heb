import * as mupdf from 'mupdf';
import { parseCidToGidMap } from './cid-map';
import { encodingCodeKey } from './cmap';
import {
  CELL, FS, BASE, SCALE, GRID, EXACT, IS_LETTER, IS_LATIN, IS_MARK, IS_COMPOSITE, THUMB, guessedCodes, letterLikeOf,
  features, classify, userMatch, decideTable, thumbFromGray, reviewFromGlyphs, noteGuess,
  type ShapeGlyph, type ReviewItem,
} from './shape-decode';

/**
 * Shape-based repair of Type0 (CID) fonts: Identity-H/V encoding, TrueType-based CIDFontType2 with an embedded
 * font program. Glyphs are rendered straight from the font program by glyph id (no PDF code mapping needed),
 * classified exactly like simple fonts, and written back as a two-byte ToUnicode CMap merged with the
 * existing one (existing good Hebrew entries are never overwritten).
 */

/** Glyph ids with / without an outline, from the TrueType loca/glyf tables. null = not a TrueType program. */
export function glyphIds(b: Uint8Array): { ink: number[]; empty: number[] } | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag0 = dv.getUint32(0);
  if (tag0 !== 0x00010000 && tag0 !== 0x74727565 /* true */ && tag0 !== 0x4f54544f /* OTTO */) return null;
  const n = dv.getUint16(4);
  const tab = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16; if (o + 16 > b.length) return null;
    tab.set(String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) });
  }
  const head = tab.get('head'), maxp = tab.get('maxp'), loca = tab.get('loca');
  if (!head || !maxp || !loca || !tab.get('glyf')) return null;       // CFF-flavoured programs are not handled here
  const numGlyphs = dv.getUint16(maxp.off + 4);
  const long = dv.getInt16(head.off + 50) === 1;
  const at = (i: number) => (long ? dv.getUint32(loca.off + i * 4) : dv.getUint16(loca.off + i * 2) * 2);
  const ink: number[] = [], empty: number[] = [];
  for (let g = 0; g < numGlyphs; g++) {
    if ((long ? (g + 2) * 4 : (g + 2) * 2) > loca.len) break;
    if (at(g + 1) > at(g)) ink.push(g); else empty.push(g);
  }
  return { ink, empty };
}

/** Existing ToUnicode (two-byte codes) as code -> string; empty when absent. */
export function readToUnicode2(font: mupdf.PDFObject): Map<number, string> {
  const m = new Map<number, string>();
  const tu = font.get('ToUnicode');
  if (!tu || tu.isNull() || !tu.isStream()) return m;
  const src = new TextDecoder('latin1').decode(tu.readStream().asUint8Array());
  const dec = (hex: string) => { let s = ''; for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)); return s; };
  for (const sec of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const e of sec[1].matchAll(/<([0-9A-Fa-f]{2,4})>\s*<([0-9A-Fa-f]+)>/g)) m.set(parseInt(e[1], 16), dec(e[2]));
  for (const sec of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const e of sec[1].matchAll(/<([0-9A-Fa-f]{2,4})>\s*<([0-9A-Fa-f]{2,4})>\s*<([0-9A-Fa-f]{4})>/g)) {
      const a = parseInt(e[1], 16), z = parseInt(e[2], 16), base = parseInt(e[3], 16);
      for (let c = a; c <= z && c - a < 70000; c++) m.set(c, String.fromCharCode(base + (c - a)));
    }
  return m;
}

interface CidFontInfo { font: mupdf.Font; gids: number[]; emptyGids: number[]; gidToCid: Map<number, number[]> | null; baseName: string }

/** gids really drawn with each font (by PostScript name), collected once per document by walking the pages. */
const USED = new WeakMap<object, Map<string, Set<number>>>();
/** BaseFont and the program's internal name differ in subset prefix, spaces and hyphens. */
export const normFontKey = (n: string) => n.replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function usedGids(doc: mupdf.PDFDocument): Map<string, Set<number>> {
  let m = USED.get(doc); if (m) return m;
  m = new Map(); USED.set(doc, m);
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    try {
      const dev = new mupdf.Device({ fillText: (t) => t.walk({ showGlyph(f, _m, gid) { const nm = normFontKey(f.getName()); let st = m!.get(nm); if (!st) { st = new Set(); m!.set(nm, st); } st.add(gid); } }) });
      try { page.run(dev, mupdf.Matrix.identity); } finally { dev.close(); dev.destroy(); }
    } catch { /* unreadable page */ } finally { page.destroy(); }
  }
  return m;
}

export function openCidFont(doc: mupdf.PDFDocument, fontObj: mupdf.PDFObject): CidFontInfo | null {
  try {
    const enc = fontObj.get('Encoding');
    if (!enc?.isName() || !/^Identity-[HV]$/.test(enc.asName())) return null;
    const desc = fontObj.get('DescendantFonts');
    if (!desc?.isArray() || desc.length < 1) return null;
    const cf = desc.get(0).resolve();
    const st = cf.get('Subtype');
    if (!st?.isName() || st.asName() !== 'CIDFontType2') return null;
    const fd = cf.get('FontDescriptor');
    const ff = fd && !fd.isNull() ? fd.resolve().get('FontFile2') : null;
    if (!ff || ff.isNull() || !ff.isStream()) return null;
    const bytes = ff.readStream().asUint8Array();
    const ids = glyphIds(bytes);
    if (!ids || ids.ink.length === 0) return null;
    let gids = ids.ink;
    let gidToCid: Map<number, number[]> | null = null;
    const c2g = cf.get('CIDToGIDMap');
    if (c2g?.isStream()) {
      gidToCid = new Map();
      for (const [cid, gid] of parseCidToGidMap(c2g.readStream().asUint8Array())) {
        const l = gidToCid.get(gid); if (l) l.push(cid); else gidToCid.set(gid, [cid]);
      }
    } else if (c2g?.isName() && c2g.asName() !== 'Identity') return null;
    const bf = fontObj.get('BaseFont');
    const baseName = bf?.isName() ? bf.asName() : '';
    const font = new mupdf.Font('cidprobe', bytes);
    // big (often unsubsetted) programs: only the glyphs the document really draws
    const used = usedGids(doc).get(normFontKey(baseName));
    if (used && used.size) gids = gids.filter((g) => used.has(g)); else if (gids.length > 3000) gids = gids.slice(0, 3000);
    const used2 = usedGids(doc).get(normFontKey(baseName));
    const emptyGids = ids.empty.filter((g) => (!used2 || used2.has(g)) && font.advanceGlyph(g, 0) > 0.15);
    return { font, gids, emptyGids, gidToCid, baseName };
  } catch { return null; }
}

/** Render up to 256 glyphs (by gid) in the standard probe grid; returns ink cells (255 = ink). */
function renderGidChunk(font: mupdf.Font, gids: number[]): Uint8Array[] {
  const size = CELL * GRID * SCALE;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, size, size], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(SCALE, SCALE), pix);
  try {
    gids.forEach((gid, i) => {
      const r = Math.floor(i / 16), k = i % 16;
      const text = new mupdf.Text();
      text.showGlyph(font, [FS, 0, 0, -FS, k * CELL + 8, r * CELL + BASE], gid, 0, 0);
      dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
    });
  } finally { dev.close(); dev.destroy(); }
  const px = pix.getPixels(), stride = pix.getStride(), nc = pix.getNumberOfComponents();
  const cs = CELL * SCALE;
  const cells = gids.map((_, i) => {
    const r = Math.floor(i / 16), k = i % 16;
    const cell = new Uint8Array(cs * cs);
    for (let y = 0; y < cs; y++) for (let x = 0; x < cs; x++) cell[y * cs + x] = 255 - px[(r * cs + y) * stride + (k * cs + x) * nc];
    return cell;
  });
  pix.destroy();
  return cells;
}

export interface CidResult {
  table: Map<string, string>;          // "2:code" -> text, ready for buildVariableToUnicodeCMap
  changed: boolean;
  review: ReviewItem[];
}

export function cidShapeRepair(
  doc: mupdf.PDFDocument, fontObjNum: number, name: string, relaxed: boolean, review: ReviewItem[], seen: Float64Array[],
  base?: Map<string, string>,   // entries already decided by an earlier rule (e.g. the alphabet rule); the shape pass completes them
): CidResult | null {
  const fontObj = doc.newIndirect(fontObjNum).resolve();
  const info = openCidFont(doc, fontObj);
  if (!info) return null;
  const cs = CELL * SCALE, em = FS * SCALE;
  const g: ShapeGlyph[] = [];
  const cellOf = new Map<number, Uint8Array>();
  const keepCells = info.gids.length <= 4096;
  for (let off = 0; off < info.gids.length; off += 256) {
    const chunk = info.gids.slice(off, off + 256);
    const cells = renderGidChunk(info.font, chunk);
    chunk.forEach((gid, i) => {
      const f = features(cells[i], cs, em);
      if (!f) return;
      const um = userMatch(f);
      const { letter, kmax } = um !== null ? { letter: um, kmax: 1 } : classify(f);
      g.push({ code: gid, gid, letter, text: letter, kmax, feat: f, letterLike: letterLikeOf(letter, kmax, f) });
      if (keepCells) cellOf.set(gid, cells[i]);
    });
  }
  const shaped = decideTable(g, doc, fontObjNum, relaxed);   // gid -> text (null = not a Hebrew font)
  if (!shaped) return null;
  const existing = readToUnicode2(fontObj);
  if (base) for (const [k, v] of base) { const code = Number(k.split(':')[1]); if (Number.isFinite(code)) existing.set(code, v); }
  const KEEP = /^[\u0591-\u05f4\u200e\u200f0-9.,;:!?()\[\]'"\-\u2013\u2014\u2018-\u201f\u2022 /%*+=<>&\u20aa]+$/;
  const final = new Map<string, string>();
  for (const [cid, text] of existing) final.set(encodingCodeKey(cid, 2), text);
  let changed = false;
  const byCode = new Map<number, string>();
  const gidOf = new Map(g.map((x) => [x.code, x]));
  for (const x of g) {
    const cids = info.gidToCid ? info.gidToCid.get(x.gid) ?? [] : [x.gid];
    let hebText = shaped.get(x.code);
    if (hebText === undefined && x.kmax >= 0.75 && (IS_MARK.test(x.text) || IS_COMPOSITE.test(x.text))) hebText = x.text;      // nikud / letter+vowel: looser match inside a proven Hebrew font
    for (const cid of cids) {
      const cur = existing.get(cid);
      let next: string | undefined;
      if (hebText !== undefined) {
        // Hebrew/mark decisions fill missing entries and replace garbage (incl. wrong Latin), never valid Hebrew/digits/punctuation
        if (cur === undefined || cur === '' || !KEEP.test(cur)) next = hebText;
      } else if (IS_LATIN.test(x.text) && x.kmax >= 0.9 && (cur === undefined || cur === '')) next = x.text;  // English glyph with no mapping
      else if (/^[.,:;!?()\[\]'"\-\/%\u05be\u05c3\u05f3\u05f4\u2013\u2014]$/.test(x.text) && x.kmax >= 0.8 && (cur === undefined || cur === '' || !KEEP.test(cur))) next = x.text; // punctuation / brackets in a proven Hebrew font
      else if (/^[0-9]$/.test(x.text) && x.kmax >= 0.85 && (cur === undefined || cur === '' || !KEEP.test(cur))) next = x.text;
      if (next !== undefined && next !== cur) { final.set(encodingCodeKey(cid, 2), next); changed = true; byCode.set(x.code, next); }
      else if (cur !== undefined) byCode.set(x.code, cur);
    }
  }
  // empty-outline glyphs with an advance width are spaces
  for (const gid of info.emptyGids) for (const cid of info.gidToCid ? info.gidToCid.get(gid) ?? [] : [gid]) {
    const cur = existing.get(cid);
    if (cur === undefined || cur === '' || !/^[\s\u200e\u200f]+$/.test(cur) && !/[\u0591-\u05f4]/.test(cur)) { final.set(encodingCodeKey(cid, 2), ' '); byCode.set(gid, ' '); changed = true; }
  }
  void gidOf;
  const gidTable = new Map<number, string>(byCode);
  // glyphs that remain non-Hebrew after the merge -> review list (thumbnails drawn from the cached cells)
  reviewFromGlyphs(g, gidTable, guessedCodes(doc, fontObjNum), name, review, seen, (codes) => {
    const out = new Map<number, Uint8Array>();
    for (const c of codes) { const cell = cellOf.get(c); if (cell) out.set(c, thumbFromGray((x, y) => 255 - cell[y * cs + x], cs, em)); }
    return out;
  }, true);
  void noteGuess; void THUMB;
  return { table: final, changed, review };
}
