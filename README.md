# Antípoda.fm

![Antípoda.fm tuned to a station in New Zealand](docs/launch-poster.png)

**Tune into the live radio station broadcasting nearest Earth's exact opposite point.**

**Live: [antipoda-fm.vercel.app](https://antipoda-fm.vercel.app)** · [launch video](docs/launch.mp4)

## What it does

Every radio app finds the station nearest you. This one points straight down, through the Earth.

Give it your location (geolocation, a place name, or a shared link) and it:

1. Computes your exact antipode — latitude flipped, longitude shifted 180°.
2. Opens the planet along that chord: the shell parts into a molten cross-section while a probe bores through crust, mantle, and core with a live depth readout, then reseals at the far rim when the resolver answers.
3. Asks [Radio Browser](https://www.radio-browser.info/) for the geotagged stations nearest that point, in real distance order.
4. Connects and plays the first living stream it finds, falling back through the dial when a stream is dead — dead links are common on community radio directories.
5. Tells you the truth about what it found: how far the signal sits from the exact point, whether your antipode is open ocean (and where the nearest landfall is), what time and weather it is over there, or that the other side is simply silent.

Ocean antipodes, countries with no stations, dead streams, autoplay blocks — each gets its own honest state.

## The instrument

- **The dial** is a physical tuner — one detent per candidate station. Drag it (detents are magnetic and click as you cross them) or step with arrow keys; release selects the nearest detent. The needle stays warm while connecting and turns phosphor only once the stream reports playing.
- **The scope** draws the real waveform when the stream's CORS policy allows a WebAudio analyser. When it can't, it draws a generated carrier — a slow breathing trace with a sweeping pulse — and says so plainly. An invented waveform dressed as the real one would be a lie.
- **Green is earned**: nothing turns phosphor until the media element reports `playing` — a paused or still-connecting station stays orange.
- On phones the transport pins to the bottom edge with 44px targets; `prefers-reduced-motion` stills every animation loop and snaps the camera — the cutaway simply appears complete instead of flying through.

## How it works

Everything is client-side. No API keys, no backend, no tracking.

- **The antipode** is pure math: `lat' = -lat`, `lon' = lon + 180` normalized into `[-180, 180]`.
- **The globe** is a `<canvas>` orthographic projection driven by a quaternion camera — drag it like a physical body (velocity-tracked fling, exponential damping), pinch or scroll to zoom, or steer it with arrow keys. Coastlines come from bundled Natural Earth 110m polygons, converted to 3D unit vectors once and clipped per frame against the visible hemisphere. Tuning runs a scripted flight — origin, bore, antipode — on a fixed wall-clock timeline, so the trip never inherits network speed; a slow resolver just means the probe rests longer at the far rim.
- **The first-run guide** teaches by doing — grab the planet, name a place, drag the dial — three tips that wait for you to try each thing, skip themselves politely, and never come back unless asked (replay via `?`).
- **Country lookup** unwraps every polygon ring at load (longitudes adjusted ±360 to stay continuous), so point-in-polygon survives the antimeridian — Russia and Fiji don't break it. The Antarctic polar cap is contained explicitly because the dataset truncates near 84°S.
- **The resolver** uses Radio Browser's real proximity search (`geo_lat`, `geo_long`, `geo_distance`, `order=geo_distance`) with widening radii, then tops up from the containing or nearest country's stations. Stations report coordinates, so the distances shown are measured, not claimed. The far-side weather and clock come from Open-Meteo.
- **The player** wraps one `<audio>` element with attempt tokens — a stale promise or a dead stream's late error can never overwrite a newer station. HLS playlists route through `hls.js` (lazy-loaded) unless the browser plays them natively. A CORS probe decides per-URL whether the stream can feed the analyser; when it can't, playback goes direct and the meter admits it's showing carrier only. Autoplay denial lands you on a paused card with a Listen button, not an error.
- **Share links** carry coarsened coordinates (`?lat=..&lon=..`, two decimals), enough to reproduce the tune without pinning your block.

## Run it locally

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # production build to dist/
npm run preview # serve the build
```

## Stack

Vite · React 19 · TypeScript · `<canvas>` globe (no WebGL) · `hls.js` on demand · [Radio Browser API](https://api.radio-browser.info/) · [Open-Meteo geocoding](https://open-meteo.com/) · Natural Earth 110m (bundled) · Fraunces + IBM Plex Mono

## License

MIT. Stations belong to their broadcasters; Radio Browser is a community directory.
