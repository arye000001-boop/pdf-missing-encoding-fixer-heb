// Runs in GitHub Actions for issues labelled "glyph-corrections". Untrusted input: only parsed as data, never executed.
import { mkdirSync, writeFileSync } from 'node:fs';
const body = process.env.ISSUE_BODY ?? '';
const number = Number(process.env.ISSUE_NUMBER);
const author = String(process.env.ISSUE_AUTHOR ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
const ALLOWED = /^[\u0591-\u05f4\u200e\u200f0-9A-Za-z.,;:!?()\[\]'"\-\u2013\u2014\u2018-\u201f\u2022\u25cf /%*+=<>&\u20aa]{0,8}$/u;
const FEATURE_B64_LEN = 540; // 404 bytes
const start = body.indexOf('['), end = body.lastIndexOf(']');
let parsed;
try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { parsed = null; }
if (!Number.isInteger(number) || !Array.isArray(parsed)) { console.log('no valid JSON array'); process.exit(2); }
const entries = [];
for (const e of parsed.slice(0, 400)) {
  if (e && typeof e.f === 'string' && e.f.length === FEATURE_B64_LEN && /^[A-Za-z0-9+/=]+$/.test(e.f) && typeof e.text === 'string' && ALLOWED.test(e.text))
    entries.push({ f: e.f, text: e.text.normalize('NFC') });
}
if (!entries.length) { console.log('no valid entries'); process.exit(2); }
mkdirSync('pending', { recursive: true });
writeFileSync(`pending/issue-${number}.json`, JSON.stringify({ issue: number, author, date: new Date().toISOString(), entries }, null, 1));
console.log(`accepted ${entries.length} of ${parsed.length} entries`);
