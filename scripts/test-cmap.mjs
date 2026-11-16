import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const bundle = new URL('../.cmap-test.mjs', import.meta.url).pathname;
await build({
  entryPoints: [new URL('../src/cmap.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
});
try {
  const { parseEncodingCMap, identityEncodingCMap, encodingCodeKey } = await import(pathToFileURL(bundle).href);
  const cmap = parseEncodingCMap(`
    % two-byte source codes
    2 begincodespacerange
      <0000> <00FF>
      <8100> <81FF>
    endcodespacerange
    2 begincidchar
      <0001> 42
      <8102> 900
    endcidchar
    1 begincidrange
      <0010> <0012> 100
    endcidrange
  `);
  assert.deepEqual(cmap.codeSpaces, [
    { low: 0, high: 255, byteLength: 2 },
    { low: 33024, high: 33279, byteLength: 2 },
  ]);
  assert.equal(cmap.maxCodeBytes, 2);
  assert.equal(cmap.codeToCid.get(encodingCodeKey(1, 2)), 42);
  assert.equal(cmap.codeToCid.get(encodingCodeKey(0x8102, 2)), 900);
  assert.equal(cmap.codeToCid.get(encodingCodeKey(0x10, 2)), 100);
  assert.equal(cmap.codeToCid.get(encodingCodeKey(0x12, 2)), 102);

  // Identical numeric values with different source-code lengths must not collide.
  const mixedLength = parseEncodingCMap(`
    2 begincidchar
      <01> 7
      <0001> 99
    endcidchar
  `);
  assert.equal(mixedLength.codeToCid.get(encodingCodeKey(1, 1)), 7);
  assert.equal(mixedLength.codeToCid.get(encodingCodeKey(1, 2)), 99);
  assert.equal(mixedLength.codeToCid.size, 2);
  assert.deepEqual(identityEncodingCMap('Identity-H')?.codeSpaces, [
    { low: 0, high: 65535, byteLength: 2 },
  ]);
  assert.equal(identityEncodingCMap('Identity-V')?.maxCodeBytes, 2);
  assert.equal(identityEncodingCMap('WinAnsiEncoding'), null);
  assert.throws(() => parseEncodingCMap('1 begincidrange <00000000> <000FFFFF> 0 endcidrange'), /safe mapping limit/);
  assert.throws(() => parseEncodingCMap('/Identity-H usecmap'), /Unsupported inherited/);
  assert.throws(() => parseEncodingCMap('1 beginnotdefrange <0000> <00FF> 0 endnotdefrange'), /Unsupported inherited/);
  console.log('CMap parser regression tests: PASS');
} finally {
  rmSync(bundle, { force: true });
}
