# FlyTrack — Live Air Traffic Tracking

Realtime flight tracking website built with **OpenSky Network**, **VATSIM**, and **Leaflet**. Watch aircraft positions stream across a live map with clickable flight details, country radar views, and flight filtering.

## Features

- **Live map** — aircraft rendered as heading-rotated plane markers on OpenStreetMap
- **Auto-refresh** — data updates every 25s with an on-screen countdown; pauses while you pan/zoom
- **Detect on click** — follow a flight, view popup (callsign, country, altitude, speed, heading) and a detail panel (altitude, speed, heading, vertical speed, squawk, status)
- **Country radar** — pick any of 236 countries; the map zooms there, tracks that airspace in realtime, and shows every aircraft flying over it
- **Filters** — search by callsign, filter in-air vs on-ground, per-country list
- **Stats** — live counters for tracked / in-air / on-ground aircraft
- **Resilient data layer** — OpenSky is the primary source; on throttling/outage it auto-switches to the VATSIM live feed and flips back when OpenSky recovers

## Requirements

- Python 3.9+ (for the local dev server)
- A modern browser (uses `Intl.DisplayNames` and `fetch` with `AbortController`)

## Run

```bash
python server.py
```

Then open <http://localhost:8080>.

> Use `server.py` (not `python -m http.server`): it serves the site **and** proxies the OpenSky API so browser requests aren't blocked by CORS.

## How it works

- `index.html` — layout (map + sidebar)
- `style.css` — dark-glass UI, markers, flight list, detail panel
- `app.js` — data fetching, markers, filtering, detail rendering
- `icao-countries.js` — ICAO airport-prefix → ISO country table (generated from the public [mwgg/Airports](https://github.com/mwgg/Airports) dataset)
- `countries.js` — complete ISO 3166 alpha-2 country list
- `server.py` — static file server + CORS-free proxy to OpenSky

### Data sources

1. **OpenSky Network** (`/api/states/all` via local proxy) — real ADS-B aircraft. Anonymous tier is rate-limited and can throttle (~hour-scale bans for heavy full-world polling); queries are therefore bounded to a 60° window.
2. **VATSIM** (`data.vatsim.net/v3/vatsim-data.json`) — free, unthrottled, CORS-enabled live feed used automatically as a fallback. Flights are the flight-simulation network: real-time *virtual* traffic on real routes. Country is derived from each flight's departure airport using the ICAO prefix table.

The status pill shows which source is active (`Live — OpenSky` / `Live — VATSIM`).

## License

Not-for-production demo. Map tiles © OpenStreetMap contributors; data © respective providers (OpenSky, VATSIM) under their terms.