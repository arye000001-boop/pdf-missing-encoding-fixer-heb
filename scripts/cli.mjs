// Offline batch fixer. Usage:
//   npx tsx scripts/cli.mjs <file.pdf | folder> [--out DIR] [--viewer chrome|raw] [--dict dictionary.json]
// Fixes every PDF (recursively), writes NAME.fixed.pdf and NAME.review.json (glyphs still to label) next to it or into --out.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { fixPdfEncoding } from '../src/encoding-fix.ts';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const input = args.find((a) => !a.startsWith('--') && a !== opt('--out') && a !== opt('--viewer') && a !== opt('--dict'));
if (!input) { console.error('usage: cli.mjs <file|folder> [--out DIR] [--viewer chrome|raw] [--dict file.json]'); process.exit(1); }
const outDir = opt('--out');
const userGlyphs = opt('--dict') ? JSON.parse(readFileSync(opt('--dict'), 'utf8')) : [];
const bracketMode = opt('--viewer', 'chrome') === 'raw' ? 'raw' : 'chrome';

const files = [];
const walk = (p) => { const st = statSync(p); if (st.isDirectory()) readdirSync(p).forEach((n) => walk(join(p, n))); else if (/\.pdf$/i.test(p) && !/\.fixed\.pdf$/i.test(p)) files.push(p); };
walk(resolve(input));
let totalFonts = 0, totalReview = 0; const t0 = Date.now();
for (const f of files) {
  const t = Date.now();
  try {
    const { bytes, fixedFonts, review, skippedFonts } = fixPdfEncoding(new Uint8Array(readFileSync(f)), { bracketMode, userGlyphs });
    const dir = outDir ? resolve(outDir) : dirname(f); mkdirSync(dir, { recursive: true });
    const stem = join(dir, basename(f, extname(f)));
    writeFileSync(`${stem}.fixed.pdf`, bytes);
    writeFileSync(`${stem}.review.json`, JSON.stringify({ unresolved: review.filter((r) => r.kind === 'unresolved').map(({ thumb, ...r }) => r), guesses: review.filter((r) => r.kind === 'guess').length, skippedFonts }, null, 1));
    totalFonts += fixedFonts.length; totalReview += review.filter((r) => r.kind === 'unresolved').length;
    console.log(`${basename(f)}: ${fixedFonts.length} fonts fixed, ${review.filter((r) => r.kind === 'unresolved').length} unresolved glyphs, ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (e) { console.log(`${basename(f)}: FAILED ${e.message}`); }
}
console.log(`done: ${files.length} files, ${totalFonts} fonts, ${totalReview} glyphs to review, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
