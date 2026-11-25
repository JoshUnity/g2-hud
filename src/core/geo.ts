export type LatLon = { lat: number; lon: number };

export function metresBetween(a: LatLon, b: LatLon): number {
  const x = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const y = (b.lat - a.lat) * 110_540;
  return Math.hypot(x, y);
}

/** Bearing in degrees true from a to b. */
export function bearing(a: LatLon, b: LatLon): number {
  const x = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const y = b.lat - a.lat;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Local flat projection: [lat, lon] to pixels, with `origin` at pixel (ox, oy). */
export function projector(origin: LatLon, metresPerPx: number, ox: number, oy: number) {
  const kx = (111_320 * Math.cos((origin.lat * Math.PI) / 180)) / metresPerPx;
  const ky = 110_540 / metresPerPx;
  return ([lat, lon]: [number, number]): [number, number] => [ox + (lon - origin.lon) * kx, oy - (lat - origin.lat) * ky];
}

export function distanceLabel(m: number): string {
  // Round first, so 995 to 999 m reads "1.0 km" and not "1000 m".
  const r = Math.round(m / 10) * 10;
  return r < 1000 ? `${r} m` : `${(m / 1000).toFixed(1)} km`;
}
