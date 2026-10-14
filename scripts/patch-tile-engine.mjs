// Run after every install (see "postinstall" in package.json). three-slippy-map-globe, the map's
// tile engine, keeps every tile it has loaded for as long as the view stays at that zoom level or
// closer, and keeps its record of each tile to itself. This gives each tile mesh its record as
// `userData.tile`, so the site can let go of tiles far out of view and the engine loads them again
// when they come back (see boundTiles in src/map.js). It changes one line of the installed copy,
// and fails the install if that line is not there, so a new version of the engine is noticed.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../node_modules/three-slippy-map-globe/dist/three-slippy-map-globe.mjs', import.meta.url));
const FROM = 'd.obj = tile;';
const TO = 'd.obj = tile;\n      tile.userData.tile = d;';

const source = fs.readFileSync(file, 'utf8');
if (source.includes(TO)) process.exit(0);
if (source.split(FROM).length !== 2) {
  console.error(`patch-tile-engine: "${FROM}" is not in ${file} exactly once; the tile engine has changed, see scripts/patch-tile-engine.mjs.`);
  process.exit(1);
}
fs.writeFileSync(file, source.replace(FROM, TO));
console.log('patch-tile-engine: tiles carry their record (userData.tile).');
