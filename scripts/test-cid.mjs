// CID font regression: needs the test PDFs created by train/make_cid_tests.py (skipped when absent).
import { existsSync, readFileSync } from 'node:fs';
import { fixPdfEncoding } from '../src/encoding-fix.ts';
const f = process.argv[2] ?? '/tmp/cid/heebo_notounicode.pdf';
if (!existsSync(f)) { console.log('skip: no CID test pdf'); process.exit(0); }
const r = fixPdfEncoding(new Uint8Array(readFileSync(f)), {});
if (!r.fixedFonts.length) { console.error('CID font was not repaired'); process.exit(1); }
console.log('ok', r.fixedFonts.join(','));
