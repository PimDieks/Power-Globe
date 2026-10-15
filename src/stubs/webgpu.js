// Stands in for 'three/webgpu' (see vite.config.js): three-render-objects can draw with WebGPU when
// asked to, and three-globe's heatmaps compute with it. The globe here draws with WebGL and has no
// heatmaps, so the WebGPU build of three (about 660 kB) is left out.
import { unavailable } from './unavailable.js';

export const WebGPURenderer = unavailable('WebGPURenderer', 'three/webgpu');
export const StorageInstancedBufferAttribute = unavailable('StorageInstancedBufferAttribute', 'three/webgpu');
