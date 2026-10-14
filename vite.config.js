import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any sub-path, e.g. GitHub Pages project sites.
  base: './',
  resolve: {
    alias: {
      // satellite.js's main entry also loads its WebAssembly build, which needs top-level await
      // and Node modules; the satellite worker only needs the plain JavaScript SGP4 parts.
      // No trailing slashes: Vite only trims them when both sides end in "/", and on Windows the
      // path ends in "\", which left the alias matching nothing.
      'satellite.js/sgp4': fileURLToPath(new URL('./node_modules/satellite.js/dist', import.meta.url)),
      // The map's tile engine is a copy with a way to free tiles out of view (see its header). Every
      // import of it goes to the copy, three-globe's included.
      'three-slippy-map-globe': fileURLToPath(new URL('./src/vendor/three-slippy-map-globe.mjs', import.meta.url)),
    },
  },
});
