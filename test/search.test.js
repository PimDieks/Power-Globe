import { afterEach, describe, expect, it, vi } from 'vitest';
import { fold, localMatches, searchPlaces, toPlaces } from '../src/search.js';

describe('fold', () => {
  it('ignores case, accents and surrounding space', () => {
    expect(fold('  São Paulo ')).toBe('sao paulo');
    expect(fold('Reykjavík')).toBe('reykjavik');
  });
});

describe('localMatches', () => {
  it('finds built-in cities instantly, accent-insensitively', () => {
    expect(localMatches('sao')[0]).toMatchObject({ name: 'São Paulo', lat: -23.55, lng: -46.63 });
  });

  it('puts names that start with the query first', () => {
    const names = localMatches('am').map((p) => p.name);
    expect(names[0]).toBe('Amsterdam');
  });

  it('needs at least two characters', () => {
    expect(localMatches('a')).toEqual([]);
  });
});

describe('toPlaces', () => {
  it('describes places by region and country without repeating the name', () => {
    const places = toPlaces({
      results: [
        { id: 1, name: 'Amsterdam', latitude: 52.37, longitude: 4.89, admin1: 'North Holland', country: 'Netherlands' },
        { id: 2, name: 'Singapore', latitude: 1.29, longitude: 103.85, admin1: 'Singapore', country: 'Singapore' },
      ],
    });
    expect(places[0]).toEqual({ id: 'place-1', name: 'Amsterdam', detail: 'North Holland, Netherlands', lat: 52.37, lng: 4.89 });
    expect(places[1].detail).toBe('');
  });

  it('handles an answer with no results', () => {
    expect(toPlaces({})).toEqual([]);
  });
});

describe('searchPlaces', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the geocoding service in the reader’s language', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ id: 5, name: 'Utrecht', latitude: 52.09, longitude: 5.12, country: 'Nederland' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const places = await searchPlaces(' utrecht ', 'nl');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe('geocoding-api.open-meteo.com');
    expect(url.searchParams.get('name')).toBe('utrecht');
    expect(url.searchParams.get('language')).toBe('nl');
    expect(places).toEqual([{ id: 'place-5', name: 'Utrecht', detail: 'Nederland', lat: 52.09, lng: 5.12 }]);
  });
});
