# Power Globe

An open-source, interactive 3D globe that visualizes temperature and other weather conditions around the world.

- **Wind as living brushstrokes:** thousands of glowing particles drift along the forecast wind, leaving fading trails, in the spirit of [earth.nullschool.net](https://earth.nullschool.net).
- **Smooth colour fields:** temperature, wind speed, precipitation, cloud cover and humidity are painted as soft, bicubic-interpolated colour maps in muted palettes. Clear skies and dry areas fade to transparent so the Earth shows through.
- **An animated 5-day forecast:** it plays on its own in 3-hour steps, blending smoothly between them. Pause, scrub or jump back to **Now** at any time.
- **A map when you zoom in:** satellite imagery sharpens as you zoom, down to city level ([Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) tiles, with the detail level matched to your screen), country borders and city names fade in, and the area in view loads its own finer weather grid (down to 0.25° spacing), so wind and colour fields show local detail instead of a magnified blur.
- **Made to be watched:** the camera turns slowly, and the controls fade away after a few seconds without interaction, leaving just the globe and a small caption.
- **Severe weather:** soft pulses mark thunderstorms, heavy rain and heavy snow.
- **Search any place:** type a city or place name to fly there and open its forecast, with a pin on the map. Well-known cities appear instantly; anything else comes from [Open-Meteo's geocoding](https://open-meteo.com/en/docs/geocoding-api). Works with arrow keys, Enter and Escape.
- **Details on click:** the forecast for any spot at the selected time, with a 5-day temperature chart.
- **Accessible:** panels stay readable over any part of the map (WCAG AA contrast), controls are large enough to tap, everything works with a keyboard (Escape closes the details panel), and screen readers get landmarks, a spoken summary when you pick a spot and the date as you move the timeline. It follows your system settings: *reduce motion* stops autoplay, rotation and wind particles; *increase contrast* and *reduce transparency* make the panels solid and keep them on screen.
- **No API key needed:** weather data comes from the free [Open-Meteo](https://open-meteo.com/) API.

## Getting started

Requires Node.js 22 or newer.

```bash
npm install
npm run dev      # start the dev server at http://localhost:5173
npm test         # run unit tests
npm run build    # production build in dist/
npm run preview  # serve the production build locally
```

## Deployment

Every push to `main` builds the site and deploys it to GitHub Pages via
`.github/workflows/deploy.yml`. In the repository settings, set **Pages → Source** to
**GitHub Actions** once.

## How it works

| File | Purpose |
| --- | --- |
| `src/main.js` | Sets up the [globe.gl](https://github.com/vasturiano/globe.gl) scene, controls, idle fade, timeline playback loop and the details panel. |
| `src/weather.js` | Builds a 12° sample grid (390 locations, within the free API's per-minute limit) and fetches the 5-day forecast in 3-hour steps. All requests share one queue (the free API allows only a few at once), retry when the API is busy, time out, and are counted against the free limits. Cached in `localStorage` for an hour. |
| `src/field.js` | The colour field: bicubic interpolation of the grid painted onto a translucent sphere just above the Earth. |
| `src/screenflow.js` | Zoomed-in wind particles, drawn straight onto a screen-sized canvas so they stay crisp at any zoom. |
| `src/flow.js` | The wind particles: advected through the interpolated wind field and drawn with fading trails onto a glowing sphere. |
| `src/detail.js` | Works out the area in view when zoomed in and the finer grid to fetch for it (at most 150 locations per request, snapped so nearby views share data, and held back when the free API allowance runs low). |
| `src/map.js` | Satellite tiles over a whole-Earth backdrop, lighting that brightens as you zoom in, and on-demand country borders and city labels. |
| `src/search.js` | The search box: instant matches from the built-in cities, then Open-Meteo geocoding results, as an accessible combobox. |
| `src/cities.js` | Cities to label, in three tiers that appear as you zoom in. |
| `src/patterns.js` | Severe-weather classification for the storm markers. |
| `src/layers.js` | Layer definitions (Open-Meteo variable, unit, palette, opacity) and WMO weather-code descriptions. |
| `public/img/` | Whole-Earth backdrop image, shown where map tiles are missing (the poles, while loading, or offline). |

### Adding a layer

Add an entry to `LAYERS` in `src/layers.js` with an Open-Meteo `current` variable name
(see the [API docs](https://open-meteo.com/en/docs)), a unit and colour stops. The fetch
and the UI pick it up automatically.

## Data and attribution

Precipitation is shown as a rate, mm per hour averaged over the 3 hours up to the time shown, on the map, in the storm markers and in the details panel alike.

- Weather data: [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free API is for non-commercial use, with a fair-use limit of about 10,000 calls per day.
- Satellite tiles: [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) (Esri, Maxar, Earthstar Geographics and the GIS User Community), used under [Esri's terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement).
- Backdrop image: NASA Blue Marble (public domain), via the [three-globe](https://github.com/vasturiano/three-globe) examples (MIT).
- Country borders: [Natural Earth](https://www.naturalearthdata.com/) (public domain), via [world-atlas](https://github.com/topojson/world-atlas).

## License

[MIT](LICENSE)
