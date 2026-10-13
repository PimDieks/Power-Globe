import { CITIES } from './cities.js';
import { queuedJson } from './weather.js';

// Open-Meteo's free geocoding: any city or place worldwide, no key needed.
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_RESULTS = 6;
// Wait for a pause in typing before asking the geocoding service.
const TYPING_PAUSE_MS = 300;

// Case- and accent-insensitive form for matching, so "sao" finds "São Paulo".
export const fold = (text) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

// Instant matches from the built-in city list, shown while the geocoding service answers.
// Names starting with the query come first, then bigger cities.
export function localMatches(query, limit = MAX_RESULTS) {
  const q = fold(query);
  if (q.length < 2) return [];
  return CITIES.map((city) => ({ city, name: fold(city.name) }))
    .filter(({ name }) => name.includes(q))
    .sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.city.tier - b.city.tier)
    .slice(0, limit)
    .map(({ city }) => ({ id: `city-${city.name}`, name: city.name, detail: '', lat: city.lat, lng: city.lng }));
}

// Places from a geocoding response, with region and country as a short description.
export function toPlaces(response) {
  return (response?.results ?? []).map((r) => ({
    id: `place-${r.id}`,
    name: r.name,
    detail: [...new Set([r.admin1, r.country])].filter((part) => part && part !== r.name).join(', '),
    lat: r.latitude,
    lng: r.longitude,
  }));
}

export async function searchPlaces(query, language = 'en') {
  const params = new URLSearchParams({ name: query.trim(), count: String(MAX_RESULTS), language, format: 'json' });
  return toPlaces(await queuedJson(`${GEOCODING_URL}?${params}`));
}

// A search box with a list of suggestions (the ARIA combobox pattern): type to search, arrow keys
// to move through the results, Enter to pick one, Escape to close the list or clear the box.
export function setupSearch({ input, list, status, onSelect }) {
  const language = (navigator.language || 'en').slice(0, 2);
  let results = [];
  let active = -1;
  let timer;
  let latest = 0;

  function render() {
    list.replaceChildren(
      ...results.map((place, i) => {
        const option = document.createElement('li');
        option.id = `search-option-${i}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(i === active));
        const name = document.createElement('span');
        name.className = 'search-name';
        name.textContent = place.name;
        option.append(name);
        if (place.detail) {
          const detail = document.createElement('span');
          detail.className = 'search-detail';
          detail.textContent = place.detail;
          option.append(detail);
        }
        // Keep focus in the box while clicking, so the list does not close first.
        option.addEventListener('mousedown', (event) => event.preventDefault());
        option.addEventListener('click', () => choose(i));
        return option;
      }),
    );
    const open = results.length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `search-option-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function show(places, message = '') {
    results = places;
    active = -1;
    render();
    status.textContent = message;
  }

  function choose(i) {
    const place = results[i];
    if (!place) return;
    input.value = place.name;
    show([]);
    onSelect(place);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value;
    const request = ++latest;
    if (fold(query).length < 2) {
      show([]);
      return;
    }
    show(localMatches(query));
    timer = setTimeout(async () => {
      try {
        const places = await searchPlaces(query, language);
        // Ignore answers to queries that have since been replaced by more typing.
        if (request !== latest) return;
        if (places.length) show(places, `${places.length} places found`);
        else if (!results.length) show([], 'No places found');
      } catch (err) {
        console.error(err);
        if (request === latest && !results.length) show([], 'Search is unavailable right now');
      }
    }, TYPING_PAUSE_MS);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + delta + results.length) % results.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (results.length) choose(Math.max(0, active));
    } else if (event.key === 'Escape' && (results.length || input.value)) {
      // Close the list, or else clear the box; only Escape in an empty box reaches the page
      // (where it closes the details panel).
      event.stopPropagation();
      event.preventDefault();
      if (results.length) show([]);
      else {
        input.value = '';
        show([]);
      }
    }
  });

  input.addEventListener('blur', () => {
    results = [];
    active = -1;
    render();
  });
}
