// Works out where every satellite is, off the main thread so the globe keeps turning smoothly.
//   { type: 'load', tles: [{ line1, line2 }] }   → { type: 'loaded', classes: ['leo' | 'meo' | 'geo' | null] }
//   { type: 'positions', time, id }              → { type: 'positions', time, id, positions: Float32Array }
import { orbitClass, positionsAt, toSatrec } from './orbits.js';

let satrecs = [];

self.onmessage = ({ data }) => {
  if (data.type === 'load') {
    satrecs = data.tles.map(toSatrec);
    self.postMessage({ type: 'loaded', classes: satrecs.map((s) => (s ? orbitClass(s) : null)) });
  } else if (data.type === 'positions') {
    const positions = positionsAt(satrecs, new Date(data.time));
    self.postMessage({ type: 'positions', time: data.time, id: data.id, positions }, [positions.buffer]);
  }
};
