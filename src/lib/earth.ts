import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import {
  GeoPoint,
  Vec3,
  latLonToVec3,
  vec3ToLatLon,
  dot,
  cross,
  norm,
  scale,
  add,
} from "./geo-math";
import topoData from "../data/countries-110m.json";
import iso2 from "../data/iso2.json";
import countryNames from "../data/country-names.json";

type Rings = Position[][];

export type Country = {
  id: string; // ISO numeric, zero padded
  name: string;
  iso2: string | null;
  polygons: Rings[]; // each polygon = list of rings
};

export type NearestLand = {
  country: Country;
  km: number; // surface distance from query to nearest point of that country
  point: GeoPoint; // the nearest point on the country's boundary
};

const fc = feature(
  topoData as unknown as Topology,
  (topoData as unknown as Topology).objects.countries as GeometryCollection<MultiPolygon | Polygon>,
) as unknown as FeatureCollection<MultiPolygon | Polygon>;

export const countries: Country[] = fc.features.map((f) => {
  const id = String(f.id ?? "");
  const isoMap = iso2 as Record<string, string>;
  const nameMap = countryNames as Record<string, string>;
  const key = String(Number(id)).padStart(3, "0");
  const polygons: Rings[] =
    f.geometry.type === "Polygon"
      ? [f.geometry.coordinates as Rings]
      : (f.geometry.coordinates as Rings[]);
  return {
    id: key,
    name: nameMap[key] ?? String(f.properties?.name ?? "Unknown"),
    iso2: isoMap[key] ?? null,
    polygons,
  };
});

/** Coastline rings as unit-vector polylines, for the globe renderer. */
export const coastRings: Vec3[][] = countries.flatMap((c) =>
  c.polygons.flatMap((rings) =>
    rings
      .filter((r) => r.length > 2)
      .map((r) => r.map(([lon, lat]) => latLonToVec3(lat, lon))),
  ),
);

// ---- point in polygon ----
// Rings are unwrapped once at load: each vertex's longitude is adjusted by
// ±360 to stay within 180° of the previous vertex. That makes every ring a
// continuous 2D polygon whose lon range may exceed ±180 (e.g. Russia ~-180..190,
// Antarctica ~0..360). A query point is then tested in the ring's own frame:
// the lon representative (lon, lon±360) closest to the ring's centroid.

type PrepRing = {
  x: number[]; // unwrapped lons
  y: number[]; // lats
  lonC: number; // centroid lon (unwrapped)
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
};

type PrepPoly = { outer: PrepRing; holes: PrepRing[] };
type PrepCountry = { country: Country; polys: PrepPoly[] };

function prepRing(ring: Position[]): PrepRing {
  const x: number[] = new Array(ring.length);
  const y: number[] = new Array(ring.length);
  let prev = ring[0][0];
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  let lonSum = 0;
  for (let i = 0; i < ring.length; i++) {
    let lon = ring[i][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    x[i] = lon;
    const lat = ring[i][1];
    y[i] = lat;
    lonSum += lon;
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  return { x, y, lonC: lonSum / ring.length, lonMin, lonMax, latMin, latMax };
}

const prepared: PrepCountry[] = countries.map((country) => ({
  country,
  polys: country.polygons.map((rings) => ({
    outer: prepRing(rings[0]),
    holes: rings.slice(1).map(prepRing),
  })),
}));

function ringContains(r: PrepRing, qlon: number, qlat: number): boolean {
  let inside = false;
  const { x, y } = r;
  for (let i = 0, j = x.length - 1; i < x.length; j = i++) {
    if (y[i] > qlat !== y[j] > qlat && qlon < ((x[j] - x[i]) * (qlat - y[i])) / (y[j] - y[i]) + x[i]) {
      inside = !inside;
    }
  }
  return inside;
}

/** The lon representative (lon + 360k) closest to the ring's frame. */
function rep(lon: number, r: PrepRing): number {
  const k = Math.round((r.lonC - lon) / 360);
  return lon + 360 * k;
}

export function countryAt(p: GeoPoint): Country | null {
  // The 110m coastline is truncated at ~85.6°S; everything south of it is
  // Antarctica in this dataset. (The North Pole really is open ocean.)
  if (p.lat <= -85.7) {
    return countries.find((c) => c.name === "Antarctica") ?? null;
  }
  for (const { country, polys } of prepared) {
    for (const { outer, holes } of polys) {
      if (p.lat < outer.latMin - 0.5 || p.lat > outer.latMax + 0.5) continue;
      const q = rep(p.lon, outer);
      if (q < outer.lonMin - 0.5 || q > outer.lonMax + 0.5) continue;
      if (!ringContains(outer, q, p.lat)) continue;
      const inHole = holes.some((h) => {
        const hq = rep(p.lon, h);
        return hq >= h.lonMin && hq <= h.lonMax && ringContains(h, hq, p.lat);
      });
      if (!inHole) return country;
    }
  }
  return null;
}

// ---- nearest point on a great-circle segment ----

const R_KM = 6371;

/** Distance (km) from p to great-circle arc a-b, and the closest point on it. */
function distToArc(p: Vec3, a: Vec3, b: Vec3): { km: number; at: Vec3 } {
  const n = norm(cross(a, b));
  let t = add(p, scale(n, -dot(p, n)));
  const tl = Math.hypot(t[0], t[1], t[2]);
  let at: Vec3;
  if (tl < 1e-9) {
    at = a;
  } else {
    t = scale(t, 1 / tl);
    const ab = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
    const at1 = Math.acos(Math.min(1, Math.max(-1, dot(a, t))));
    const tb = Math.acos(Math.min(1, Math.max(-1, dot(t, b))));
    at = Math.abs(at1 + tb - ab) < 1e-6 ? t : dot(p, a) > dot(p, b) ? a : b;
  }
  return { km: Math.acos(Math.min(1, Math.max(-1, dot(p, at)))) * R_KM, at };
}

/** The k nearest countries to an ocean point, sorted by distance. */
export function nearestLands(p: GeoPoint, k = 3): NearestLand[] {
  const pv = latLonToVec3(p.lat, p.lon);
  const best = new Map<string, NearestLand>();
  for (const c of countries) {
    for (const rings of c.polygons) {
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = latLonToVec3(ring[i][1], ring[i][0]);
          const b = latLonToVec3(ring[i + 1][1], ring[i + 1][0]);
          const { km, at } = distToArc(pv, a, b);
          const prev = best.get(c.id);
          if (!prev || km < prev.km) {
            best.set(c.id, { country: c, km, point: vec3ToLatLon(at) });
          }
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => a.km - b.km).slice(0, k);
}
