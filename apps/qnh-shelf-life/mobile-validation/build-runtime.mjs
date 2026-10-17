import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./phone-entry.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('./app/src/main/assets/qnh-phone.js', import.meta.url)),
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome80',
  keepNames: false, sourcemap: false, minify: false, legalComments: 'none',
});
