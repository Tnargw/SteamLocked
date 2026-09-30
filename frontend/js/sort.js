/**
 * Library sorting.
 *
 * Pure functions, so the ordering rules can be tested without a browser. Every
 * comparison falls back to the name, which keeps the order stable: without a
 * tiebreak, the hundreds of never-played games in a big library would shuffle
 * between renders.
 */

const KEY = "steamlocked.sort.v1";

/**
 * Each sort declares the direction it should *start* in, because the obvious
 * default differs: most-played first, but names A–Z.
 */
export const SORTS = {
  playtime: { label: "Hours played", natural: "desc", value: (g) => g.playtimeMinutes ?? 0 },
  name: { label: "Name", natural: "asc", value: (g) => g.name ?? "" },
  recent: { label: "Recently played", natural: "desc", value: (g) => g.lastPlayed ?? 0 },
};

export const DEFAULT_SORT = "playtime";

export const isSortKey = (key) => Object.hasOwn(SORTS, key);

export const naturalDirection = (key) => SORTS[key]?.natural ?? "desc";

const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));

/** A new copy, ordered. Never mutates the caller's array. */
export function sortGames(games, key = DEFAULT_SORT, direction = naturalDirection(key)) {
  const sort = SORTS[key] ?? SORTS[DEFAULT_SORT];
  const flip = direction === "asc" ? 1 : -1;

  return [...games].sort((a, b) => {
    const left = sort.value(a);
    const right = sort.value(b);

    let cmp;
    if (typeof left === "string" || typeof right === "string") {
      cmp = String(left).localeCompare(String(right));
    } else {
      cmp = left - right;
    }

    // Equal on the chosen field: fall back to the name, always ascending, so
    // the tiebreak reads the same whichever direction the sort runs in.
    return cmp === 0 ? byName(a, b) : cmp * flip;
  });
}

/** Remembered per device — a display preference, not shared account state. */
export function loadPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (isSortKey(saved?.key)) {
      return {
        key: saved.key,
        direction: saved.direction === "asc" ? "asc" : "desc",
      };
    }
  } catch {
    // Unreadable or corrupt — fall through to the default.
  }
  return { key: DEFAULT_SORT, direction: naturalDirection(DEFAULT_SORT) };
}

export function savePreference({ key, direction }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ key, direction }));
  } catch {
    // Private mode: the choice just won't outlive the session.
  }
}
