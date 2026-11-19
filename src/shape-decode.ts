import * as mupdf from 'mupdf';
import rawModel from './shape-model.json';
import defaultGlyphs from './default-glyphs.json';

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
const KC = M.classes.length;
const DUAL = new Float64Array((KC - 1) * NSV);   // flat copy of the sklearn dual coefficients
for (let r = 0; r < KC - 1; r++) DUAL.set(M.dual[r], r * NSV);
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

export interface ShapeGlyph { code: number; letter: string; text: string; kmax: number; letterLike: boolean; gid: number; feat: Float64Array }
const IS_LETTER = /^[\u05d0-\u05ea]$/;
const IS_MARK = /^[\u05b0-\u05bd\u05bf\u05c1\u05c2\u05c7]$/;
/** Similarity at which a glyph is considered an exact dictionary hit (same typeface family seen in training). */
const EXACT = 0.97;

function classify(f: Float64Array): { letter: string; kmax: number } {
  const k = new Float64Array(NSV);
  let kmax = 0, nearest = 0;
  for (let s = 0; s < NSV; s++) {
    let d = 0; const o = s * DIM;
    for (let i = 0; i < DIM; i++) { const e = SV[o + i] - f[i]; d += e * e; }
    k[s] = Math.exp(-M.gamma * d); if (k[s] > kmax) { kmax = k[s]; nearest = s; }
  }
  const K = KC, votes = new Array(K).fill(0);
  // S[a][b] = sum over support vectors of class a of dual_row(b) * k   (libsvm one-vs-one decision, regrouped)
  const S = new Float64Array(K * K);
  for (let a = 0; a < K; a++) {
    for (let b = 0; b < K; b++) {
      if (b === a) continue;
      const row = (b > a ? b - 1 : b) * NSV;
      let sum = 0;
      for (let c = OFF[a]; c < OFF[a + 1]; c++) sum += DUAL[row + c] * k[c];
      S[a * K + b] = sum;
    }
  }
  let idx = 0;
  for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) {
    const sc = M.intercept[idx++] + S[i * K + j] + S[j * K + i];
    votes[sc > 0 ? i : j]++;
  }
  // Exact hit (glyph seen in training): the nearest training glyph decides - this keeps dagesh/vowel composites
  // that the SVM would blur into their plain letter.
  if (kmax >= EXACT) { let c = 0; while (OFF[c + 1] <= nearest) c++; return { letter: M.classes[c], kmax }; }
  let best = 0; for (let i = 1; i < K; i++) if (votes[i] > votes[best]) best = i;
  return { letter: M.classes[best], kmax };
}

/** Render every byte code of a simple font in isolation and classify its glyph. */
/** codes assigned by a non-exact classifier match (< EXACT), per font object: shown for confirmation. */
const GUESSED = new WeakMap<object, Map<number, Set<number>>>();
function noteGuess(doc: object, obj: number, code: number) {
  let m = GUESSED.get(doc); if (!m) { m = new Map(); GUESSED.set(doc, m); }
  let st = m.get(obj); if (!st) { st = new Set(); m.set(obj, st); }
  st.add(code);
}

const PROBE_CACHE = new WeakMap<object, Map<number, ShapeGlyph[] | null>>();
export function probeShapes(doc: mupdf.PDFDocument, fontObjNum: number): ShapeGlyph[] | null {
  let cache = PROBE_CACHE.get(doc);
  if (!cache) { cache = new Map(); PROBE_CACHE.set(doc, cache); }
  if (cache.has(fontObjNum)) return cache.get(fontObjNum)!;
  const res = probeShapesUncached(doc, fontObjNum);
  cache.set(fontObjNum, res);
  return res;
}

function probeShapesUncached(doc: mupdf.PDFDocument, fontObjNum: number): ShapeGlyph[] | null {
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
      const um = userMatch(f);
      const { letter, kmax } = um !== null ? { letter: um, kmax: 1 } : classify(f);
      const hEm = f[403] / 2, wEm = (f[400] / 2) * hEm;
      const isL = IS_LETTER.test(letter);
      out.push({ code: c, letter, text: letter, kmax, gid: gids.length === 256 ? gids[c] : -1, feat: f, letterLike: isL && ((hEm >= 0.4 && wEm >= 0.18) || kmax >= 0.88) }); // narrow letters (vav, yod, final nun) fail the size test but match very closely
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
export function shapeDecodeFont(doc: mupdf.PDFDocument, fontObjNum: number, relaxed = false): Map<number, string> | null {
  const g = probeShapes(doc, fontObjNum);
  if (!g) return null;
  const strong = g.filter((x) => x.letterLike && x.kmax >= 0.92);
  // A small subset of a font family already proven Hebrew elsewhere in the file (or with a Hebrew-typeface name)
  // only has to show a few letters.
  const need = relaxed ? 4 : 12;
  const ok = strong.length >= need && new Set(strong.map((x) => x.letter)).size >= need;
  // Legacy fonts keep the alphabet in glyph order (finals before regulars). Several letters landing on one
  // consistent code/gid offset is a structural proof of a Hebrew alphabet font, even for a tiny subset whose
  // glyphs match the trained shapes only loosely.
  const snapOf = (items: ShapeGlyph[], key: 'code' | 'gid') => {
    const votes = new Map<number, number>();
    for (const x of items) { const i = ALPHA.indexOf(x.letter); if (i >= 0 && x[key] >= 0) { const d = x[key] - i; votes.set(d, (votes.get(d) ?? 0) + 1); } }
    let bd = 0, bv = 0; for (const [d, v] of votes) if (v > bv) { bd = d; bv = v; }
    return { d: bd, support: items.length ? bv / items.length : 0, n: bv };
  };
  const cand = g.filter((x) => IS_LETTER.test(x.text) && x.kmax >= 0.6);
  const cc = snapOf(cand, 'code'), cg = snapOf(cand, 'gid');
  const structural = cand.length >= 6 && Math.max(cc.support, cg.support) >= 0.8 && Math.max(cc.n, cg.n) >= 6;
  if (!ok && !structural) return null;
  const pool = ok ? strong : cand;
  const snap = (key: 'code' | 'gid') => snapOf(pool, key);
  const sc = snap('code'), sg = snap('gid');
  const useKey: 'code' | 'gid' | null = Math.max(sc.support, sg.support) >= 0.6 ? (sc.support >= sg.support ? 'code' : 'gid') : null;
  const d = useKey === 'code' ? sc.d : sg.d;
  const table = new Map<number, string>();
  for (const x of pool) { table.set(x.code, x.letter); if (x.kmax < EXACT) noteGuess(doc, fontObjNum, x.code); }
  for (const x of g) if (x.kmax >= EXACT && !IS_LETTER.test(x.text)) table.set(x.code, x.text); // nikud, dagesh/vowel composites, digits, punctuation
  if (useKey) {
    // inside the alphabet window every glyph with a plausible letter shape is that letter (even if the
    // classifier was unsure, e.g. a letter with a dagesh)
    for (const x of g) {
      const i = x[useKey] - d;
      if (x.letterLike && x.kmax >= 0.6 && i >= 0 && i < ALPHA.length) { table.set(x.code, ALPHA[i]); if (x.kmax < EXACT) noteGuess(doc, fontObjNum, x.code); }
    }
  }
  return table;
}

/**
 * For fonts already decoded by name/codepage/GID rules: fill the codes the rules left as Latin or control
 * characters (e.g. letter variants with a dagesh) from the shape table. Existing Hebrew letters, digits and
 * punctuation are never overwritten.
 */
export function shapeFill(doc: mupdf.PDFDocument, fontObjNum: number, table: Map<number, string>, relaxed = false): number {
  const g = probeShapes(doc, fontObjNum);
  if (!g) return 0;
  // The font is already known to be Hebrew (other rules decoded part of it), so a glyph that is letter-shaped
  // and reasonably close to a trained letter is accepted even in small subsets.
  const known = [...table.values()].filter((c) => /[\u05d0-\u05ea]/.test(c)).length;
  const shaped = new Map<number, string>(shapeDecodeFont(doc, fontObjNum, relaxed) ?? []);
  if (known >= 3) for (const x of g) if (x.letterLike && x.kmax >= 0.7 && !shaped.has(x.code)) shaped.set(x.code, x.letter);
  let added = 0;
  const exact = new Map<number, string>();
  if (known >= 3 || shaped.size >= (relaxed ? 4 : 12)) for (const x of g) if (x.kmax >= EXACT) exact.set(x.code, x.text);
  for (const [code, text] of exact) { if (table.get(code) !== text) { table.set(code, text); added++; } } // exact dictionary hit beats rule-based guesses
  // nikud: small dots/bars are less distinctive, so accept a looser match, but only where the code is garbage
  const IS_COMPOSITE = /^[\u05d0-\u05ea][\u05b0-\u05c7]+$/;
  for (const x of g) {
    const known3 = known >= 3 || shaped.size >= (relaxed ? 4 : 12);
    if (exact.has(x.code) || x.kmax < 0.75 || !(IS_MARK.test(x.text) || (known3 && (IS_COMPOSITE.test(x.text) || IS_LETTER.test(x.text))))) continue;
    const cur = table.get(x.code);
    if (!cur || !/[\u0591-\u05ea0-9.,;:!?()\[\]'"\-\u2013\u2014 ]/.test(cur)) { table.set(x.code, x.text); added++; noteGuess(doc, fontObjNum, x.code); }
  }
  for (const [code, letter] of shaped) {
    if (exact.has(code)) continue;
    const cur = table.get(code);
    if (cur && /[\u0591-\u05ea0-9.,;:!?()\[\]'"\-\u2013\u2014 ]/.test(cur)) continue; // never overwrite Hebrew letters, nikud/taamim, digits or punctuation
    table.set(code, letter);
    added++;
  }
  return added;
}

// ---------------------------------------------------------------------------------------------------------
// User dictionary: glyphs the maintainer labelled by hand (shape features -> text). They are exact hits.

export interface UserGlyph { f: string; text: string }
let USER: { f: Float64Array; text: string }[] = [];

export function encodeFeatures(f: Float64Array): string {
  const u = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) u[i] = Math.max(0, Math.min(255, Math.round(((f[i] + 2) / 8) * 255)));
  let bin = ''; for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin);
}
function decodeFeatures(b64: string): Float64Array {
  const bin = atob(b64); const f = new Float64Array(bin.length);
  for (let i = 0; i < bin.length; i++) f[i] = (bin.charCodeAt(i) / 255) * 8 - 2;
  return f;
}
export function setUserGlyphs(list: UserGlyph[]): void {
  // community-approved dictionary (src/default-glyphs.json) + this user's own labels (these win)
  USER = [...(defaultGlyphs as UserGlyph[]), ...list].filter((u) => u.f && u.text !== undefined).map((u) => ({ f: decodeFeatures(u.f), text: u.text }));
}
function userMatch(f: Float64Array): string | null {
  let best = 0, text: string | null = null;
  for (const u of USER) {
    if (u.f.length !== f.length) continue;
    let d = 0; for (let i = 0; i < f.length; i++) { const e = u.f[i] - f[i]; d += e * e; }
    const k = Math.exp(-M.gamma * d);
    if (k > best) { best = k; text = u.text; }
  }
  return best >= EXACT ? text : null;
}

// ---------------------------------------------------------------------------------------------------------
// Review list: glyphs of Hebrew fonts that still map to something that is not Hebrew/digit/punctuation.

export interface ReviewItem { kind: 'unresolved' | 'guess'; font: string; code: number; current: string; guess: string; kmax: number; f: string; thumb: Uint8Array; thumbSize: number }
const VALID = /^[\u0591-\u05f4\u200e\u200f0-9.,;:!?()\[\]'"\-\u2013\u2014\u2018-\u201f\u2022 /%*+=<>&\u20aa]+$/;

const THUMB = 160;
/** Re-render the requested codes of a font as a typographic specimen: 1.6 em square, baseline at 72 %, so marks above/below the letter stay visible. */
function renderThumbs(doc: mupdf.PDFDocument, fontObjNum: number, codes: number[]): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const resources = doc.newDictionary(); const fonts = doc.newDictionary();
  fonts.put('P', doc.newIndirect(fontObjNum)); resources.put('Font', fonts);
  const size = CELL * GRID; let content = '';
  for (let c = 0; c < 256; c++) { const r = Math.floor(c / 16), k = c % 16; content += `BT /P ${FS} Tf 1 0 0 1 ${k * CELL + 8} ${size - (r * CELL + BASE)} Tm <${c.toString(16).padStart(2, '0')}> Tj ET\n`; }
  const pageObj = doc.addPage([0, 0, size, size], 0, resources, content);
  doc.insertPage(-1, pageObj);
  const idx = doc.countPages() - 1; const page = doc.loadPage(idx);
  try {
    const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceGray, false);
    const px = pix.getPixels(), W = pix.getWidth(), stride = pix.getStride(), nc = pix.getNumberOfComponents();
    const cs = CELL * SCALE, em = FS * SCALE, win = 1.6 * em;
    for (const c of codes) {
      const r = Math.floor(c / 16), k = c % 16;
      // horizontal centre of the ink inside the cell
      let x0 = cs, x1 = -1;
      for (let y = 0; y < cs; y++) for (let x = 0; x < cs; x++) { const xx = k * cs + x; if (xx < W && px[(r * cs + y) * stride + xx * nc] < 155) { if (x < x0) x0 = x; if (x > x1) x1 = x; } }
      const cx = x1 >= 0 ? (x0 + x1) / 2 : cs / 2;
      const left = cx - win / 2, top = BASE * SCALE - 1.15 * em;
      const t = new Uint8Array(THUMB * THUMB);
      for (let ty = 0; ty < THUMB; ty++) for (let tx = 0; tx < THUMB; tx++) {
        const sx = left + ((tx + 0.5) * win) / THUMB, sy = top + ((ty + 0.5) * win) / THUMB;
        const ix = Math.floor(sx), iy = Math.floor(sy);
        let v = 255;
        if (ix >= 0 && iy >= 0 && ix < cs && iy < cs) { const xx = k * cs + ix; if (xx < W) v = px[(r * cs + iy) * stride + xx * nc]; }
        t[ty * THUMB + tx] = v;
      }
      out.set(c, t);
    }
    pix.destroy();
  } finally { page.destroy(); doc.deletePage(idx); }
  return out;
}

export function collectReview(doc: mupdf.PDFDocument, fontObjNum: number, table: Map<number, string>, fontName: string, out: ReviewItem[], seen: Float64Array[]): void {
  const g = probeShapes(doc, fontObjNum);
  if (!g) return;
  const guessed = GUESSED.get(doc)?.get(fontObjNum);
  const pick: { x: ShapeGlyph; kind: 'unresolved' | 'guess'; cur: string }[] = [];
  for (const x of g) {
    const cur = table.get(x.code);
    let kind: 'unresolved' | 'guess' | null = null;
    // no entry at all: the code keeps its original (usually fine) mapping, so it is not a problem to review
    if (cur !== undefined && cur !== '' && !VALID.test(cur)) kind = 'unresolved';
    else if (cur && guessed?.has(x.code) && x.kmax < EXACT) kind = 'guess';
    if (!kind) continue;
    let dup = false;
    for (const f of seen) {
      let d = 0; for (let i = 0; i < f.length; i++) { const e = f[i] - x.feat[i]; d += e * e; }
      if (Math.exp(-M.gamma * d) >= EXACT) { dup = true; break; }
    }
    if (dup || out.length + pick.length >= 120) continue;
    seen.push(x.feat);
    pick.push({ x, kind, cur: cur ?? '' });
  }
  if (!pick.length) return;
  const thumbs = renderThumbs(doc, fontObjNum, pick.map((p) => p.x.code));
  for (const { x, kind, cur } of pick) {
    out.push({ kind, font: fontName, code: x.code, current: cur, guess: kind === 'guess' ? cur : (x.kmax >= 0.5 ? x.text : cur), kmax: x.kmax, f: encodeFeatures(x.feat), thumb: thumbs.get(x.code)!, thumbSize: THUMB });
  }
}
