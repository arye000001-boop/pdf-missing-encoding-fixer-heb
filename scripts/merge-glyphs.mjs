// Maintainer tool. Usage: node scripts/merge-glyphs.mjs <pendingDir> [--write]
// Compares pending community entries with src/default-glyphs.json and with each other.
//  - exact duplicate (same shape, same text): skipped
//  - same shape, different text: CONFLICT, listed for manual decision
//  - same shape+text sent by >= 2 different authors, or --all: eligible to merge
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const model = JSON.parse(readFileSync(new URL('../src/shape-model.json', import.meta.url), 'utf8'));
const dictPath = new URL('../src/default-glyphs.json', import.meta.url);
const dict = JSON.parse(readFileSync(dictPath, 'utf8'));
const dir = process.argv[2] ?? 'pending';
const write = process.argv.includes('--write');
const takeAll = process.argv.includes('--all');
const dec = (b64) => { const bin = Buffer.from(b64, 'base64'); return Float64Array.from(bin, (v) => (v / 255) * 8 - 2); };
const sim = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { const e = a[i] - b[i]; d += e * e; } return Math.exp(-model.gamma * d); };
const known = dict.map((e) => ({ ...e, v: dec(e.f) }));
const groups = [];   // {v, text, authors:Set, entry}
const conflicts = [];
for (const file of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  const { author, entries } = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  for (const e of entries) {
    const v = dec(e.f);
    const inDict = known.find((k) => sim(k.v, v) >= 0.97);
    if (inDict) { if (inDict.text !== e.text) conflicts.push({ file, text: e.text, existing: inDict.text, where: 'dictionary' }); continue; }
    const g = groups.find((x) => sim(x.v, v) >= 0.97);
    if (!g) { groups.push({ v, entry: e, texts: new Map([[e.text, new Set([author])]]) }); continue; }
    if (!g.texts.has(e.text)) g.texts.set(e.text, new Set());
    g.texts.get(e.text).add(author);
  }
}
const accepted = [];
for (const g of groups) {
  if (g.texts.size > 1) { conflicts.push({ text: [...g.texts.keys()].join(' / '), where: 'between submissions' }); continue; }
  const authors = [...g.texts.values()][0];
  if (takeAll || authors.size >= 2) accepted.push({ f: g.entry.f, text: g.entry.text });
}
console.log(`new shapes: ${groups.length}, eligible: ${accepted.length}, conflicts: ${conflicts.length}`);
for (const c of conflicts) console.log('CONFLICT', JSON.stringify(c));
if (write && accepted.length) { writeFileSync(dictPath, JSON.stringify([...dict, ...accepted])); console.log('written src/default-glyphs.json'); }
