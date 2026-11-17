import * as mupdf from 'mupdf';
import rawModel from './shape-model.json';

/**
 * Shape-based decoding of Hebrew glyphs. Used only when no name/codepage/
 * GID-alphabet rule can decode a font: every glyph is rendered in isolation on
 * a probe page, turned into a small feature vector and classified by a tiny
 * SVM (trained offline on real Hebrew print fonts). Latin/other fonts are
 * rejected by a similarity check, so honest fonts are never rewritten.
 *
 * The feature code below mirrors the Python used for training - keep in sync.
 */
const CELL = 70, FS = 48, BASE = 50, SCALE = 2, GRID = 16, N = 20;
const DIM = 404;
const ALPHA = 'אבגדהוזחטיךכלםמנןסעףפץצקרשת'; // glyph-order of legacy "alphabet" fonts

interface Model {
  classes: string[]; gamma: number; nSupport: number[]; sv: string;
  dual: number[][]; intercept: number[];
}
const M = rawModel as unknown as Model;
const SV = (() => {
  const bin = atob(M.sv);
  const out = new Float64Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) / 255) * 8 - 2;
  return out;
})();
const NSV = SV.length / DIM;
const OFF: number[] = [0];
for (const n of M.nSupport) OFF.push(OFF[OFF.length - 1] + n);

function areaMatrix(src: number, dst: number): Float64Array {
  const m = new Float64Array(dst * src);
  const r = src / dst;
  for (let i = 0; i < dst; i++) {
    const a = i * r, b = (i + 1) * r;
    let sum = 0;
    for (let k = Math.floor(a); k < Math.min(src, Math.ceil(b)); k++) {
      const w = Math.max(0, Math.min(b, k + 1) - Math.max(a, k));
      m[i * src + k] = w; sum += w;
    }
    for (let k = 0; k < src; k++) m[i * src + k] /= sum;
  }
  return m;
}
const K1 = Math.exp(-1 / (2 * 0.8 * 0.8));
const KS = 1 + 2 * K1;
const KW = [K1 / KS, 1 / KS, K1 / KS];
const refl = (i: number, n: number) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);

/** ink: 0..255 (255 = ink) cell image of size cs x cs. Returns DIM features or null if blank. */
function features(ink: Uint8Array, cs: number, em: number): Float64Array | null {
  let x0 = cs, x1 = -1, y0 = cs, y1 = -1, count = 0;
  for (let y = 0; y < cs; y++) for (let x = 0; x < cs; x++) {
    if (ink[y * cs + x] > 100) { count++; if (x < x0) x0 = x; if (x + 1 > x1) x1 = x + 1; if (y < y0) y0 = y; if (y + 1 > y1) y1 = y + 1; }
  }
  if (count < 8) return null;
  const w = x1 - x0, h = y1 - y0, side = Math.max(w, h);
  const can = new Float64Array(side * side);
  const oy = Math.floor((side - h) / 2), ox = Math.floor((side - w) / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) can[(y + oy) * side + x + ox] = ink[(y0 + y) * cs + x0 + x] / 255;
  const R = areaMatrix(side, N);
  const tmp = new Float64Array(N * side);          // R @ can
  for (let i = 0; i < N; i++) for (let k = 0; k < side; k++) { const r = R[i * side + k]; if (r) for (let j = 0; j < side; j++) tmp[i * side + j] += r * can[k * side + j]; }
  const b = new Float64Array(N * N);               // tmp @ R^T
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let k = 0; k < side; k++) s += tmp[i * side + k] * R[j * side + k]; b[i * N + j] = s; }
  const t = new Float64Array(N * N), o = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let d = -1; d <= 1; d++) s += KW[d + 1] * b[i * N + refl(j + d, N)]; t[i * N + j] = s; }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let d = -1; d <= 1; d++) s += KW[d + 1] * t[refl(i + d, N) * N + j]; o[i * N + j] = s; }
  const base = BASE * SCALE;
  const f = new Float64Array(DIM);
  f.set(o);
  f[400] = (w / h) * 2; f[401] = ((base - y0) / em) * 3; f[402] = ((base - y1) / em) * 3; f[403] = (h / em) * 2;
  return f;
}

export interface ShapeGlyph { code: number; letter: string; kmax: number; letterLike: boolean; gid: number }

function classify(f: Float64Array): { letter: string; kmax: number } {
  const k = new Float64Array(NSV);
  let kmax = 0;
  for (let s = 0; s < NSV; s++) {
    let d = 0; const o = s * DIM;
    for (let i = 0; i < DIM; i++) { const e = SV[o + i] - f[i]; d += e * e; }
    k[s] = Math.exp(-M.gamma * d); if (k[s] > kmax) kmax = k[s];
  }
  const K = M.classes.length, votes = new Array(K).fill(0);
  let idx = 0;
  for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) {
    let s = M.intercept[idx++];
    for (let c = OFF[i]; c < OFF[i + 1]; c++) s += M.dual[j - 1][c] * k[c];
    for (let c = OFF[j]; c < OFF[j + 1]; c++) s += M.dual[i][c] * k[c];
    votes[s > 0 ? i : j]++;
  }
  let best = 0; for (let i = 1; i < K; i++) if (votes[i] > votes[best]) best = i;
  return { letter: M.classes[best], kmax };
}

/** Render every byte code of a simple font in isolation and classify its glyph. */
export function probeShapes(doc: mupdf.PDFDocument, fontObjNum: number): ShapeGlyph[] | null {
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put('P', doc.newIndirect(fontObjNum));
  resources.put('Font', fonts);
  const size = CELL * GRID;
  let content = '';
  for (let c = 0; c < 256; c++) {
    const r = Math.floor(c / 16), k = c % 16;
    content += `BT /P ${FS} Tf 1 0 0 1 ${k * CELL + 8} ${size - (r * CELL + BASE)} Tm <${c.toString(16).padStart(2, '0')}> Tj ET\n`;
  }
  const pageObj = doc.addPage([0, 0, size, size], 0, resources, content);
  doc.insertPage(-1, pageObj);
  const idx = doc.countPages() - 1;
  const page = doc.loadPage(idx);
  const gids: number[] = [];
  let out: ShapeGlyph[] | null = null;
  try {
    const dev = new mupdf.Device({ fillText: (t) => t.walk({ showGlyph(_f, _m, gid) { gids.push(gid); } }) });
    try { page.run(dev, mupdf.Matrix.identity); } finally { dev.close(); dev.destroy(); }
    const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceGray, false);
    const px = pix.getPixels(), W = pix.getWidth(), stride = pix.getStride(), nc = pix.getNumberOfComponents();
    const cs = CELL * SCALE, em = FS * SCALE;
    out = [];
    for (let c = 0; c < 256; c++) {
      const r = Math.floor(c / 16), k = c % 16;
      const cell = new Uint8Array(cs * cs);
      for (let y = 0; y < cs; y++) for (let x = 0; x < cs; x++) {
        const xx = k * cs + x, yy = r * cs + y;
        cell[y * cs + x] = xx < W ? 255 - px[yy * stride + xx * nc] : 0;
      }
      const f = features(cell, cs, em);
      if (!f) continue;
      const { letter, kmax } = classify(f);
      const hEm = f[403] / 2, wEm = (f[400] / 2) * hEm;
      out.push({ code: c, letter, kmax, gid: gids.length === 256 ? gids[c] : -1, letterLike: hEm >= 0.4 && wEm >= 0.18 });
    }
    pix.destroy();
  } catch {
    out = null;
  } finally {
    page.destroy();
    doc.deletePage(idx);
  }
  return out;
}

/**
 * Decide whether the font is Hebrew and, if so, return its code -> letter table
 * (letters only; digits, punctuation and marks keep their existing mapping).
 * "Hebrew" = at least 12 distinct letters recognised with very high similarity;
 * Latin glyphs essentially never reach that level.
 */
export function shapeDecodeFont(doc: mupdf.PDFDocument, fontObjNum: number): Map<number, string> | null {
  const g = probeShapes(doc, fontObjNum);
  if (!g) return null;
  const strong = g.filter((x) => x.letterLike && x.kmax >= 0.92);
  if (strong.length < 12 || new Set(strong.map((x) => x.letter)).size < 12) return null;
  // Legacy fonts keep the alphabet in glyph order (finals before regulars): snap to a consistent run.
  const snap = (key: 'code' | 'gid') => {
    const votes = new Map<number, number>();
    for (const x of strong) { const i = ALPHA.indexOf(x.letter); if (i >= 0 && x[key] >= 0) { const d = x[key] - i; votes.set(d, (votes.get(d) ?? 0) + 1); } }
    let bd = 0, bv = 0; for (const [d, v] of votes) if (v > bv) { bd = d; bv = v; }
    return { d: bd, support: bv / strong.length };
  };
  const sc = snap('code'), sg = snap('gid');
  const useKey: 'code' | 'gid' | null = Math.max(sc.support, sg.support) >= 0.6 ? (sc.support >= sg.support ? 'code' : 'gid') : null;
  const d = useKey === 'code' ? sc.d : sg.d;
  const table = new Map<number, string>();
  for (const x of strong) table.set(x.code, x.letter);
  if (useKey) {
    // inside the alphabet window every glyph with a plausible letter shape is that letter (even if the
    // classifier was unsure, e.g. a letter with a dagesh)
    for (const x of g) {
      const i = x[useKey] - d;
      if (x.letterLike && x.kmax >= 0.6 && i >= 0 && i < ALPHA.length) table.set(x.code, ALPHA[i]);
    }
  }
  return table;
}

/**
 * For fonts already decoded by name/codepage/GID rules: fill the codes the rules left as Latin or control
 * characters (e.g. letter variants with a dagesh) from the shape table. Existing Hebrew letters, digits and
 * punctuation are never overwritten.
 */
export function shapeFill(doc: mupdf.PDFDocument, fontObjNum: number, table: Map<number, string>): number {
  const shaped = shapeDecodeFont(doc, fontObjNum);
  if (!shaped) return 0;
  let added = 0;
  for (const [code, letter] of shaped) {
    const cur = table.get(code);
    if (cur && /[\u05d0-\u05ea0-9.,;:!?()\[\]'"\-\u2013\u2014 ]/.test(cur)) continue;
    table.set(code, letter);
    added++;
  }
  return added;
}
