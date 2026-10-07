// "There" — what it's like at the antipode right now. Keyless Open-Meteo
// forecast: local time, temperature, weather, daylight.

import { GeoPoint } from "./geo-math";

export type There = {
  time: string; // "12:15" local
  tempC: number;
  phrase: string;
  isDay: boolean;
};

const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "icy fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "heavy showers",
  85: "snow showers",
  86: "snow showers",
  95: "thunderstorm",
  96: "thunderstorm, hail",
  99: "thunderstorm, hail",
};

export async function fetchThere(p: GeoPoint): Promise<There | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(3)}` +
      `&longitude=${p.lon.toFixed(3)}&current=temperature_2m,weather_code,is_day&timezone=auto`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number };
    };
    const cur = data.current;
    if (!cur || typeof cur.time !== "string") return null;
    return {
      time: cur.time.slice(11, 16),
      tempC: Math.round(cur.temperature_2m ?? 0),
      phrase: WMO[cur.weather_code ?? -1] ?? "weather unknown",
      isDay: cur.is_day === 1,
    };
  } catch {
    return null;
  }
}
