# Power Globe

An open-source, interactive 3D globe that visualizes temperature and other weather conditions around the world, with a runway wind check for airports.

- **Airport conditions:** search any of about 5,000 airports by name, city or ICAO/IATA code (`EHAM`, `JFK`) to fly down to its runways and see the ground conditions at the time on the timeline: temperature, dew point (with the spread, and a fog hint when it is small), wind speed, direction and gusts in knots. Every runway end gets its headwind or tailwind and crosswind, gusts included, with crosswind and tailwind checked against your limits (headwind is shown but not limited), plus an outlook for the next 24 hours.
- **Airports on the map:** zoomed in to a region, airfields are labelled where they are (✈ code, and closer in their name), big airports first and smaller ones as you zoom in, never on top of each other or a city name; the plane turns green, amber or red once the airport's wind is known, and tapping a label flies in to the airport (as the search does, but never back out from a closer view) and opens it.
- **Runways on the map:** zoom in on any airport and its runways are drawn to scale in their real layout (from OurAirports' threshold positions), coloured by whether they can be used in the forecast wind at the time on the timeline: green within limits, amber marginal, red out of limits. Closer in, each runway end gets a label (`27 ✓`) and each airport its wind; tap the wind to open the airport.
- **Observed now:** the airport panel shows the latest official observation (METAR, from NOAA's Aviation Weather Center): the raw report, flight category (VFR, MVFR, IFR, LIFR), visibility and ceiling, and the runway check in the observed wind, above the forecast.
- **Wind check:** a list of the major airports (about 1,150 large airports with scheduled flights) where wind and gusts put every runway marginal or over the crosswind and tailwind limits, worst first, and marked on the globe. Pick limits for light aircraft, regional or airliner operations or set your own; they are remembered. The list follows the timeline. All airports take a few minutes to load on the free weather API, so choose which come first: those **nearest to the view** (the airports around where you are looking come in at once, and moving the globe while it loads moves the check along) or the **most connected** (airports with routes to the most other airports, where most flights go).

- **Live traffic, each behind its own toggle:**
  - **Flights:** every aircraft broadcasting ADS-B, worldwide from the [OpenSky Network](https://opensky-network.org/) every five minutes, or two with an OpenSky account (see Power Globe API), and the area around the middle of the view (up to 250 nautical miles) every 15 seconds from [adsb.lol](https://adsb.lol/) (falling back to [airplanes.live](https://airplanes.live/) and [adsb.fi](https://adsb.fi/)). Between reports each aircraft moves along its track at its ground speed, drawn as a plane pointing where it is heading.
  - **Military flights:** the worldwide military feed from the same ADS-B networks, in their own colour. Only aircraft that broadcast ADS-B are included.
  - **Satellites:** all active satellites, or just space stations, Starlink, navigation, weather or military satellites, from [CelesTrak](https://celestrak.org/)'s orbital elements, computed live with SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) in a background worker, at their real height: low orbits close in, the geostationary belt far out.
  - Tap an aircraft for its altitude, speed, track, climb or descent, squawk (emergencies stand out), registration, type and operator; tap a satellite for its altitude, speed, orbit, period and inclination, with its next orbit drawn.
- **Five views of the Earth:** satellite imagery, streets, topographic, an aviation chart (openAIP airspaces, airports and navaids over a light grey map; needs an openAIP key in the Power Globe API), or yesterday's clouds as seen from space (NASA VIIRS true colour, continuing as the satellite imagery once zoomed in past its 300 m resolution). Choose **None** among the weather layers for just the map.
- **Wind as living brushstrokes:** thousands of glowing particles drift along the forecast wind, leaving fading trails, in the spirit of [earth.nullschool.net](https://earth.nullschool.net).
- **Smooth colour fields:** temperature, wind speed, precipitation, cloud cover and humidity are painted as soft, bicubic-interpolated colour maps in muted palettes. Clear skies and dry areas fade to transparent so the Earth shows through.
- **An animated 5-day forecast:** it plays on its own in 3-hour steps, blending smoothly between them. Pause, scrub or jump back to **Now** at any time.
- **A map when you zoom in:** satellite imagery sharpens as you zoom, down to city level ([Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) tiles, with the detail level matched to your screen), country borders and city names fade in, and, while a weather layer or wind flow is on, the area in view loads its own finer weather grid (down to 0.25° spacing), so wind and colour fields show local detail instead of a magnified blur.
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
npm run data       # build the site's own forecast and airport weather into public/data/api/ (optional)
```

## The site's own data (Power Globe data API)

Visitors should not depend on public services that limit or refuse requests, so the site carries its own copy of the data it needs, rebuilt every six hours by the deploy workflow and served next to the site under `data/`:

| File | Contents | Source |
| --- | --- | --- |
| `data/api/forecast.json` | The global forecast grid the globe shows, 5 days every 3 hours | Open-Meteo |
| `data/api/airport-weather.json` | Temperature, dew point, wind and gusts (kt) at the ~1,150 major airports, 5 days every 3 hours | Open-Meteo |
| `data/airports.json` | Airports, runways (headings, thresholds, widths) and route counts | OurAirports, OpenFlights |
| `data/satellites/<group>.tle` | Satellite orbital elements | CelesTrak |
| `data/api/index.json` | What is there and when it was built | |

The globe and the wind check use these while they are less than six and a half hours old (one shared download instead of every visitor spending the free API allowance; the wind check fills in all major airports at once), ask Open-Meteo directly otherwise, and fall back to the copy if Open-Meteo fails. The airport panel asks Open-Meteo first for the freshest forecast, and when Open-Meteo refuses or this browser's allowance is short it asks the Power Globe API, then the site's copy; if none of them answers, the panel says why. Build them yourself with `npm run data` (about 1,550 Open-Meteo locations, paced to its limits).

## Power Globe API (live data proxy)

Live flights, METARs and (if needed) satellites come from services that do not accept requests from web pages (browsers block them, "Failed to fetch"). `api/worker.js` is a small proxy for them, run on Cloudflare Workers (free plan: 100,000 requests a day). It fetches the open feeds server-side, caches each answer at the edge (flights in an area 10 s, worldwide military 30 s, worldwide flights 60 s, METARs 2 min, satellites 2 h) so visitors share requests, and only answers this site. Routes: `/flights/global`, `/flights/area?lat=&lon=&nm=`, `/flights/military`, `/metar?ids=`, `/satellites/<group>`, and `/forecast?<Open-Meteo query>` (cached 30 min), which the site uses when Open-Meteo refuses a visitor (for example after its daily limit).

### Never overloading the services

- **One shared answer instead of many:** the site's own data (above) and the API's edge cache mean visitors share downloads; the global forecast is the same for everyone.
- **Backups instead of retries:** the API keeps every answer for 6 hours and serves that copy if a service fails or limits it, rather than asking again.
- **Refusals remembered:** a flight feed that refuses the API (401 or 403) is left alone for 6 hours, and one that limits it (429) for a minute or as long as it asks, instead of being asked again on every request; the other feeds answer meanwhile, and the feed is asked again by itself afterwards, so it comes back once access is granted. What was refused when asked direct is not held against the relay. This is remembered per Cloudflare location, as the edge cache is.
- **Per-visitor limits:** the API answers each visitor at most 120 requests a minute.
- **Browser budgets:** each browser keeps to half of Open-Meteo's free daily allowance (5,000 locations, remembered across page loads) and to its per-minute and per-hour limits, and after a limit is reported stops asking until it resets (the next day for the daily limit), using the site's copy or the API instead. Lists (the wind check, the airport labels) wait for the per-minute and per-hour allowance and keep 20 locations free; the airport being looked at uses those and goes straight to the API instead of waiting. When Open-Meteo cannot be asked at all (paused, or the day's share spent), a list takes the site's copy first and asks the API only for the airports it lacks. Zoomed-in detail is skipped rather than sent through the API, and is not loaded at all unless a weather layer or wind flow is on.
- **Paced feeds:** flights are asked for at most every 15 seconds (area), 60 seconds (military) and 5 minutes (worldwide), METARs at most every 5 minutes per airport, satellites every 2 hours.

To set it up once:

1. Create a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up), open **Workers & Pages** once so it gives you a `workers.dev` subdomain, and note your **Account ID** (shown on that page).
2. Under **My Profile → API Tokens**, create a token from the **Edit Cloudflare Workers** template.
3. In this repository's **Settings → Secrets and variables → Actions**, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Run the **Deploy the Power Globe API** workflow (Actions tab). Its log ends with the API's address, like `https://power-globe-api.<subdomain>.workers.dev`.
5. This site's API (`https://power-globe-api.pimdieks.workers.dev`) is built in (`src/api.js`). A fork adds its own address as the variable `API_URL` under **Settings → Secrets and variables → Actions → Variables**, and runs **Deploy to GitHub Pages**.

Optionally, with a free OpenSky Network account, create an API client on its account page and add its `clientId` and `clientSecret` as the repository secrets `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`; the workflow hands them to the Worker (or run `npx wrangler secret put OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` in `api/`). The worldwide flights then refresh every 2 minutes instead of 5, within the account's daily allowance. For the Aviation map, add a free [openAIP](https://www.openaip.net/) API key as the repository secret `OPENAIP_API_KEY`; the Worker serves the chart tiles with it, cached for a day, so the key never reaches the page. Without the proxy everything else works; live flights and METARs then show why they are unavailable.

### Flight relay for the API

The flight feeds limit or refuse Cloudflare's servers, whose addresses many sites share: OpenSky does not answer them, adsb.lol answers 429 and airplanes.live and adsb.fi answer 403. OpenSky, adsb.lol and adsb.fi do answer other connections (airplanes.live asks those who ask from a server to email them first; until then it answers 403 and the API leaves it alone as described above). `relay/api-relay.mjs` is a small relay for them, run on a machine of your own: a Raspberry Pi at home, a home server, or a small virtual server with its own address (not another serverless platform, whose shared addresses the feeds treat the same way). The API then asks the flight feeds through it, so every visitor gets flights, and still caches every answer, so the relay is only asked as often as the feeds were before. The relay asks only the flight feeds, only for requests carrying its key, each feed at most once a second, and compresses its answers: about 30 MB an hour up the home connection while someone is watching flights, nothing when nobody is.

On the Pi (Raspberry Pi OS; any Linux with systemd works the same):

1. Install Node.js and the relay, and give it a key:
   ```sh
   sudo apt install -y nodejs
   sudo mkdir -p /opt/power-globe-api-relay
   sudo curl -fsSL -o /opt/power-globe-api-relay/api-relay.mjs https://raw.githubusercontent.com/PimDieks/Power-Globe/main/relay/api-relay.mjs
   sudo curl -fsSL -o /etc/systemd/system/power-globe-api-relay.service https://raw.githubusercontent.com/PimDieks/Power-Globe/main/relay/power-globe-api-relay.service
   echo "RELAY_KEY=$(openssl rand -hex 32)" | sudo tee /etc/power-globe-api-relay.env >/dev/null
   sudo chmod 600 /etc/power-globe-api-relay.env
   sudo systemctl enable --now power-globe-api-relay
   ```
   It listens on `http://127.0.0.1:8788`, on the Pi only; `curl localhost:8788` answers with its name.
2. Give it a public HTTPS address without opening a port on the router, for example with [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (free):
   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   sudo tailscale funnel --bg 8788
   ```
   The first time, it gives a link to allow Funnel for your tailnet. It then prints the address, like `https://raspberrypi.tail1234.ts.net`, and keeps it across restarts. (A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to `http://localhost:8788` works as well, with a domain of your own on Cloudflare.)
3. In this repository's **Settings → Secrets and variables → Actions**, add the secrets `FLIGHT_RELAY_URL` (that address) and `FLIGHT_RELAY_KEY` (the key, shown by `sudo cat /etc/power-globe-api-relay.env`, without `RELAY_KEY=`), and run the **Deploy the Power Globe API** workflow. Its check step should show `"relay":"on"` and flights answering 200.

When the relay cannot be reached, the API says so ("… through the relay") and serves its last answers for up to 6 hours. The relay's own answers: 401, the key does not match; 404, a host it does not ask (the API then asks again a minute later); 429, a feed is being asked too often; 504, the feed did not answer the relay. `journalctl -u power-globe-api-relay` shows what went wrong. To update it, download `api-relay.mjs` again and `sudo systemctl restart power-globe-api-relay`.

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
| `src/airportmap.js`, `src/runwaymap.js` | Runways on the map, coloured by wind status, with runway end and wind labels. |
| `src/metar.js` | The latest METAR and flight category. |
| `src/api.js` | Where the site's own data and the live proxy are. |
| `scripts/build-data.mjs` | Builds the site's own data API (forecast and airport weather). |
| `api/worker.js` | The Power Globe API: the live data proxy (Cloudflare Worker). |
| `relay/api-relay.mjs` | The flight relay for the API: asks the flight feeds for it from a machine of your own (see Flight relay for the API). |
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
| `public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` | The site icon: a globe in the app's blues, as an SVG with PNG fallbacks for older browsers and iOS. |

### Adding a layer

Add an entry to `LAYERS` in `src/layers.js` with an Open-Meteo `current` variable name
(see the [API docs](https://open-meteo.com/en/docs)), a unit and colour stops. The fetch
and the UI pick it up automatically.

## Data and attribution

**The airport tools are an aid to planning, not for operational decisions.** Conditions are model forecasts for the airport's position and elevation, not observations: check the official METAR and TAF, and the limits for your aircraft and operator. Runway headings are true headings from OurAirports; wind directions are true as well.

Precipitation is shown as a rate, mm per hour averaged over the 3 hours up to the time shown, on the map, in the storm markers and in the details panel alike.

- Weather data: [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free API is for non-commercial use, with a fair-use limit of about 10,000 calls per day.
- Observations (METAR): [NOAA Aviation Weather Center](https://aviationweather.gov/data/api/) (public domain).
- Live flights: [The OpenSky Network](https://opensky-network.org/) (free for non-commercial use), [adsb.lol](https://adsb.lol/) (Open Database License), [airplanes.live](https://airplanes.live/) and [adsb.fi](https://adsb.fi/) (free for non-commercial use).
- Satellites: orbital elements from [CelesTrak](https://celestrak.org/); positions computed with [satellite.js](https://github.com/shashwatak/satellite-js) (MIT).
- Street and topographic maps: [Esri](https://www.esri.com/) World Street Map and World Topo Map (Esri, HERE, Garmin, USGS, OpenStreetMap contributors and the GIS User Community), under [Esri's terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement).
- Aviation chart: [openAIP](https://www.openaip.net/), under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/); base map [Esri](https://www.esri.com/) World Light Gray Canvas.
- Daily clouds: [NASA VIIRS](https://www.earthdata.nasa.gov/data/instruments/viirs) corrected reflectance, true colour, from NOAA-20 (public domain), via [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api).
- Satellite tiles: [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) (Esri, Maxar, Earthstar Geographics and the GIS User Community), used under [Esri's terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement).
- Backdrop image: NASA Blue Marble (public domain), via the [three-globe](https://github.com/vasturiano/three-globe) examples (MIT).
- Airports and runways: [OurAirports](https://ourairports.com/data/) (public domain).
- Route counts: [OpenFlights](https://openflights.org/data.php) route database, under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Its routes were last updated in 2014, so the counts are a rough measure of how connected an airport is.
- Country borders: [Natural Earth](https://www.naturalearthdata.com/) (public domain), via [world-atlas](https://github.com/topojson/world-atlas).

## License

[MIT](LICENSE)
