/**
 * SteamLocked backend API (Cloudflare Worker).
 *
 * A Taskman-style challenge tracker: sign in through Steam, pick a game, roll a
 * random achievement you haven't earned, and it stays locked in until you
 * actually unlock it — verified against the Steam API, not self-reported.
 *
 * Task state lives in D1, keyed by SteamID, so progress follows a player
 * between devices. The server owns the rules: a client can ask to complete a
 * task, but only Steam can say whether it actually happened.
 *
 *   GET  /health
 *   GET  /api/steam/trending?limit=
 *   GET  /auth/steam/login?return=
 *   GET  /auth/steam/callback
 *   GET  /api/me                                     (auth)
 *   GET  /api/me/games                               (auth)
 *   GET  /api/me/state                               (auth)
 *   GET  /api/games/:appid/achievements              (auth)
 *   POST /api/games/:appid/roll?difficulty=&exclude= (auth)
 *   POST /api/games/:appid/complete                  (auth)
 *   POST /api/games/:appid/skip                      (auth)
 *
 * Secrets: STEAM_API_KEY, SESSION_SECRET. Bindings: DB (D1).
 */

import { ApiError, corsHeaders, json } from "./http.js";
import { beginLogin, completeLogin, requireUser } from "./auth.js";
import * as steam from "./steam.js";
import * as db from "./db.js";

const DIFFICULTIES = new Set(["any", "easy", "medium", "hard", "insane"]);
const ALREADY_ACTIVE = "You already have an active task for this game.";

/** Pick a random locked achievement and claim the game's active slot. */
async function roll(env, steamid, appid, url) {
  if (await db.getActive(env, steamid, appid)) throw new ApiError(409, ALREADY_ACTIVE);

  const data = await steam.achievements(env, steamid, appid);
  if (!data.available) throw new ApiError(409, data.reason);

  const locked = data.achievements.filter((a) => !a.unlocked);
  if (locked.length === 0) {
    throw new ApiError(409, "Every achievement is already unlocked — nothing left to roll.");
  }

  const difficulty = url.searchParams.get("difficulty") ?? "any";
  if (!DIFFICULTIES.has(difficulty)) throw new ApiError(400, "Unknown difficulty");

  const exclude = url.searchParams.get("exclude");
  let pool = difficulty === "any" ? locked : locked.filter((a) => a.tier === difficulty);
  // Don't hand back the task the player just skipped, unless it's the only one.
  if (exclude && pool.length > 1) pool = pool.filter((a) => a.key !== exclude);

  if (pool.length === 0) {
    throw new ApiError(
      409,
      `No ${difficulty} achievements left in this game. Try a different difficulty.`,
    );
  }

  const task = pool[Math.floor(Math.random() * pool.length)];
  // Conditional insert: if another device claimed the slot in the meantime,
  // this loses rather than overwriting their task.
  if (!(await db.setActive(env, steamid, appid, task))) {
    throw new ApiError(409, ALREADY_ACTIVE);
  }

  return {
    ...(await db.readGame(env, steamid, appid)),
    task,
    locked: locked.length,
    unlocked: data.unlocked,
    total: data.total,
  };
}

/** Ask Steam whether the active task is genuinely done, and bank it if so. */
async function complete(env, steamid, appid) {
  const active = await db.getActive(env, steamid, appid);
  if (!active) throw new ApiError(409, "There's no active task for this game.");

  const data = await steam.achievements(env, steamid, appid);
  const current = data.achievements.find((a) => a.key === active.key);

  if (!current?.unlocked) {
    return { completed: false, ...(await db.readGame(env, steamid, appid)) };
  }

  await db.completeActive(env, steamid, appid, active);
  return { completed: true, task: active, ...(await db.readGame(env, steamid, appid)) };
}

async function skip(env, steamid, appid) {
  const active = await db.getActive(env, steamid, appid);
  if (!active) throw new ApiError(409, "There's no active task to skip.");
  await db.skipActive(env, steamid, appid);
  return { skipped: active, ...(await db.readGame(env, steamid, appid)) };
}

const GAME_ROUTE = /^\/api\/games\/(\d{1,10})\/(achievements|roll|complete|skip)$/;

async function route(request, url, env, ctx) {
  const { pathname } = url;
  const method = request.method;
  const GET = method === "GET";
  const POST = method === "POST";

  if (pathname === "/" && GET) return { service: "steamlocked-api", ok: true };
  if (pathname === "/health" && GET) return { ok: true };
  if (pathname === "/api/steam/trending" && GET) return steam.trending(url, ctx);

  if (pathname === "/api/me" && GET) {
    return steam.profile(env, await requireUser(request, env));
  }
  if (pathname === "/api/me/games" && GET) {
    return steam.ownedGames(env, await requireUser(request, env));
  }
  if (pathname === "/api/me/state" && GET) {
    return db.readState(env, await requireUser(request, env));
  }

  const match = pathname.match(GAME_ROUTE);
  if (match) {
    const [, appid, action] = match;
    const steamid = await requireUser(request, env);

    if (action === "achievements" && GET) return steam.achievements(env, steamid, appid);
    if (action === "roll" && POST) return roll(env, steamid, appid, url);
    if (action === "complete" && POST) return complete(env, steamid, appid);
    if (action === "skip" && POST) return skip(env, steamid, appid);

    throw new ApiError(405, "Method not allowed");
  }

  // A known path reached with the wrong verb is a 405, not a 404.
  const knownPaths = ["/", "/health", "/api/steam/trending", "/api/me", "/api/me/games", "/api/me/state"];
  if (knownPaths.includes(pathname)) throw new ApiError(405, "Method not allowed");

  throw new ApiError(404, "Not found");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // Auth endpoints are browser redirects, not fetch() calls — they return
      // 302s rather than JSON, so they sit outside the normal route table.
      if (url.pathname === "/auth/steam/login") return beginLogin(request, url, url.origin);
      if (url.pathname === "/auth/steam/callback") return await completeLogin(request, url, env);

      return json(await route(request, url, env, ctx), {}, cors);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || "Internal error" }, { status }, cors);
    }
  },
};
