import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./inventory-entry.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('./app/src/main/active-assets/inventory.js', import.meta.url)),
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome80',
  keepNames: false, sourcemap: false, minify: true, legalComments: 'none',
});

await build({
  entryPoints: [fileURLToPath(new URL('./phone-entry.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('./app/src/main/assets/qnh-phone.js', import.meta.url)),
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome80',
  keepNames: false, sourcemap: false, minify: false, legalComments: 'none',
});

await build({
  entryPoints: [fileURLToPath(new URL('./batch-entry.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('./app/src/main/assets/batch.js', import.meta.url)),
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome80',
  keepNames: false, sourcemap: false, minify: false, legalComments: 'none',
});

await build({entryPoints:[fileURLToPath(new URL('./login-entry.mjs',import.meta.url))],outfile:fileURLToPath(new URL('./app/src/main/active-assets/login.js',import.meta.url)),bundle:true,platform:'browser',format:'iife',target:'chrome80',minify:true,legalComments:'none'});
