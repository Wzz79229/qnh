# Bundled local OCR assets

- Tesseract.js **7.0.0**, from the official npm package:
  https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz
  Upstream: https://github.com/naptha/tesseract.js/tree/v7.0.0
  License: Apache-2.0; see LICENSE.md and the minified-bundle LICENSE.txt files.
- Tesseract.js-core **7.0.0**, from the official npm package:
  https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz
  Upstream: https://github.com/naptha/tesseract.js-core
  License: Apache-2.0; see core/LICENSE.
- Simplified Chinese and English **tessdata_fast** LSTM integer models,
  from the official Tesseract OCR project at commit
  `87416418657359cb625c412a48b6e1d6d41c29bd`:
  https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd
  License: Apache-2.0; see lang/LICENSE.
  The unchanged traineddata files were gzip-compressed for static delivery.
  Their original SHA-256 checksums and exact source URLs are in provenance.json.

The three core variants embed their WASM inside the `.wasm.js` files. With OEM 1
and legacyCore=false, the pinned worker selects exactly one of the bundled LSTM
variants: ordinary, SIMD, or relaxed SIMD. Legacy engine variants are omitted.

All runtime, worker, core and language paths in ../../ocr.js are explicit local
URLs. The browser caches only these public model files; screenshots and extracted
text are processed in memory. No external OCR service, API key or upload endpoint
is used. OCR can misread characters and cannot recover codes truncated in the
source image; users must review the recognized text before generating labels.
