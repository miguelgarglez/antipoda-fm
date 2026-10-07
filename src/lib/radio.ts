import { GeoPoint, haversineKm } from "./geo-math";
import { countryAt, nearestLand, Country } from "./earth";

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
  land: { country: Country; oceanKm: number | null; nearPoint: GeoPoint | null };
  /** km from the antipode to the best candidate, if it reports coordinates. */
  signalKm: number | null;
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
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
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
    geoLat: typeof s.geo_lat === "number" ? s.geo_lat : null,
    geoLong: typeof s.geo_long === "number" ? s.geo_long : null,
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
    `/json/stations/bycountrycodeexact/${encodeURIComponent(iso2)}?order=votes&reverse=true&limit=15&hidebroken=true`,
  );
  return clean(raw);
}

/** Stations reporting coordinates near a point, haversine-sorted. */
async function geoStations(p: GeoPoint): Promise<Station[]> {
  const raw = await rbGet<Raw[]>(
    `/json/stations/search?geo_lat=${p.lat.toFixed(4)}&geo_long=${p.lon.toFixed(4)}` +
      `&order=votes&reverse=true&limit=200&lastcheckok=1&hidebroken=true`,
  );
  return clean(raw)
    .filter((s) => s.geoLat !== null && s.geoLong !== null)
    .sort(
      (a, b) =>
        haversineKm(p, { lat: a.geoLat!, lon: a.geoLong! }) -
        haversineKm(p, { lat: b.geoLat!, lon: b.geoLong! }),
    );
}

/**
 * Find the signals closest to an antipode.
 * Land antipode: that country's best stations, plus any geo-tagged station
 * sitting closer to the point than the country's reach suggests.
 * Ocean antipode: the nearest country's stations, labelled by distance.
 */
export async function resolveSignals(origin: GeoPoint, antipode: GeoPoint): Promise<TuneResult> {
  const hit = countryAt(antipode);
  const near = hit ? null : nearestLand(antipode);
  const country = hit ?? near!.country;
  const oceanKm = hit ? null : near!.km;
  const nearPoint = hit ? null : near!.point;

  const jobs: Promise<Station[]>[] = [
    country.iso2 ? countryStations(country.iso2).catch(() => []): Promise.resolve([]),
    geoStations(antipode).catch(() => []),
  ];
  const [byCountry, byGeo] = await Promise.all(jobs);

  const dist = (s: Station) =>
    s.geoLat === null ? Infinity : haversineKm(antipode, { lat: s.geoLat, lon: s.geoLong! });
  const rank = (a: Station, b: Station) =>
    a.hls - b.hls ||
    Number(b.codec.toUpperCase().includes("MP3")) - Number(a.codec.toUpperCase().includes("MP3")) ||
    b.votes - a.votes;

  // Three tiers, in order: stations geo-placed near the point, the country's
  // best stations, then the nearest geo-tagged stations anywhere as backup.
  const NEAR_KM = 600;
  const geoNear = byGeo.filter((s) => dist(s) <= NEAR_KM).sort(rank);
  const seen = new Set<string>();
  const tiers = [geoNear, byCountry.sort(rank), byGeo.sort((a, b) => dist(a) - dist(b))];
  const candidates: Station[] = [];
  for (const tier of tiers) {
    for (const s of tier) {
      if (!seen.has(s.stationuuid) && candidates.length < 10) {
        seen.add(s.stationuuid);
        candidates.push(s);
      }
    }
    if (candidates.length >= 10) break;
  }

  const first = candidates[0];
  const signalKm = first && first.geoLat !== null ? Math.round(dist(first)) : null;

  return {
    origin,
    antipode,
    candidates,
    land: { country, oceanKm, nearPoint },
    signalKm,
  };
}

export function stationDistanceKm(s: Station, from: GeoPoint): number | null {
  if (s.geoLat === null || s.geoLong === null) return null;
  return haversineKm(from, { lat: s.geoLat, lon: s.geoLong });
}
