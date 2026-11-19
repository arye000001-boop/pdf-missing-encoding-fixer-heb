import { readFileSync } from 'node:fs';
import { fixPdfEncoding } from '../src/encoding-fix.ts';
const input = process.argv[2];
const first = fixPdfEncoding(new Uint8Array(readFileSync(input)), {});
console.log('review items:', first.review.length);
for (const r of first.review.slice(0, 12)) console.log(' ', r.font.split('+').pop(), '0x' + r.code.toString(16), JSON.stringify(r.current), '->guess', JSON.stringify(r.guess), r.kmax.toFixed(2));
if (first.review.length) {
  const it = first.review[0];
  const second = fixPdfEncoding(new Uint8Array(readFileSync(input)), { userGlyphs: [{ f: it.f, text: 'א' }] });
  console.log('after labelling first item as א: review items', second.review.length, '(was', first.review.length + ')');
}
