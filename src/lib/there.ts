// "There" — what it's like at the antipode right now. Keyless Open-Meteo
// forecast: local time, temperature, weather, daylight.

import { GeoPoint } from "./geo-math";

export type There = {
  tz: string; // IANA zone at the antipode — the clock keeps moving
  tempC: number;
  phrase: string;
  isDay: boolean;
};

/** Current local time at the antipode, "05:45". */
export function thereTime(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(new Date());
  } catch {
    return "";
  }
}

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
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as {
      timezone?: string;
      current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number };
    };
    const cur = data.current;
    if (!cur || typeof data.timezone !== "string") return null;
    return {
      tz: data.timezone,
      tempC: Math.round(cur.temperature_2m ?? 0),
      phrase: WMO[cur.weather_code ?? -1] ?? "weather unknown",
      isDay: cur.is_day === 1,
    };
  } catch {
    return null;
  }
}
