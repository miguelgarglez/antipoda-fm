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

/** Stations in a country, most-loved first. */
async function countryStations(iso2: string): Promise<Station[]> {
  const raw = await rbGet<Raw[]>(
    `/json/stations/bycountrycodeexact/${encodeURIComponent(iso2)}?order=votes&reverse=true&limit=60&hidebroken=true`,
  );
  return clean(raw);
}

/** Fallback for countries with no ISO code: name-contains search. */
async function namedCountryStations(name: string): Promise<Station[]> {
  const raw = await rbGet<Raw[]>(
    `/json/stations/search?country=${encodeURIComponent(name)}&order=votes&reverse=true&limit=40&hidebroken=true`,
  );
  return clean(raw);
}

async function stationsFor(country: Country): Promise<Station[]> {
  if (country.iso2) {
    const found = await countryStations(country.iso2);
    if (found.length > 0) return found;
  }
  return namedCountryStations(country.name).catch(() => []);
}

/**
 * Find the signals at an antipode. The Radio Browser API has no proximity
 * search, so the unit of "near" is the country containing (or nearest to)
 * the point. Inside a country, stations that report coordinates are ranked
 * by real distance to the antipode; unlocated stations trail as fallbacks.
 * For ocean antipodes the nearest few countries are tried in order.
 */
export async function resolveSignals(origin: GeoPoint, antipode: GeoPoint): Promise<TuneResult> {
  const hit = countryAt(antipode);
  const lands = hit
    ? [{ country: hit, km: 0, point: antipode }]
    : nearestLands(antipode, 3);
  const oceanKm = hit ? null : lands[0].km;

  const dist = (s: Station) =>
    s.geoLat === null || s.geoLong === null
      ? Infinity
      : haversineKm(antipode, { lat: s.geoLat, lon: s.geoLong });
  const rank = (a: Station, b: Station) =>
    a.hls - b.hls ||
    Number(b.codec.toUpperCase().includes("MP3")) - Number(a.codec.toUpperCase().includes("MP3")) ||
    b.votes - a.votes;

  let candidates: Station[] = [];
  let lastErr: unknown = null;
  let tried = 0;
  for (const land of lands) {
    tried++;
    let list: Station[];
    try {
      list = await stationsFor(land.country);
    } catch (e) {
      lastErr = e;
      continue;
    }
    const located = list.filter((s) => s.geoLat !== null).sort((a, b) => dist(a) - dist(b));
    const unlocated = list.filter((s) => s.geoLat === null).sort(rank);
    const seen = new Set<string>();
    for (const s of [...located, ...unlocated]) {
      if (!seen.has(s.stationuuid) && candidates.length < 10) {
        seen.add(s.stationuuid);
        candidates.push(s);
      }
    }
    if (candidates.length >= 4) break;
  }

  if (candidates.length === 0 && lastErr !== null && tried === lands.length) {
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
