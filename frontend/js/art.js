/**
 * Placeholder art helpers.
 *
 * Not every Steam app has cover art: tools, soundtracks, betas and delisted
 * titles stay in a library but 404 on every CDN path. These generate a stable
 * stand-in tile from the app's own name and id.
 */

/** Up to two leading characters of a name, for a placeholder tile. */
export function initials(name = "") {
  const words = String(name ?? "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Deterministic hue per app, so a game's tile looks the same every visit. */
export function hueFor(appid) {
  const n = Number(appid);
  if (!Number.isFinite(n)) return 210;
  return (Math.abs(Math.trunc(n)) * 47) % 360;
}
