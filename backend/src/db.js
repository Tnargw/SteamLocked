/**
 * D1-backed task state.
 *
 * State lives on the server rather than in localStorage so a player's progress
 * follows them between devices — and, just as importantly, so completions can
 * be verified against Steam instead of taken on trust from the client.
 *
 * Every write goes through db.batch(), which D1 runs as a single transaction
 * and a single subrequest.
 */

import { ApiError } from "./http.js";

function requireDb(env) {
  if (!env.DB) throw new ApiError(500, "Task storage is not configured on this Worker");
  return env.DB;
}

const taskFromRow = (row) => ({
  key: row.achievement,
  name: row.name,
  description: row.description ?? "",
  icon: row.icon ?? null,
  tier: row.tier ?? "unknown",
  globalPercent: row.global_percent ?? null,
  rolledAt: row.rolled_at ?? null,
  completedAt: row.completed_at ?? null,
});

const emptyGame = () => ({ active: null, completed: [], skipped: 0 });

/** Whole-player state, shaped the way the UI consumes it. */
export async function readState(env, steamid) {
  const db = requireDb(env);

  const [active, completed, skips] = await db.batch([
    db.prepare("SELECT * FROM active_tasks WHERE steamid = ?").bind(steamid),
    db
      .prepare("SELECT * FROM completed_tasks WHERE steamid = ? ORDER BY completed_at DESC")
      .bind(steamid),
    db.prepare("SELECT appid, skipped FROM game_skips WHERE steamid = ?").bind(steamid),
  ]);

  const games = {};
  const game = (appid) => (games[appid] ??= emptyGame());

  for (const row of active.results ?? []) game(row.appid).active = taskFromRow(row);
  for (const row of completed.results ?? []) game(row.appid).completed.push(taskFromRow(row));
  for (const row of skips.results ?? []) game(row.appid).skipped = row.skipped;

  return { games, totals: totalsFor(games) };
}

function totalsFor(games) {
  let completed = 0;
  let skipped = 0;
  let active = 0;
  for (const g of Object.values(games)) {
    completed += g.completed.length;
    skipped += g.skipped;
    if (g.active) active += 1;
  }
  return { completed, skipped, active };
}

/** One game's slice, plus library-wide totals — what a mutation returns. */
export async function readGame(env, steamid, appid) {
  const db = requireDb(env);

  const [active, completed, skips, allActive, allCompleted, allSkips] = await db.batch([
    db.prepare("SELECT * FROM active_tasks WHERE steamid = ? AND appid = ?").bind(steamid, appid),
    db
      .prepare(
        "SELECT * FROM completed_tasks WHERE steamid = ? AND appid = ? ORDER BY completed_at DESC",
      )
      .bind(steamid, appid),
    db.prepare("SELECT skipped FROM game_skips WHERE steamid = ? AND appid = ?").bind(steamid, appid),
    db.prepare("SELECT COUNT(*) AS n FROM active_tasks WHERE steamid = ?").bind(steamid),
    db.prepare("SELECT COUNT(*) AS n FROM completed_tasks WHERE steamid = ?").bind(steamid),
    db.prepare("SELECT COALESCE(SUM(skipped), 0) AS n FROM game_skips WHERE steamid = ?").bind(steamid),
  ]);

  const game = emptyGame();
  const activeRow = (active.results ?? [])[0];
  if (activeRow) game.active = taskFromRow(activeRow);
  game.completed = (completed.results ?? []).map(taskFromRow);
  game.skipped = (skips.results ?? [])[0]?.skipped ?? 0;

  return {
    appid: Number(appid),
    game,
    totals: {
      active: (allActive.results ?? [])[0]?.n ?? 0,
      completed: (allCompleted.results ?? [])[0]?.n ?? 0,
      skipped: (allSkips.results ?? [])[0]?.n ?? 0,
    },
  };
}

export async function getActive(env, steamid, appid) {
  const db = requireDb(env);
  const row = await db
    .prepare("SELECT * FROM active_tasks WHERE steamid = ? AND appid = ?")
    .bind(steamid, appid)
    .first();
  return row ? taskFromRow(row) : null;
}

/**
 * Claim the active slot. Returns false if one is already taken — the insert is
 * conditional, so two devices rolling at once can't both win.
 */
export async function setActive(env, steamid, appid, task) {
  const db = requireDb(env);
  const result = await db
    .prepare(
      `INSERT INTO active_tasks
         (steamid, appid, achievement, name, description, icon, tier, global_percent, rolled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (steamid, appid) DO NOTHING`,
    )
    .bind(
      steamid,
      appid,
      task.key,
      task.name,
      task.description ?? "",
      task.icon ?? null,
      task.tier ?? "unknown",
      task.globalPercent ?? null,
      Date.now(),
    )
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/** Move the active task into the completion log, atomically. */
export async function completeActive(env, steamid, appid, task) {
  const db = requireDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO completed_tasks
           (steamid, appid, achievement, name, icon, tier, global_percent, rolled_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (steamid, appid, achievement) DO NOTHING`,
      )
      .bind(
        steamid,
        appid,
        task.key,
        task.name,
        task.icon ?? null,
        task.tier ?? "unknown",
        task.globalPercent ?? null,
        task.rolledAt ?? null,
        Date.now(),
      ),
    db
      .prepare("DELETE FROM active_tasks WHERE steamid = ? AND appid = ?")
      .bind(steamid, appid),
  ]);
}

/** Drop the active task and charge the player a skip. */
export async function skipActive(env, steamid, appid) {
  const db = requireDb(env);
  await db.batch([
    db.prepare("DELETE FROM active_tasks WHERE steamid = ? AND appid = ?").bind(steamid, appid),
    db
      .prepare(
        `INSERT INTO game_skips (steamid, appid, skipped) VALUES (?, ?, 1)
         ON CONFLICT (steamid, appid) DO UPDATE SET skipped = skipped + 1`,
      )
      .bind(steamid, appid),
  ]);
}
