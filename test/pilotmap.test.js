import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewProfile } from '../src/pilotview.js';

// MapLibre needs WebGL: a stand-in that records what is asked of it.
const maps = [];
const protocols = {};
// When set, the stand-in never says its style has loaded (nor that it failed).
const silence = { style: false };
vi.mock('maplibre-gl', () => {
  class Map {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.handlers = {};
      this.canvasHandlers = {};
      this.removed = 0;
      this.terrain = null;
      maps.push(this);
      if (!silence.style) queueMicrotask(() => this.handlers['style.load']?.());
    }
    once(type, fn) {
      this.handlers[type] = fn;
    }
    on(type, fn) {
      this.handlers[type] = fn;
    }
    getCanvas() {
      return { addEventListener: (type, fn) => (this.canvasHandlers[type] = fn) };
    }
    setMaxPitch() {}
    setTerrain(t) {
      this.terrain = t;
    }
    getTerrain() {
      return this.terrain;
    }
    queryTerrainElevation() {
      return 12;
    }
    setVerticalFieldOfView(v) {
      this.calls.push(['fov', v]);
    }
    setSky() {
      this.calls.push(['sky']);
    }
    setSourceTileLodParams(a, b, id) {
      this.calls.push(['lod', a, b, id]);
    }
    setLayoutProperty(layer, name, value) {
      this.calls.push(['layout', layer, value]);
    }
    loaded() {
      return false;
    }
    areTilesLoaded() {
      return false;
    }
    jumpTo() {}
    calculateCameraOptionsFromTo() {
      return {};
    }
    remove() {
      this.removed++;
      if (this.failToRemove) throw new Error('lost context');
    }
  }
  class LngLat {
    constructor(lng, lat) {
      Object.assign(this, { lng, lat });
    }
  }
  return { Map, LngLat, setWorkerUrl() {}, addProtocol: (name, fn) => (protocols[name] = fn) };
});
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }));

const { NO_DATA_BYTES, RETRY_PAUSES_MS, STYLE_TIMEOUT_MS, TROUBLE_AFTER, TileHealth, TileUnavailable, createPilotMap, fetchTile } = await import('../src/pilotmap.js');

const answer = (status, bytes = 100) => ({ status, ok: status >= 200 && status < 300, arrayBuffer: async () => new ArrayBuffer(bytes) });
const noPause = vi.fn(async () => {});

describe('fetchTile', () => {
  beforeEach(() => noPause.mockClear());

  it('gives the data of a tile', async () => {
    const data = await fetchTile('u', { kind: 'imagery', fetchImpl: async () => answer(200, 8000), noDataBytes: NO_DATA_BYTES });
    expect(data.byteLength).toBe(8000);
  });

  it('leaves out the picture that says there is no imagery, without asking again', async () => {
    const fetchImpl = vi.fn(async () => answer(200, NO_DATA_BYTES));
    await expect(fetchTile('u', { kind: 'imagery', fetchImpl, noDataBytes: NO_DATA_BYTES, pause: noPause })).rejects.toBeInstanceOf(TileUnavailable);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('takes a picture of that size for a tile where it has no such picture', async () => {
    const data = await fetchTile('u', { kind: 'terrain', fetchImpl: async () => answer(200, NO_DATA_BYTES) });
    expect(data.byteLength).toBe(NO_DATA_BYTES);
  });

  it('does not ask again for a tile the service does not have', async () => {
    const fetchImpl = vi.fn(async () => answer(404));
    await expect(fetchTile('u', { kind: 'terrain', fetchImpl, pause: noPause })).rejects.toBeInstanceOf(TileUnavailable);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks again after a pause when it fails, and gets it', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(answer(503)).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(answer(200, 50));
    const data = await fetchTile('u', { kind: 'imagery', fetchImpl, pause: noPause });
    expect(data.byteLength).toBe(50);
    expect(noPause.mock.calls.map((c) => c[0])).toEqual(RETRY_PAUSES_MS);
  });

  it('gives up after the pauses, with the last error, and counts it against the service', async () => {
    const health = { record: vi.fn() };
    const fetchImpl = vi.fn(async () => answer(503));
    await expect(fetchTile('u', { kind: 'imagery', health, fetchImpl, pause: noPause })).rejects.toThrow('Tile 503');
    expect(fetchImpl).toHaveBeenCalledTimes(RETRY_PAUSES_MS.length + 1);
    expect(health.record).toHaveBeenCalledTimes(1);
    expect(health.record).toHaveBeenCalledWith('imagery', false);
  });

  it('stops at once when the map no longer wants the tile', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(fetchTile('u', { kind: 'imagery', signal: controller.signal, fetchImpl, pause: noPause })).rejects.toThrow('aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves no listener on the signal after its pauses', async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set();
      const signal = { aborted: false, addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) };
      const request = fetchTile('u', { kind: 'imagery', signal, fetchImpl: async () => answer(503) }).catch((err) => err);
      await vi.runAllTimersAsync();
      expect((await request).message).toBe('Tile 503');
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still stops a pause when the map no longer wants the tile', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => answer(503));
    const request = fetchTile('u', { kind: 'imagery', signal: controller.signal, fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('gone'));
    await expect(request).rejects.toThrow('gone');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('the protocols', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leave out the picture that says there is no imagery', async () => {
    vi.stubGlobal('fetch', async () => answer(200, NO_DATA_BYTES));
    await expect(protocols.pilotimagery({ url: 'pilotimagery://19/1/2' }, new AbortController())).rejects.toBeInstanceOf(TileUnavailable);
  });

  it('ask for the tile by its place, imagery as z/y/x and terrain as z/x/y', async () => {
    const urls = [];
    vi.stubGlobal('fetch', async (url) => {
      urls.push(url);
      return answer(200, 500);
    });
    expect((await protocols.pilotimagery({ url: 'pilotimagery://12/1342/2105' }, new AbortController())).data.byteLength).toBe(500);
    await protocols.pilotterrain({ url: 'pilotterrain://9/260/168' }, new AbortController());
    expect(urls[0]).toMatch(/World_Imagery\/MapServer\/tile\/12\/1342\/2105$/);
    expect(urls[1]).toMatch(/terrarium\/9\/260\/168\.png$/);
  });
});

describe('TileHealth', () => {
  const failing = (health, kind, n) => {
    for (let i = 0; i < n; i++) health.record(kind, false);
  };

  it('says nothing while tiles come, or fail only now and then', () => {
    const said = [];
    const health = new TileHealth((t) => said.push(t));
    failing(health, 'imagery', TROUBLE_AFTER - 1);
    health.record('imagery', true);
    failing(health, 'imagery', TROUBLE_AFTER - 1);
    expect(said).toEqual([]);
  });

  it('says in words what keeps failing, and when it is well again', () => {
    const said = [];
    const health = new TileHealth((t) => said.push(t));
    failing(health, 'imagery', TROUBLE_AFTER);
    failing(health, 'imagery', 3);
    failing(health, 'terrain', TROUBLE_AFTER);
    health.record('imagery', true);
    health.record('terrain', true);
    expect(said).toEqual(['Imagery unavailable', 'Imagery and terrain unavailable', 'Terrain unavailable', '']);
  });
});

describe('createPilotMap', () => {
  const body = () => {
    const make = () => {
      const el = {
        className: '',
        style: {},
        children: [],
        clientHeight: 900,
        appendChild(child) {
          child.parent = el;
          el.children.push(child);
        },
        remove() {
          if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
        },
      };
      return el;
    };
    return make;
  };
  let make;
  let container;

  beforeEach(() => {
    maps.length = 0;
    make = body();
    vi.stubGlobal('document', { createElement: make });
    container = make();
  });
  afterEach(() => vi.unstubAllGlobals());

  const place = (map, aglM) => {
    const profile = viewProfile(aglM);
    map.place({ lat: 52, lng: 4, track: 90, eyeM: aglM, groundM: 0, profile });
    return profile;
  };

  it('makes its own element inside the container, and the destroy frees it', async () => {
    const map = await createPilotMap({ container, terrain: true });
    expect(container.children).toHaveLength(1);
    expect(maps[0].options.container).toBe(container.children[0]);
    map.destroy();
    expect(container.children).toHaveLength(0);
    expect(maps[0].removed).toBe(1);
  });

  it('gives each map its own element, so one being removed cannot touch the next', async () => {
    const first = await createPilotMap({ container, terrain: true });
    const second = await createPilotMap({ container, terrain: true });
    expect(maps[0].options.container).not.toBe(maps[1].options.container);
    first.destroy();
    expect(container.children).toEqual([maps[1].options.container]);
    second.destroy();
    expect(container.children).toHaveLength(0);
  });

  it('frees the element even when the map cannot be removed', async () => {
    const map = await createPilotMap({ container, terrain: false });
    maps[0].failToRemove = true;
    expect(() => map.destroy()).toThrow('lost context');
    expect(container.children).toHaveLength(0);
  });

  it('draws at the capped pixel ratio of the globe, not the full one of a Retina screen', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const map = await createPilotMap({ container, terrain: true });
    expect(maps[0].options.pixelRatio).toBe(1.5);
    map.destroy();
    vi.stubGlobal('devicePixelRatio', 1);
    const second = await createPilotMap({ container, terrain: true });
    expect(maps[1].options.pixelRatio).toBe(1);
    second.destroy();
  });

  it('turns the terrain on at the start when asked to', async () => {
    await createPilotMap({ container, terrain: true });
    await createPilotMap({ container, terrain: false });
    expect(maps[0].terrain).toMatchObject({ source: 'dem' });
    expect(maps[1].terrain).toBeNull();
  });

  it('sets the level of detail for every imagery layer once, and again when it changes', async () => {
    const map = await createPilotMap({ container, terrain: true });
    place(map, 915);
    place(map, 920);
    const lods = () => maps[0].calls.filter((c) => c[0] === 'lod');
    expect(lods()).toHaveLength(3);
    expect(lods().map((c) => c[3]).sort()).toEqual(['imagery', 'imagery-far', 'imagery-fine']);
    place(map, 10_000);
    expect(lods()).toHaveLength(6);
    expect(lods().at(-1).slice(1, 3)).toEqual(viewProfile(10_000).lod);
  });

  it('chooses a finer level of detail low down than from far up, and the engine default close to the ground', async () => {
    const map = await createPilotMap({ container, terrain: true });
    place(map, 5);
    place(map, 1000);
    place(map, 9000);
    const lods = maps[0].calls.filter((c) => c[0] === 'lod' && c[3] === 'imagery').map((c) => c.slice(1, 3));
    expect(lods).toEqual([[9.314, 3], [5, 3], [7, 3]]);
  });

  it('sets it all again after the GPU context is lost and comes back', async () => {
    const map = await createPilotMap({ container, terrain: true });
    place(map, 915);
    const before = maps[0].calls.length;
    place(map, 915);
    expect(maps[0].calls.length).toBe(before);
    maps[0].canvasHandlers.webglcontextrestored();
    place(map, 915);
    const after = maps[0].calls.slice(before);
    expect(after.filter((c) => c[0] === 'lod')).toHaveLength(3);
    expect(after.some((c) => c[0] === 'fov')).toBe(true);
    expect(after.some((c) => c[0] === 'sky')).toBe(true);
  });

  it('shows the imagery that fits the height: only the coarse levels from far up, the finest on the ground', async () => {
    const map = await createPilotMap({ container, terrain: true });
    const shown = () => {
      const state = { 'imagery-far': 'none', imagery: 'visible', 'imagery-fine': 'none' };
      for (const [, layer, value] of maps[0].calls.filter((c) => c[0] === 'layout')) state[layer] = value;
      return state;
    };
    place(map, 1000);
    expect(shown()).toEqual({ 'imagery-far': 'none', imagery: 'visible', 'imagery-fine': 'none' });
    place(map, 11_000);
    expect(shown()).toEqual({ 'imagery-far': 'visible', imagery: 'none', 'imagery-fine': 'none' });
    place(map, 1000);
    place(map, 5);
    expect(shown()).toEqual({ 'imagery-far': 'none', imagery: 'visible', 'imagery-fine': 'visible' });
  });

  it('starts nothing again for the same tier', async () => {
    const map = await createPilotMap({ container, terrain: true });
    place(map, 1000);
    place(map, 1010);
    place(map, 990);
    expect(maps[0].calls.filter((c) => c[0] === 'layout')).toHaveLength(0);
  });

  it('keeps tile errors out of the console, and says about any other', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createPilotMap({ container, terrain: true });
    maps[0].handlers.error({ tile: {}, sourceId: 'imagery', error: new Error('tile') });
    maps[0].handlers.error({ sourceId: 'dem', error: new Error('tile') });
    expect(error).not.toHaveBeenCalled();
    maps[0].handlers.error({ error: new Error('shader') });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('gives up on a map whose style never loads, and leaves nothing of it', async () => {
    vi.useFakeTimers();
    silence.style = true;
    try {
      const made = createPilotMap({ container, terrain: true }).catch((err) => err);
      await vi.advanceTimersByTimeAsync(STYLE_TIMEOUT_MS - 1);
      expect(maps[0].removed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect((await made).name).toBe('TimeoutError');
      expect(maps[0].removed).toBe(1);
      expect(container.children).toHaveLength(0);
      // A style that loads after all, once the map is gone, touches nothing.
      maps[0].handlers['style.load']();
      expect(maps[0].terrain).toBeNull();
    } finally {
      silence.style = false;
      vi.useRealTimers();
    }
  });
});
