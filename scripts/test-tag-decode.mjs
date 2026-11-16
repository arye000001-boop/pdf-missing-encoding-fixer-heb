// Focused regression tests for the pure Hebrew glyph-decoding core.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const bundle = new URL('../.tag-decode-test.mjs', import.meta.url).pathname;
await build({
  entryPoints: [new URL('../src/tag-decode.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'error',
});
try {
  const {
    LETTER_ORDER, anchorAlpha, classifyFontRegime, normalizeFontName,
    decodeGid, solveAlphaFromVotes,
  } = await import(pathToFileURL(bundle).href);

  assert.equal(normalizeFontName('LOOMOH+Advfrank-n'), 'Advfrank-n');
  assert.equal(normalizeFontName('Advvilna-b'), 'Advvilna-b');

  assert.equal(LETTER_ORDER.length, 27);
  assert.equal(LETTER_ORDER[0], 'א');
  assert.equal(LETTER_ORDER[10], 'ך');
  assert.equal(LETTER_ORDER[26], 'ת');

  // Each standard-glyph anchor must resolve to its documented Hebrew slot.
  const anchorCases = [
    [0x00c6, 'ב'], [0x00aa, 'ד'], [0x00ba, 'כ'],
    [0x00d8, 'י'], [0x0152, 'ך'], [0x0153, 'ת'],
    [0x00e6, 'ס'], [0x00f8, 'ש'], [0x0142, 'ר'],
    [0x0141, 'ט'], [0x0131, 'ץ'],
  ];
  for (const [unicode, letter] of anchorCases) {
    const idx = LETTER_ORDER.indexOf(letter);
    assert.equal(anchorAlpha(100 + idx, unicode), 100);
  }

  assert.equal(classifyFontRegime({
    total: 100, heb: 80, cp1255: 0, fffd: 0, upper: 0, ctrl: 0,
  }), 'honest');
  assert.equal(classifyFontRegime({
    total: 100, heb: 0, cp1255: 70, fffd: 0, upper: 0, ctrl: 0,
  }), 'cp1255');
  assert.equal(classifyFontRegime({
    total: 100, heb: 0, cp1255: 0, fffd: 40, upper: 0, ctrl: 0,
  }), 'lost');

  assert.equal(decodeGid(50, 50, 0xfffd), 'א');
  assert.equal(decodeGid(50, 76, 0xfffd), 'ת');
  assert.equal(decodeGid(50, 49, 0xfffd), '');
  assert.equal(decodeGid(50, 90, 0x28), '(');

  const unanimous = solveAlphaFromVotes(new Map([[73, 4]]), 120);
  assert.deepEqual(unanimous, { alpha: 73, confident: true });
  const disputed = solveAlphaFromVotes(new Map([[73, 3], [74, 1]]), 120);
  assert.equal(disputed.confident, false);

  console.log('tag-decode regression tests: PASS');
} finally {
  rmSync(bundle, { force: true });
}
