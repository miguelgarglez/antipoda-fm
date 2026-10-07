import { GeoPoint, haversineKm } from "./geo-math";
import { countryAt, nearestLands, Country } from "./earth";

export type Station = {
  stationuuid: string;
  name: string;
  country: string;
  countrycode: string;
  language: string;
  urlResolved: string;
  codec: string;
  bitrate: number;
  votes: number;
  hls: number;
  geoLat: number | null;
  geoLong: number | null;
};

export type TuneResult = {
  origin: GeoPoint;
  antipode: GeoPoint;
  candidates: Station[];
  land: { country: Country; oceanKm: number | null };
};

const MIRRORS = [
  "https://de1.api.radio-browser.info",
  "https://de2.api.radio-browser.info",
  "https://all.api.radio-browser.info",
];

async function rbGet<T>(path: string): Promise<T> {
  const start = Math.floor(Math.random() * MIRRORS.length);
  let lastErr: unknown = null;
  for (let i = 0; i < MIRRORS.length; i++) {
    const base = MIRRORS[(start + i) % MIRRORS.length];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch(`${base}${path}`, {
        signal: ctrl.signal,
        headers: { "User-Agent": "antipoda-fm/0.1" },
      });
      const body = (await res.json()) as T;
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return body;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

type Raw = Record<string, unknown>;

function toStation(s: Raw): Station | null {
  const url = String(s.url_resolved ?? "").trim();
  if (!url.startsWith("https://")) return null;
  const geoLat = s.geo_lat;
  const geoLong = s.geo_long;
  const located =
    typeof geoLat === "number" &&
    typeof geoLong === "number" &&
    Math.abs(geoLat) <= 90 &&
    Math.abs(geoLong) <= 180;
  return {
    stationuuid: String(s.stationuuid ?? ""),
    name: String(s.name ?? "").trim().replace(/\s+/g, " "),
    country: String(s.country ?? "").trim(),
    countrycode: String(s.countrycode ?? "").trim(),
    language: String(s.language ?? "").trim(),
    urlResolved: url,
    codec: String(s.codec ?? "").trim(),
    bitrate: Number(s.bitrate ?? 0),
    votes: Number(s.votes ?? 0),
    hls: Number(s.hls ?? 0),
    geoLat: located ? geoLat : null,
    geoLong: located ? geoLong : null,
  };
}

function clean(list: Raw[]): Station[] {
  const seen = new Set<string>();
  return list
    .map(toStation)
    .filter((s): s is Station => s !== null && s.name.length > 0)
    .filter((s) => (seen.has(s.stationuuid) ? false : (seen.add(s.stationuuid), true)));
}

/**
 * Stations nearest a point, ordered by real distance. geo_distance is in
 * meters; the search returns geotagged stations only. The radius widens
 * until a few candidates exist or the dial is truly empty.
 */
async function nearStations(p: GeoPoint): Promise<Station[]> {
  const radii = [1_000_000, 2_500_000, 6_000_000];
  let found: Station[] = [];
  let lastErr: unknown = null;
  let ok = false;
  for (const r of radii) {
    try {
      const raw = await rbGet<Raw[]>(
        `/json/stations/search?geo_lat=${p.lat}&geo_long=${p.lon}&geo_distance=${r}&order=geo_distance&limit=80&hidebroken=true`,
      );
      ok = true;
      const list = clean(raw)
        .filter((s) => s.geoLat !== null && s.geoLong !== null)
        .sort(
          (a, b) =>
            haversineKm(p, { lat: a.geoLat!, lon: a.geoLong! }) -
            haversineKm(p, { lat: b.geoLat!, lon: b.geoLong! }),
        );
      // A wider radius should be a superset, but an empty reply must not
      // discard stations the smaller radius already found.
      if (list.length > 0 || found.length === 0) found = list;
      if (found.length >= 4) break;
    } catch (e) {
      lastErr = e;
      // Keep whatever earlier radii already gave us.
      if (found.length > 0) break;
    }
  }
  if (!ok && found.length === 0) throw lastErr;
  return found.slice(0, 8);
}

/** Stations in a country, most-loved first — backup for unlocated dials. */
async function countryStations(iso2: string): Promise<Station[]> {
  const raw = await rbGet<Raw[]>(
    `/json/stations/bycountrycodeexact/${encodeURIComponent(iso2)}?order=votes&reverse=true&limit=200&hidebroken=true`,
  );
  return clean(raw);
}

/** Fallback for countries with no ISO code: name-contains search. */
async function namedCountryStations(name: string): Promise<Station[]> {
  const raw = await rbGet<Raw[]>(
    `/json/stations/search?country=${encodeURIComponent(name)}&order=votes&reverse=true&limit=200&hidebroken=true`,
  );
  return clean(raw);
}

const rank = (a: Station, b: Station) =>
  a.hls - b.hls ||
  Number(b.codec.toUpperCase().includes("MP3")) - Number(a.codec.toUpperCase().includes("MP3")) ||
  b.votes - a.votes;

/**
 * Find the signals at an antipode. Primary path: a real proximity query —
 * geotagged stations ordered by distance to the point. If the dial around
 * the point is thin (or every proximity mirror failed), fall back to the
 * stations of the country containing / nearest the point, unlocated ones
 * trailing as last resorts.
 */
export async function resolveSignals(origin: GeoPoint, antipode: GeoPoint): Promise<TuneResult> {
  const hit = countryAt(antipode);
  const lands = hit
    ? [{ country: hit, km: 0, point: antipode }]
    : nearestLands(antipode, 3);
  const oceanKm = hit ? null : lands[0].km;

  const candidates: Station[] = [];
  const seen = new Set<string>();
  const push = (s: Station) => {
    if (!seen.has(s.stationuuid) && candidates.length < 10) {
      seen.add(s.stationuuid);
      candidates.push(s);
    }
  };

  let lastErr: unknown = null;
  let succeeded = 0;

  try {
    const near = await nearStations(antipode);
    succeeded++;
    near.forEach(push);
  } catch (e) {
    lastErr = e;
  }

  // Top up from the country / nearest lands so the dial keeps depth when
  // proximity yields little or nearby streams all turn out dead locally.
  if (candidates.length < 10) {
    for (const land of lands) {
      if (candidates.length >= 10) break;
      try {
        const list = land.country.iso2
          ? await countryStations(land.country.iso2)
          : await namedCountryStations(land.country.name);
        succeeded++;
        const dist = (s: Station) =>
          s.geoLat === null || s.geoLong === null
            ? Infinity
            : haversineKm(antipode, { lat: s.geoLat, lon: s.geoLong });
        // push() dedupes against proximity results and stops at the cap, so
        // later lands keep topping up after overlaps.
        [...list]
          .sort((a, b) => dist(a) - dist(b) || rank(a, b))
          .forEach(push);
      } catch (e) {
        lastErr = e;
      }
    }
  }

  if (candidates.length === 0 && succeeded === 0 && lastErr !== null) {
    throw lastErr;
  }

  return {
    origin,
    antipode,
    candidates,
    land: { country: lands[0].country, oceanKm },
  };
}

export function stationDistanceKm(s: Station, from: GeoPoint): number | null {
  if (s.geoLat === null || s.geoLong === null) return null;
  return haversineKm(from, { lat: s.geoLat, lon: s.geoLong });
}
