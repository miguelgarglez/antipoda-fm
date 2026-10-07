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

// ---- point in polygon (equirectangular, shifted so query lon sits at 0) ----

function ringContains(ring: Position[], lat: number, lonShifted: (l: number) => number, qlon = 0): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = lonShifted(ring[i][0]);
    const yi = ring[i][1];
    const xj = lonShifted(ring[j][0]);
    const yj = ring[j][1];
    const crosses = yi > lat !== yj > lat;
    if (crosses && qlon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function shift(lon: number, center: number): number {
  let l = ((((lon - center) % 360) + 540) % 360) - 180;
  return l;
}

export function countryAt(p: GeoPoint): Country | null {
  const shiftTo = (l: number) => shift(l, p.lon);
  for (const c of countries) {
    for (const rings of c.polygons) {
      const outer = rings[0];
      if (ringContains(outer, p.lat, shiftTo)) {
        const hole = rings.slice(1).some((r) => ringContains(r, p.lat, shiftTo));
        if (!hole) return c;
      }
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

/** Nearest country boundary to an ocean point. */
export function nearestLand(p: GeoPoint): NearestLand {
  const pv = latLonToVec3(p.lat, p.lon);
  let best: NearestLand | null = null;
  for (const c of countries) {
    for (const rings of c.polygons) {
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = latLonToVec3(ring[i][1], ring[i][0]);
          const b = latLonToVec3(ring[i + 1][1], ring[i + 1][0]);
          const { km, at } = distToArc(pv, a, b);
          if (!best || km < best.km) {
            best = { country: c, km, point: vec3ToLatLon(at) };
          }
        }
      }
    }
  }
  return best!;
}
