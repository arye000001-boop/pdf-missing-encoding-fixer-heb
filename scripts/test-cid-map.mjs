import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const bundle = new URL('../.cid-map-test.mjs', import.meta.url).pathname;
await build({
  entryPoints: [new URL('../src/cid-map.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
});
try {
  const { parseCidToGidMap, buildType0HebrewMap, buildVariableToUnicodeCMap } =
    await import(pathToFileURL(bundle).href);
  const cmapBundle = new URL('../.cid-cmap-test.mjs', import.meta.url).pathname;
  await build({
    entryPoints: [new URL('../src/cmap.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'node', outfile: cmapBundle, logLevel: 'error',
  });
  const { identityEncodingCMap, parseEncodingCMap, encodingCodeKey } =
    await import(pathToFileURL(cmapBundle).href);

  const gidMap = parseCidToGidMap(new Uint8Array([0, 10, 0, 11, 0, 12]));
  assert.equal(gidMap.get(0), 10);
  assert.equal(gidMap.get(2), 12);
  assert.throws(() => parseCidToGidMap(new Uint8Array([0])), /odd byte length/);
  assert.throws(() => parseCidToGidMap(new Uint8Array(0x20002)), /16-bit CID limit/);

  const encoding = parseEncodingCMap(`
    1 begincodespacerange <0000> <FFFF> endcodespacerange
    2 begincidchar <0005> 0 <0006> 1 endcidchar
  `);
  const table = buildType0HebrewMap(encoding, gidMap, 10);
  assert.equal(table.get(encodingCodeKey(5, 2)), 'א');
  assert.equal(table.get(encodingCodeKey(6, 2)), 'ב');

  const identity = identityEncodingCMap('Identity-H');
  assert.ok(identity);
  const identityTable = buildType0HebrewMap(identity, gidMap, 10);
  assert.equal(identityTable.get(encodingCodeKey(0, 2)), 'א');
  assert.equal(identityTable.get(encodingCodeKey(1, 2)), 'ב');

  const toUnicode = buildVariableToUnicodeCMap(table);
  assert.match(toUnicode, /<0005> <05D0>/);
  assert.match(toUnicode, /<0006> <05D1>/);
  assert.match(toUnicode, /<0000> <FFFF>/);
  console.log('CID mapping regression tests: PASS');
} finally {
  rmSync(bundle, { force: true });
  rmSync(new URL('../.cid-cmap-test.mjs', import.meta.url).pathname, { force: true });
}
