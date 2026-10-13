# Power Globe

An open-source, interactive 3D globe that visualizes temperature and other weather conditions around the world.

- **Layers:** temperature, wind speed, precipitation, cloud cover and humidity, each with its own colour scale and legend.
- **Forecast timeline:** a 5-day forecast in 3-hour steps. Press play to animate it, or drag the slider to any time; **Now** jumps back to the present.
- **Two display styles:** a *smooth field* that interpolates the grid into a continuous colour map (blended between time steps while playing), or 3D *bars* where taller means higher.
- **Weather patterns:** animated wind-flow streaks that point downwind, and pulsing rings marking thunderstorms, heavy rain and heavy snow.
- **Details on click:** click anywhere on the globe to see the forecast for that exact spot at the selected time, with a 5-day temperature chart.
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
| `src/main.js` | Sets up the [globe.gl](https://github.com/vasturiano/globe.gl) scene, controls, timeline playback loop and the details panel. |
| `src/weather.js` | Builds the 10° sample grid (612 points) and fetches the hourly forecast from Open-Meteo in batches of 100 locations, keeping every 3rd hour. Results are cached in `localStorage` for an hour. |
| `src/field.js` | The smooth colour field: bilinear interpolation of the grid painted onto a translucent sphere just above the Earth. |
| `src/patterns.js` | Wind-flow streaks and severe-weather classification for the pattern overlays. |
| `src/layers.js` | Layer definitions (Open-Meteo variable, unit, colour stops) and WMO weather-code descriptions. |
| `public/img/` | Earth texture, topology bump map and night-sky background. |

### Adding a layer

Add an entry to `LAYERS` in `src/layers.js` with an Open-Meteo `current` variable name
(see the [API docs](https://open-meteo.com/en/docs)), a unit and colour stops. The fetch
and the UI pick it up automatically.

## Data and attribution

- Weather data: [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free API is for non-commercial use, with a fair-use limit of about 10,000 calls per day.
- Earth imagery: NASA Blue Marble (public domain), via the [three-globe](https://github.com/vasturiano/three-globe) examples (MIT).

## License

[MIT](LICENSE)
