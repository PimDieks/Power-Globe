import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Relative asset paths so the build works from any sub-path, e.g. GitHub Pages project sites.
  base: './',
  resolve: {
    alias: [
      // satellite.js's main entry also loads its WebAssembly build, which needs top-level await
      // and Node modules; the satellite worker only needs the plain JavaScript SGP4 parts.
      // No trailing slashes: Vite only trims them when both sides end in "/", and on Windows the
      // path ends in "\", which left the alias matching nothing.
      { find: 'satellite.js/sgp4', replacement: here('./node_modules/satellite.js/dist') },
      // The map's tile engine is a copy with a way to free tiles out of view (see its header). Every
      // import of it goes to the copy, three-globe's included.
      { find: 'three-slippy-map-globe', replacement: here('./src/vendor/three-slippy-map-globe.mjs') },
      // Parts of globe.gl's libraries the globe never uses, left out of the bundle (about 870 kB):
      // three's WebGPU build and its shading language (WebGPU drawing and three-globe's heatmaps)
      // and h3-js (three-globe's hexagon layers). The stand-ins throw if they are ever called.
      { find: /^three\/webgpu$/, replacement: here('./src/stubs/webgpu.js') },
      { find: /^three\/tsl$/, replacement: here('./src/stubs/tsl.js') },
      { find: /^h3-js$/, replacement: here('./src/stubs/h3.js') },
    ],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // three.js and the globe built on it in a file of their own, with what they import, so a
            // deploy that changes only the app's code leaves it in returning visitors' caches.
            { name: 'three', test: /node_modules[\\/](three|three-globe|three-render-objects|globe\.gl)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    // Worktrees of other sessions keep copies of the tests that may be out of date.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
