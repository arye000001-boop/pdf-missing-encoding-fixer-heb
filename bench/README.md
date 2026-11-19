# Regression benchmark

`python3 bench/metrics.py file.pdf FIRST_PAGE LAST_PAGE` prints text-quality counters (via `pdftotext`):
Hebrew letters, leftover Latin letters / odd characters, misplaced nikud marks, reversed parentheses, over-long words.
Run it on the input and on the fixed output and compare. Lower `latin`/`odd`/`mark_misplaced`/`paren_reversed` and higher `heb` is better.

Measured on the maintainer's sample books (pages 10-30 of two Beit Aharon veYisrael issues):

| issue | original tool | previous branch | + shape decoding |
|---|---|---|---|
| 247 Hebrew letters / leftover Latin | 914 / 25859 | 29819 / 8102 | **36313 / 2315** |
| 248 | 387 / 31763 | 47075 / 265 | 47077 / 263 |

## Manual labelling (review panel)
After a conversion the page lists glyphs of Hebrew fonts that still map to non-Hebrew text, with a picture of each glyph.
Type the right character (leave unchanged for genuine English/ornaments, empty to skip), press "שמור והמר שוב": the labels are kept in
the browser (`localStorage`, exportable/importable as JSON) and applied to every later book, matching by glyph shape.
