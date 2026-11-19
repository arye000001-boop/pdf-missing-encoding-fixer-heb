# Training the shape model (maintainer tools)

`src/shape-model.json` is a small one-vs-one RBF SVM over 404 features of an isolated glyph rendering
(feature code: `train/glyphs.py` == `src/shape-decode.ts`, keep in sync).

1. `ds4.py ber|dy|247|248` collects labelled glyphs (letters, dagesh/vowel composites, nikud, digits, punctuation) from books whose
   mapping is known (`fix3_reference_decoder.py` = independent codepage/Torah-font decoder, or an already repaired file).
2. Reference letters rendered from open Hebrew fonts (`refs()` in glyphs.py, fonts from google/fonts) are added.
3. Train `sklearn.svm.SVC(C=10, gamma='scale')`, export classes / support vectors (uint8, `(x+2)/8*255`) / dual coefficients as JSON.
Community corrections (`src/default-glyphs.json`, see `scripts/merge-glyphs.mjs`) are exact matches and do not need retraining;
retrain only to improve generalisation to new typefaces.
Paths in the scripts point at /tmp and the original sample books; adjust them.
