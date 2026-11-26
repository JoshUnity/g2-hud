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
