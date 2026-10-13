import { afterEach, describe, expect, it, vi } from 'vitest';
import { Texture } from 'three';
import { RETRY_DELAYS_MS, loadWithRetry, retryUrl, retryingTextureLoad, withLoad } from '../src/tileretry.js';

const URL = 'https://api.example/tiles/openaip/9/264/168.png';
const noWait = () => Promise.resolve();

describe('retryUrl', () => {
  it('leaves the first attempt alone and gives each retry an address of its own', () => {
    expect(retryUrl(URL, 0)).toBe(URL);
    expect(retryUrl(URL, 1)).toBe(`${URL}?retry=1`);
    expect(retryUrl(URL, 3)).toBe(`${URL}?retry=3`);
    expect(retryUrl(`${URL}?key=1`, 2)).toBe(`${URL}?key=1&retry=2`);
  });
});

describe('retry schedule', () => {
  it('is bounded, and spans more than the minute the API counts requests over, even when spread', () => {
    expect(RETRY_DELAYS_MS.length).toBeLessThanOrEqual(5);
    expect(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) * 0.8).toBeGreaterThan(60_000);
  });
});

describe('loadWithRetry', () => {
  it('asks once when the tile loads', async () => {
    const load = vi.fn().mockResolvedValue('image');
    const wait = vi.fn(noWait);
    await expect(loadWithRetry(load, URL, { wait })).resolves.toBe('image');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(URL);
    expect(wait).not.toHaveBeenCalled();
  });

  it('tries again under a new address until the tile loads', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('429')).mockRejectedValueOnce(new Error('502')).mockResolvedValue('image');
    const wait = vi.fn(noWait);
    await expect(loadWithRetry(load, URL, { wait, jitter: () => 0.5 })).resolves.toBe('image');
    expect(load.mock.calls.map(([url]) => url)).toEqual([URL, `${URL}?retry=1`, `${URL}?retry=2`]);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual(RETRY_DELAYS_MS.slice(0, 2));
  });

  it('gives up after the last delay with the last error', async () => {
    const load = vi.fn().mockImplementation((url) => Promise.reject(new Error(`failed ${url}`)));
    await expect(loadWithRetry(load, URL, { wait: noWait })).rejects.toThrow(`failed ${URL}?retry=${RETRY_DELAYS_MS.length}`);
    expect(load).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });

  it('spreads the waits by a fifth either way', async () => {
    const waits = [];
    const load = vi.fn().mockRejectedValue(new Error('no'));
    const wait = (ms) => (waits.push(ms), Promise.resolve());
    await loadWithRetry(load, URL, { delays: [1000], wait, jitter: () => 0 }).catch(() => {});
    await loadWithRetry(load, URL, { delays: [1000], wait, jitter: () => 1 }).catch(() => {});
    expect(waits).toEqual([800, 1200]);
  });

  it('stops retrying a tile that is no longer wanted', async () => {
    const load = vi.fn().mockRejectedValue(new Error('no'));
    await expect(loadWithRetry(load, URL, { wait: noWait, isStale: () => true })).rejects.toThrow('no');
    expect(load).toHaveBeenCalledTimes(1);
  });
});

// An ImageLoader that answers from a script: a function from the address asked for to an image,
// or an error.
function fakeImageLoader(answer) {
  const asked = [];
  class FakeImageLoader {
    constructor(manager) {
      this.manager = manager;
    }
    setCrossOrigin(crossOrigin) {
      this.crossOrigin = crossOrigin;
      return this;
    }
    setPath(path) {
      this.path = path;
      return this;
    }
    load(url, onLoad, onProgress, onError) {
      asked.push(url);
      const result = answer(url, asked.length);
      Promise.resolve().then(() => (result instanceof Error ? onError(result) : onLoad(result)));
    }
  }
  return { FakeImageLoader, asked };
}

describe('retryingTextureLoad', () => {
  const loader = { manager: {}, crossOrigin: 'anonymous', path: '' };
  const blankImage = { blank: true };
  const done = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => vi.restoreAllMocks());

  it('hands over the loaded image as a texture, as TextureLoader does', async () => {
    const image = { tile: 1 };
    const { FakeImageLoader, asked } = fakeImageLoader(() => image);
    const load = retryingTextureLoad({ ImageLoader: FakeImageLoader, Texture, blank: () => blankImage, wait: noWait });
    const onLoad = vi.fn();
    const texture = load.call(loader, URL, onLoad);
    expect(texture).toBeInstanceOf(Texture);
    await done();
    expect(asked).toEqual([URL]);
    expect(onLoad).toHaveBeenCalledWith(texture);
    expect(texture.image).toBe(image);
    expect(texture.version).toBeGreaterThan(0);
  });

  it('loads a tile that fails at first', async () => {
    const image = { tile: 2 };
    const { FakeImageLoader, asked } = fakeImageLoader((url) => (url === URL ? new Error('Too many requests') : image));
    const load = retryingTextureLoad({ ImageLoader: FakeImageLoader, Texture, blank: () => blankImage, wait: noWait });
    const onLoad = vi.fn();
    const texture = load.call(loader, URL, onLoad);
    await done();
    expect(asked).toEqual([URL, `${URL}?retry=1`]);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(texture.image).toBe(image);
  });

  it('hands over a transparent texture for a tile that never loads, so the engine stops waiting for it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { FakeImageLoader, asked } = fakeImageLoader(() => new Error('down'));
    const load = retryingTextureLoad({ ImageLoader: FakeImageLoader, Texture, blank: () => blankImage, wait: noWait });
    const onLoad = vi.fn();
    const texture = load.call(loader, URL, onLoad);
    await done();
    expect(asked).toHaveLength(RETRY_DELAYS_MS.length + 1);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(texture.image).toBe(blankImage);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a tile that was dropped while it was being retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { FakeImageLoader, asked } = fakeImageLoader(() => new Error('down'));
    const load = retryingTextureLoad({ ImageLoader: FakeImageLoader, Texture, blank: () => blankImage, wait: noWait, isStale: () => true });
    const onLoad = vi.fn();
    load.call(loader, URL, onLoad);
    await done();
    expect(asked).toEqual([URL]);
    expect(onLoad).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('withLoad', () => {
  it('swaps the loader for the call and puts the original back', () => {
    const proto = { load: () => 'original' };
    const seen = withLoad(proto, () => 'swapped', () => proto.load());
    expect(seen).toBe('swapped');
    expect(proto.load()).toBe('original');
  });

  it('puts the original back when the call throws', () => {
    const proto = { load: () => 'original' };
    expect(() => withLoad(proto, () => 'swapped', () => { throw new Error('boom'); })).toThrow('boom');
    expect(proto.load()).toBe('original');
  });
});
