/**
 * Per-player task state, kept in localStorage.
 *
 * Taskman rules: one active task per game. It stays locked in until Steam says
 * the achievement is unlocked, or until the player deliberately skips it —
 * skips are counted, so they cost something.
 */

const KEY = "steamlocked.state.v1";

const emptyState = () => ({ version: 1, steamid: null, games: {} });
const emptyGame = () => ({ active: null, completed: [], skipped: 0 });

let state = emptyState();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — state stays in memory for this session only */
  }
}

/** Load state for a player, resetting if a different account signs in. */
export function load(steamid) {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    state = parsed?.version === 1 ? parsed : emptyState();
  } catch {
    state = emptyState();
  }
  if (state.steamid !== steamid) {
    state = { ...emptyState(), steamid };
    persist();
  }
  return state;
}

export function reset() {
  state = emptyState();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

const gameState = (appid) => (state.games[appid] ??= emptyGame());

export const getGame = (appid) => ({ ...emptyGame(), ...state.games[appid] });

export function setActive(appid, task) {
  gameState(appid).active = { ...task, rolledAt: Date.now() };
  persist();
}

export function completeActive(appid) {
  const game = gameState(appid);
  if (!game.active) return null;
  const done = { ...game.active, completedAt: Date.now() };
  game.completed.unshift(done);
  game.active = null;
  persist();
  return done;
}

export function skipActive(appid) {
  const game = gameState(appid);
  const skipped = game.active;
  game.active = null;
  game.skipped += 1;
  persist();
  return skipped;
}

/** Totals across every game, for the dashboard strip. */
export function totals() {
  let completed = 0;
  let skipped = 0;
  let active = 0;
  for (const game of Object.values(state.games)) {
    completed += game.completed?.length ?? 0;
    skipped += game.skipped ?? 0;
    if (game.active) active += 1;
  }
  return { completed, skipped, active };
}

export const activeAppIds = () =>
  Object.entries(state.games)
    .filter(([, g]) => g.active)
    .map(([appid]) => Number(appid));
