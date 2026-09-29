/**
 * Task state, owned by the server.
 *
 * This used to be localStorage, which meant progress was stranded on whichever
 * device made it. The server is now the single source of truth — this module
 * just holds the last known copy so the UI can render synchronously, and
 * refreshes it from whatever each mutation returns.
 *
 * Taskman rules are enforced server-side: one active task per game, and a task
 * is only ever banked when Steam itself reports the achievement unlocked.
 */

import * as api from "./api.js";

const emptyGame = () => ({ active: null, completed: [], skipped: 0 });
const emptyState = () => ({ games: {}, totals: { completed: 0, skipped: 0, active: 0 } });

let state = emptyState();

/** Pull the player's state down. Call once after sign-in. */
export async function load() {
  state = await api.getState();
  return state;
}

export function reset() {
  state = emptyState();
}

export const getGame = (appid) => ({ ...emptyGame(), ...state.games[appid] });

export const totals = () => state.totals;

export const activeAppIds = () =>
  Object.entries(state.games)
    .filter(([, g]) => g.active)
    .map(([appid]) => Number(appid));

/** Fold a mutation's response back into the local copy. */
function apply(result) {
  if (result?.appid !== undefined && result.game) state.games[result.appid] = result.game;
  if (result?.totals) state.totals = result.totals;
  return result;
}

export const roll = async (appid, options) => apply(await api.rollTask(appid, options));

/**
 * Ask the server to verify against Steam. Resolves with `completed: false`
 * when the achievement is still locked — that is an answer, not an error.
 */
export const complete = async (appid) => apply(await api.completeTask(appid));

export const skip = async (appid) => apply(await api.skipTask(appid));
