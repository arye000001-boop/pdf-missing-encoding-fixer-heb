# Hebrew PDF Text Fixer

Upload a Hebrew PDF whose embedded fonts lost their character→Unicode mapping —
the text looks fine on screen but comes out as garbage (mojibake, Latin letters,
or replacement characters) when you **copy, search, or extract** it. Get back a
PDF that **looks byte-for-byte identical but has a correct, copy-pasteable and
searchable Hebrew text layer**.

Everything runs **client-side** in the browser via `mupdf-wasm` — no upload, no
server.

## What it does (and doesn't)

The fixer **repairs the encoding in place**: it rewrites each broken font's
`/ToUnicode` map so its existing glyphs decode to the right Hebrew letters. The
page content — the original embedded glyphs, vectors and images — is left
completely untouched.

So the output:

- **looks exactly like the original** (the rendering is unchanged — verified
  pixel-identical), keeping crisp vector text rather than a rasterised image;
- **stays small** (no page images are embedded — the file size barely changes);
- **becomes correct** for copy, search and text extraction.

This replaces the older "rasterise each page + overlay invisible OCR-style text"
approach, which produced large, image-based files.

## How it works

Legacy Hebrew typesetting fonts come from several systems with incompatible
byte/glyph-name conventions, but the broken ones fall into two repairable
regimes, detected per font from the distribution of the Unicode codepoints mupdf
produces:

| regime | signal | repair |
| --- | --- | --- |
| honest | mostly real Hebrew, or working `ToUnicode` | left untouched |
| codepage | Latin-1 mojibake (CP1255-style) | map each glyph through the codepage table |
| lost | replacement chars / Latin-upper / control codes | **glyph-id alphabet decode** |

For the **lost** regime, the one invariant these fonts share is that their glyph
table is laid out as the Hebrew alphabet in order (final-before-regular, ending
at ת). So a glyph at glyph-id `gid` decodes to `LETTER_ORDER[gid - alpha]`, where
the per-font offset `alpha` is solved from universal Latin-slot anchors or, for
anchorless fonts, `maxGid - 26`.

The hard part is that mupdf never exposes the source **byte code** of a glyph
(only its glyph-id), and `/ToUnicode` must be keyed by code. The fixer recovers
the `code → glyph-id` map deterministically: for each font it builds a throwaway
**probe page** that shows all 256 single-byte codes in that font and reads back
the glyph-ids in content order (the k-th glyph is code k). Each glyph is then
decoded per its regime and the result is written as a fresh `/ToUnicode` CMap on
the font dictionary.

See `src/encoding-fix.ts` (the repairer + probe), `src/tag-decode.ts` (pure
glyph-id decoder) and `src/textmap.ts` (mupdf extraction, font classification and
codepage decoding).

## Develop

```bash
npm install
npm run dev        # local dev server
npm run smoke -- /path/to/input.pdf [out.pdf]   # Node pipeline check
npm run build      # production build into dist/
```

## Deploy (GitHub Pages)

Push to `fix/hebrew-extraction-and-rtl` for the preview site (or `master` for the main site). The included workflow builds with
`VITE_BASE=/pdf-missing-encoding-fixer-heb/` (the repo name, so asset paths
resolve under the project Pages URL) and publishes `dist/` to Pages. Enable
Pages → "GitHub Actions" in the repo settings once.

## Limitations

- **Type0 / CIDFont support is currently limited to CIDFontType2.** The fixer
  handles predefined Identity-H/V and explicit Encoding CMaps, then resolves
  CID values through an Identity or stream-based CIDToGIDMap. It only writes a
  ToUnicode map when the font's Hebrew GID alphabet calibration is trusted.
  CIDFontType0/CFF descendants, unsupported CMap operators, and ambiguous
  mappings are left untouched and reported rather than guessed.
- Fonts with **no consistent glyph identity** (e.g. some Type3 vector fonts)
  cannot be decoded deterministically.
- Legacy Adv* fonts without a validated family calibration are left untouched
  rather than decoded using an unsafe `maxGid - 26` guess.
- Pure-ASCII-encoded Hebrew fonts that show no broken-mapping signal may remain
  untouched until their font-specific encoding is identified.
- The app reports detected Type0/CID fonts after processing so a user is not
  led to believe that such a document was fully repaired.

## Offline use, quality report and community dictionary

* **Offline batch:** `npm install && npx tsx scripts/cli.mjs <folder|file.pdf> --out fixed/ [--viewer chrome|raw] [--dict my-dictionary.json]`
  fixes whole libraries locally (no network); `npm run build && npx vite preview` serves the same page locally.
* **Review panel (web page):** after each conversion the page lists glyphs that are still non-Hebrew ("לא פוענחו"), glyphs that were
  only recognised by shape ("ניחושים"), and fonts that were rejected as non-Hebrew. Labels are stored per browser and applied to every later book.
* **Community dictionary:** "שלחו את התיקונים" opens an issue (label `glyph-corrections`); `.github/workflows/ingest-glyphs.yml` stores the
  validated entries in `pending/` on branch `community-glyphs`. Maintainer: check that branch out as a folder and run
  `node scripts/merge-glyphs.mjs <folder>/pending` (add `--write` to append non-conflicting entries seen by >= 2 contributors, or `--all`)
  to update `src/default-glyphs.json`, which ships with every build.

## Font coverage

| Font kind | How it is repaired |
|---|---|
| Simple fonts (Type1 / TrueType / MMType1) with an embedded program | glyph names, code pages, GID-alphabet rules, then glyph-shape classification (letters, nikud, Latin, digits, punctuation) |
| Type3 fonts | glyph-shape classification (glyph procedures are rendered on a probe page) |
| Type0 / CID fonts, TrueType-based (CIDFontType2), Identity-H/V, with or without a broken ToUnicode | glyphs are rendered by glyph id straight from the embedded program, classified by shape, merged with the existing ToUnicode (valid Hebrew entries are never overwritten); empty glyphs with an advance become spaces |
| CFF-based CID fonts, CIDs mapped by a custom CMap | not supported yet: listed in the page as "גופני CID שאינם נתמכים" |
| Non-embedded fonts, image-only (scanned) pages | no glyph shapes to read: needs OCR (not part of this tool) |

The shape model (`src/shape-model.json`, ~5 MB) knows 145 classes: Hebrew letters, nikud, Latin letters/digits and punctuation. On typefaces it was
not trained on, Hebrew letters were recognised with 94-99 % accuracy and Latin/Hebrew confusion was ~1 %; nikud marks only ~67 %, so uncertain
marks land in the review panel instead of being guessed.
