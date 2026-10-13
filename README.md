# Power Globe

An open-source, interactive 3D globe that visualizes temperature and other weather conditions around the world.

- **Layers:** temperature, wind speed, precipitation, cloud cover and humidity, each with its own colour scale and legend.
- **Global view:** current conditions are sampled on a 10° grid (612 points) and drawn as coloured bars; taller bars mean higher values.
- **Details on click:** click anywhere on the globe to fetch the current conditions for that exact spot.
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

## How it works

| File | Purpose |
| --- | --- |
| `src/main.js` | Sets up the [globe.gl](https://github.com/vasturiano/globe.gl) scene, layer switching, legend and the details panel. |
| `src/weather.js` | Builds the sample grid and fetches current conditions from Open-Meteo in batches of 100 locations. Results are cached in `localStorage` for 30 minutes. |
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
