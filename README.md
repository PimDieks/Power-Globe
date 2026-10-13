# Power Globe

An open-source, interactive 3D globe that visualizes temperature and other weather conditions around the world.

- **Wind as living brushstrokes:** thousands of glowing particles drift along the forecast wind, leaving fading trails, in the spirit of [earth.nullschool.net](https://earth.nullschool.net).
- **Smooth colour fields:** temperature, wind speed, precipitation, cloud cover and humidity are painted as soft, bicubic-interpolated colour maps in muted palettes. Clear skies and dry areas fade to transparent so the Earth shows through.
- **An animated 5-day forecast:** it plays on its own in 3-hour steps, blending smoothly between them. Pause, scrub or jump back to **Now** at any time.
- **Made to be watched:** the camera turns slowly, and the controls fade away after a few seconds without interaction, leaving just the globe and a small caption.
- **Severe weather:** soft pulses mark thunderstorms, heavy rain and heavy snow.
- **Details on click:** the forecast for any spot at the selected time, with a 5-day temperature chart.
- **Accessible defaults:** with *reduce motion* turned on in your system settings, nothing plays or rotates automatically and the wind particles start switched off.
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
| `src/weather.js` | Builds a 12° sample grid (390 locations, within the free API's per-minute limit) and fetches the 5-day forecast in 3-hour steps, 3 requests at a time with a timeout. Cached in `localStorage` for an hour. |
| `src/field.js` | The colour field: bicubic interpolation of the grid painted onto a translucent sphere just above the Earth. |
| `src/flow.js` | The wind particles: advected through the interpolated wind field and drawn with fading trails onto a glowing sphere. |
| `src/patterns.js` | Severe-weather classification for the storm markers. |
| `src/layers.js` | Layer definitions (Open-Meteo variable, unit, palette, opacity) and WMO weather-code descriptions. |
| `public/img/` | Earth texture and topology bump map. |

### Adding a layer

Add an entry to `LAYERS` in `src/layers.js` with an Open-Meteo `current` variable name
(see the [API docs](https://open-meteo.com/en/docs)), a unit and colour stops. The fetch
and the UI pick it up automatically.

## Data and attribution

- Weather data: [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free API is for non-commercial use, with a fair-use limit of about 10,000 calls per day.
- Earth imagery: NASA Blue Marble (public domain), via the [three-globe](https://github.com/vasturiano/three-globe) examples (MIT).

## License

[MIT](LICENSE)
