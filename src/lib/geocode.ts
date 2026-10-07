import { GeoPoint } from "./geo-math";

export type Place = GeoPoint & { name: string; admin: string; country: string };

export async function searchPlaces(query: string): Promise<Place[]> {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}` +
    `&count=6&language=en&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const res = await fetch(url, { signal: ctrl.signal });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const data = (await res.json()) as {
    results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[];
  };
  return (data.results ?? []).map((r) => ({
    name: r.name,
    admin: r.admin1 ?? "",
    country: r.country ?? "",
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export function describePlace(p: Place): string {
  const parts = [p.name, p.admin, p.country].filter(Boolean);
  return parts.filter((v, i) => parts.indexOf(v) === i).join(", ");
}
