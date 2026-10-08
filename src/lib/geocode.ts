import { GeoPoint } from "./geo-math";

export type Place = GeoPoint & { name: string; admin: string; country: string };

export async function searchPlaces(query: string): Promise<Place[]> {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}` +
    `&count=6&language=en&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    const data = (await res.json()) as { results?: unknown };
    // Rows from a third-party API aren't trusted shape — keep only ones
    // with a real name and in-range coordinates.
    const rows = Array.isArray(data.results) ? data.results : [];
    return rows.flatMap((r) => {
      const p = r as { name?: unknown; admin1?: unknown; country?: unknown; latitude?: unknown; longitude?: unknown };
      if (typeof p.name !== "string" || !p.name) return [];
      if (typeof p.latitude !== "number" || typeof p.longitude !== "number") return [];
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return [];
      if (Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) return [];
      return [{
        name: p.name,
        admin: typeof p.admin1 === "string" ? p.admin1 : "",
        country: typeof p.country === "string" ? p.country : "",
        lat: p.latitude,
        lon: p.longitude,
      }];
    });
  } finally {
    clearTimeout(timer);
  }
}

export function describePlace(p: Place): string {
  const parts = [p.name, p.admin, p.country].filter(Boolean);
  return parts.filter((v, i) => parts.indexOf(v) === i).join(", ");
}
