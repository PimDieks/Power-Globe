# Power Globe

An open-source, interactive 3D globe that visualizes temperature and other weather conditions around the world, with a runway wind check for airports.

- **Airport conditions:** search any of about 5,000 airports by name, city or ICAO/IATA code (`EHAM`, `JFK`) to fly down to its runways and see the ground conditions at the time on the timeline: temperature, dew point (with the spread, and a fog hint when it is small), wind speed, direction and gusts in knots. Every runway end gets its headwind or tailwind and crosswind, gusts included, with crosswind and tailwind checked against your limits (headwind is shown but not limited), plus an outlook for the next 24 hours.
- **Wind check:** a list of the major airports (about 1,150 large airports with scheduled flights) where wind and gusts put every runway marginal or over the crosswind and tailwind limits, worst first, and marked on the globe. Pick limits for light aircraft, regional or airliner operations or set your own; they are remembered. The list follows the timeline. All airports take a few minutes to load on the free weather API, so choose which come first: those **nearest to the view** (the airports around where you are looking come in at once, and moving the globe while it loads moves the check along) or the **most connected** (airports with routes to the most other airports, where most flights go).

- **Live traffic, each behind its own toggle:**
  - **Flights:** every aircraft broadcasting ADS-B, worldwide from the [OpenSky Network](https://opensky-network.org/) every five minutes (its free anonymous allowance is about 100 worldwide requests a day), and, zoomed in, the area in view every 15 seconds from [adsb.lol](https://adsb.lol/) (falling back to [airplanes.live](https://airplanes.live/) and [adsb.fi](https://adsb.fi/)). Between reports each aircraft moves along its track at its ground speed, drawn as a plane pointing where it is heading.
  - **Military flights:** the worldwide military feed from the same ADS-B networks, in their own colour. Only aircraft that broadcast ADS-B are included.
  - **Satellites:** all active satellites, or just space stations, Starlink, navigation, weather or military satellites, from [CelesTrak](https://celestrak.org/)'s orbital elements, computed live with SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) in a background worker, at their real height: low orbits close in, the geostationary belt far out.
  - Tap an aircraft for its altitude, speed, track, climb or descent, squawk (emergencies stand out), registration, type and operator; tap a satellite for its altitude, speed, orbit, period and inclination, with its next orbit drawn.
- **Four views of the Earth:** satellite imagery, streets, topographic, or night lights (NASA Black Marble). Choose **None** among the weather layers for just the map.
- **Wind as living brushstrokes:** thousands of glowing particles drift along the forecast wind, leaving fading trails, in the spirit of [earth.nullschool.net](https://earth.nullschool.net).
- **Smooth colour fields:** temperature, wind speed, precipitation, cloud cover and humidity are painted as soft, bicubic-interpolated colour maps in muted palettes. Clear skies and dry areas fade to transparent so the Earth shows through.
- **An animated 5-day forecast:** it plays on its own in 3-hour steps, blending smoothly between them. Pause, scrub or jump back to **Now** at any time.
- **A map when you zoom in:** satellite imagery sharpens as you zoom, down to city level ([Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) tiles, with the detail level matched to your screen), country borders and city names fade in, and the area in view loads its own finer weather grid (down to 0.25° spacing), so wind and colour fields show local detail instead of a magnified blur.
- **Made to be watched:** the camera turns slowly, and the controls fade away after a few seconds without interaction, leaving just the globe and a small caption.
- **Severe weather:** soft pulses mark thunderstorms, heavy rain and heavy snow.
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
npm run airports # rebuild public/data/airports.json from the latest OurAirports data
npm run satellites # save CelesTrak's satellite elements into public/data/satellites/ (optional)
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
| `src/map.js` | The four Earth views (map tiles over a whole-Earth backdrop), lighting that brightens as you zoom in, and on-demand country borders and city labels. |
| `src/aircraft.js` | Reads the OpenSky and ADS-B Exchange style flight feeds into one shape, merges them and estimates each aircraft's position between reports. |
| `src/orbits.js`, `src/satworker.js` | Satellite positions from orbital elements (SGP4), worked out in a worker a second apart and blended on the GPU. |
| `src/traffic.js` | The live traffic layers: feeds and their timing, toggles, drawing, and tapping an aircraft or satellite. |
| `src/trafficlayer.js` | Aircraft and satellites as GPU point sprites, the selection ring and the orbit line. |
| `src/trafficview.js` | The details panel for an aircraft or satellite. |
| `scripts/fetch-satellites.mjs` | Saves a copy of CelesTrak's elements into the site at deploy time (every six hours), used while CelesTrak is not needed or cannot be reached. |
| `src/search.js` | The search box, as an accessible combobox. |
| `src/airports.js` | The airport list, airport search, and hourly ground conditions at airports (cached for an hour). |
| `src/runways.js` | Headwind, tailwind and crosswind on each runway end, and the limit presets. Limits are checked against the stronger of the mean wind and the gusts. |
| `src/airportview.js` | The airport details panel and the wind check list. |
| `src/windcheck.js` | The wind check: limits, nearest-first loading paced to the free API, and the list. |
| `scripts/build-airports.mjs` | Builds `public/data/airports.json`: medium and large airports with their open runways and true headings from OurAirports, and how many airports each has routes to, from OpenFlights. |
| `src/cities.js` | Cities to label, in three tiers that appear as you zoom in. |
| `src/patterns.js` | Severe-weather classification for the storm markers. |
| `src/layers.js` | Layer definitions (Open-Meteo variable, unit, palette, opacity) and WMO weather-code descriptions. |
| `public/img/` | Whole-Earth backdrop image, shown where map tiles are missing (the poles, while loading, or offline). |

### Adding a layer

Add an entry to `LAYERS` in `src/layers.js` with an Open-Meteo `current` variable name
(see the [API docs](https://open-meteo.com/en/docs)), a unit and colour stops. The fetch
and the UI pick it up automatically.

## Data and attribution

**The airport tools are an aid to planning, not for operational decisions.** Conditions are model forecasts for the airport's position and elevation, not observations: check the official METAR and TAF, and the limits for your aircraft and operator. Runway headings are true headings from OurAirports; wind directions are true as well.

Precipitation is shown as a rate, mm per hour averaged over the 3 hours up to the time shown, on the map, in the storm markers and in the details panel alike.

- Weather data: [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free API is for non-commercial use, with a fair-use limit of about 10,000 calls per day.
- Live flights: [The OpenSky Network](https://opensky-network.org/) (free for non-commercial use), [adsb.lol](https://adsb.lol/) (Open Database License), [airplanes.live](https://airplanes.live/) and [adsb.fi](https://adsb.fi/) (free for non-commercial use).
- Satellites: orbital elements from [CelesTrak](https://celestrak.org/); positions computed with [satellite.js](https://github.com/shashwatak/satellite-js) (MIT).
- Street and topographic maps: [Esri](https://www.esri.com/) World Street Map and World Topo Map (Esri, HERE, Garmin, USGS, OpenStreetMap contributors and the GIS User Community), under [Esri's terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement).
- Night lights: [NASA Black Marble](https://earthobservatory.nasa.gov/features/NightLights) (public domain), via [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api).
- Satellite tiles: [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) (Esri, Maxar, Earthstar Geographics and the GIS User Community), used under [Esri's terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement).
- Backdrop image: NASA Blue Marble (public domain), via the [three-globe](https://github.com/vasturiano/three-globe) examples (MIT).
- Airports and runways: [OurAirports](https://ourairports.com/data/) (public domain).
- Route counts: [OpenFlights](https://openflights.org/data.php) route database, under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Its routes were last updated in 2014, so the counts are a rough measure of how connected an airport is.
- Country borders: [Natural Earth](https://www.naturalearthdata.com/) (public domain), via [world-atlas](https://github.com/topojson/world-atlas).

## License

[MIT](LICENSE)
