import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  MAX_PHOTOS, MAX_INPUT_BYTES, MAX_DIMENSION, MAX_PREVIEW_BYTES,
  validatePhotos, fitDimensions, previewByteLength, preprocessPhoto, recognizePhotos,
} from '../dist/ocr.mjs';

const photo = (patch = {}) => ({ type: 'image/jpeg', size: 1024, ...patch });

test('photo validation rejects empty, excessive, oversized and active-content inputs before decoding', () => {
  assert.equal(MAX_PHOTOS, 3);
  assert.throws(() => validatePhotos([]), /照片/);
  assert.throws(() => validatePhotos(Array.from({ length: 4 }, () => photo())), /最多/);
  for (const type of ['text/html', 'image/svg+xml', 'image/gif', '', 'application/octet-stream']) {
    assert.throws(() => validatePhotos([photo({ type })]), /不是支持的照片/);
  }
  assert.throws(() => validatePhotos([photo({ size: 0 })]), /为空/);
  assert.throws(() => validatePhotos([photo({ size: NaN })]), /为空/);
  assert.throws(() => validatePhotos([photo({ size: MAX_INPUT_BYTES + 1 })]), /超过 10 MB/);
  assert.equal(validatePhotos([photo({ size: MAX_INPUT_BYTES })]).length, 1);
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    assert.equal(validatePhotos([photo({ type })]).length, 1);
  }
});

test('mobile resizing caps the longest side at 1600 without enlarging small images', () => {
  assert.equal(MAX_DIMENSION, 1600);
  assert.deepEqual(fitDimensions(4000, 3000), { width: 1600, height: 1200 });
  assert.deepEqual(fitDimensions(3000, 4000), { width: 1200, height: 1600 });
  assert.deepEqual(fitDimensions(600, 400), { width: 600, height: 400 });
  assert.deepEqual(fitDimensions(1, 10000), { width: 1, height: 1600 });
  for (const [width, height] of [[0, 1], [1, 0], [Infinity, 10], [NaN, 1], [-1, 10]]) {
    assert.throws(() => fitDimensions(width, height), /尺寸无效/);
  }
});

test('preview byte limits count decoded JPEG bytes rather than base64 characters', () => {
  assert.equal(MAX_PREVIEW_BYTES, 300 * 1024);
  assert.equal(previewByteLength('data:image/jpeg;base64,YWJj'), 3);
  assert.equal(previewByteLength('data:image/jpeg;base64,YWI='), 2);
  assert.equal(previewByteLength('data:image/jpeg;base64,YQ=='), 1);
  assert.equal(previewByteLength('data:image/png;base64,YQ=='), null);
  assert.equal(previewByteLength('data:image/jpeg;base64,Y'), null);
  assert.equal(previewByteLength('https://example.test/photo.jpg'), null);
});

test('an already-aborted scan creates no decoder or OCR worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recognizePhotos([photo()], { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(preprocessPhoto(photo(), { signal: controller.signal }), { name: 'AbortError' });
});

test('mocked preprocessing enforces JPEG size/dimensions and releases bitmap and canvas memory', async () => {
  const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
  const canvases = [];
  let bitmapClosed = 0;
  try {
    globalThis.createImageBitmap = async (_file, options) => {
      assert.equal(options.imageOrientation, 'from-image');
      return { width: 4000, height: 3000, close: () => { bitmapClosed += 1; } };
    };
    globalThis.document = {
      createElement(type) {
        assert.equal(type, 'canvas');
        const canvas = {
          width: 0, height: 0,
          getContext: () => ({ fillRect() {}, drawImage() {} }),
          toBlob(callback, mime, quality) {
            // Deliberately exceed the preview bound at high quality to exercise retry.
            const length = mime === 'image/png' ? 128 : quality > 0.7 ? MAX_PREVIEW_BYTES + 1 : 100;
            callback(new Blob([new Uint8Array(length)], { type: mime }));
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    };
    const output = await preprocessPhoto(new Blob(['test decoder input'], { type: 'image/jpeg' }));
    assert.equal(output.blob.type, 'image/png', 'OCR input stays lossless independently of archive preview');
    assert.equal(output.preview.width, 1600);
    assert.equal(output.preview.height, 1200);
    assert.ok(output.preview.bytes <= MAX_PREVIEW_BYTES);
    assert.equal(previewByteLength(output.preview.dataUrl), output.preview.bytes);
    assert.equal(bitmapClosed, 1);
    assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('abort during mocked OCR initialization immediately terminates the native worker', async () => {
  const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, Worker: globalThis.Worker };
  const controller = new AbortController();
  let terminated = 0;
  try {
    globalThis.createImageBitmap = async () => ({ width: 100, height: 80, close() {} });
    globalThis.document = { createElement: () => ({
      width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }),
      toBlob: (callback, type) => callback(new Blob(['mock pixels'], { type })),
    }) };
    globalThis.Worker = class {
      constructor(url) { assert.ok(url.href.endsWith('/vendor/tesseract/recognize.worker.js')); }
      postMessage() { queueMicrotask(() => controller.abort()); }
      terminate() { terminated += 1; }
    };
    await assert.rejects(recognizePhotos([new Blob(['test input'], { type: 'image/jpeg' })], { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(terminated, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('synthetic browser QA image is a real PNG fixture, not an accuracy assertion', () => {
  const bytes = fs.readFileSync(new URL('./fixtures/packaging-synthetic.png', import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 780);
});

test('vendored OCR versions, all CPU variants and fast language assets match recorded hashes', () => {
  const root = new URL('../dist/vendor/tesseract/', import.meta.url);
  const sources = JSON.parse(fs.readFileSync(new URL('SOURCES.json', root), 'utf8'));
  assert.equal(sources.tesseractJs, '7.0.0');
  assert.equal(sources.tesseractCore, '7.0.0');
  assert.equal(sources.tessdataFast, '4.1.0');
  for (const asset of sources.files) {
    const bytes = fs.readFileSync(new URL(asset.path, root));
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
  }
  for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
    const bytes = fs.readFileSync(new URL(`core/tesseract-core-${variant}.wasm`, root));
    assert.deepEqual([...bytes.subarray(0, 4)], [0, 97, 115, 109], `${variant} must be actual WebAssembly`);
  }
  for (const language of ['chi_sim', 'eng']) {
    const original = fs.readFileSync(new URL(`lang/${language}.traineddata`, root));
    const compressed = fs.readFileSync(new URL(`lang/${language}.traineddata.gz`, root));
    assert.ok(original.length > 1_000_000);
    assert.ok(compressed.length < original.length);
    assert.deepEqual(gunzipSync(compressed), original, `${language} gzip must preserve the official model exactly`);
    assert.deepEqual(gzipSync(original, { level: 9, mtime: 0 }), compressed, `${language} gzip must be deterministic`);
  }
});
