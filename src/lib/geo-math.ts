export type GeoPoint = {
  lat: number;
  lon: number;
  label?: string;
};

export type Vec3 = [number, number, number];

const RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/** The point on Earth diametrically opposite p. */
export function antipodeOf(p: GeoPoint): GeoPoint {
  return {
    lat: -p.lat,
    lon: p.lon <= 0 ? p.lon + 180 : p.lon - 180,
  };
}

/** Great-circle distance between two surface points, in km. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Surface point to unit vector. x = lon0/lat0, y = east, z = north pole. */
export function latLonToVec3(lat: number, lon: number): Vec3 {
  const la = lat * DEG;
  const lo = lon * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function vec3ToLatLon(v: Vec3): GeoPoint {
  return {
    lat: Math.asin(clamp(v[2], -1, 1)) / DEG,
    lon: Math.atan2(v[1], v[0]) / DEG,
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** Rotate v around unit axis by angle (radians), Rodrigues' formula. */
export function rotateAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const cr = cross(axis, v);
  return [
    v[0] * c + cr[0] * s + axis[0] * k,
    v[1] * c + cr[1] * s + axis[1] * k,
    v[2] * c + cr[2] * s + axis[2] * k,
  ];
}

/** Spherical interpolation between two unit vectors. */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const d = clamp(dot(a, b), -1, 1);
  // Antiparallel vectors have no unique great-circle path — detour through
  // an arbitrary perpendicular so the midpoint can't collapse to zero.
  if (d < -0.9995) {
    const ref: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const perp = norm(cross(a, ref));
    return t < 0.5 ? slerp(a, perp, t * 2) : slerp(perp, b, t * 2 - 1);
  }
  const angle = Math.acos(d);
  if (angle < 1e-6) return b;
  const s = Math.sin(angle);
  return norm(add(scale(a, Math.sin((1 - t) * angle) / s), scale(b, Math.sin(t * angle) / s)));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString("en-US")} km`;
}

export function formatCoord(p: GeoPoint): string {
  const ns = p.lat >= 0 ? "N" : "S";
  const ew = p.lon >= 0 ? "E" : "W";
  return `${Math.abs(p.lat).toFixed(2)}°${ns} ${Math.abs(p.lon).toFixed(2)}°${ew}`;
}
