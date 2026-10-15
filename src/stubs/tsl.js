// Stands in for 'three/tsl' (see vite.config.js): only three-globe's heatmaps use it, which this app
// does not show. These are the names three-globe takes from it.
import { unavailable } from './unavailable.js';

const stub = (name) => unavailable(name, 'three/tsl');
export const Fn = stub('Fn');
export const If = stub('If');
export const uniform = stub('uniform');
export const storage = stub('storage');
export const float = stub('float');
export const instanceIndex = stub('instanceIndex');
export const Loop = stub('Loop');
export const sqrt = stub('sqrt');
export const sin = stub('sin');
export const cos = stub('cos');
export const asin = stub('asin');
export const exp = stub('exp');
export const negate = stub('negate');
