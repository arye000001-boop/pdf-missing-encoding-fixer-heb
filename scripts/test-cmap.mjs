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
  const { parseEncodingCMap, identityEncodingCMap } = await import(pathToFileURL(bundle).href);
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
  assert.equal(cmap.codeToCid.get(1), 42);
  assert.equal(cmap.codeToCid.get(0x8102), 900);
  assert.equal(cmap.codeToCid.get(0x10), 100);
  assert.equal(cmap.codeToCid.get(0x12), 102);
  assert.deepEqual(identityEncodingCMap('Identity-H')?.codeSpaces, [
    { low: 0, high: 65535, byteLength: 2 },
  ]);
  assert.equal(identityEncodingCMap('Identity-V')?.maxCodeBytes, 2);
  assert.equal(identityEncodingCMap('WinAnsiEncoding'), null);
  assert.throws(() => parseEncodingCMap('1 begincidrange <0000> <FFFFFF> 0 endcidrange'), /safe mapping limit/);
  console.log('CMap parser regression tests: PASS');
} finally {
  rmSync(bundle, { force: true });
}
