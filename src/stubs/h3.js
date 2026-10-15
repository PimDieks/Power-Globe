// Stands in for 'h3-js' (see vite.config.js): only three-globe's hexagon layers (hexBin and
// hexPolygons) use it, which this app does not show, so its 200 kB are left out.
import { unavailable } from './unavailable.js';

export const latLngToCell = unavailable('latLngToCell', 'h3-js');
export const cellToLatLng = unavailable('cellToLatLng', 'h3-js');
export const cellToBoundary = unavailable('cellToBoundary', 'h3-js');
export const polygonToCells = unavailable('polygonToCells', 'h3-js');
