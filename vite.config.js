import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any sub-path, e.g. GitHub Pages project sites.
  base: './',
  resolve: {
    alias: {
      // satellite.js's main entry also loads its WebAssembly build, which needs top-level await
      // and Node modules; the satellite worker only needs the plain JavaScript SGP4 parts.
      'satellite.js/sgp4/': fileURLToPath(new URL('./node_modules/satellite.js/dist/', import.meta.url)),
    },
  },
});
