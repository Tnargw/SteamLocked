/**
 * SteamLocked backend API (Cloudflare Worker).
 *
 * A Taskman-style challenge tracker: sign in through Steam, pick a game, roll a
 * random achievement you haven't earned, and it stays locked in until you
 * actually unlock it — verified against the Steam API, not self-reported.
 *
 *   GET  /health
 *   GET  /api/steam/trending?limit=
 *   GET  /auth/steam/login?return=
 *   GET  /auth/steam/callback
 *   GET  /api/me                              (auth)
 *   GET  /api/me/games                        (auth)
 *   GET  /api/games/:appid/achievements       (auth)
 *   GET  /api/games/:appid/roll?difficulty=&exclude=   (auth)
 *
 * Secrets: STEAM_API_KEY, SESSION_SECRET.
 */

import { ApiError, corsHeaders, isAppId, json } from "./http.js";
import { beginLogin, completeLogin, requireUser } from "./auth.js";
import * as steam from "./steam.js";

const DIFFICULTIES = new Set(["any", "easy", "medium", "hard", "insane"]);

async function roll(env, steamid, appid, url, ctx) {
  const data = await steam.achievements(env, steamid, appid, ctx);
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

  return {
    appid: Number(appid),
    game: data.game,
    task: pool[Math.floor(Math.random() * pool.length)],
    poolSize: pool.length,
    locked: locked.length,
    unlocked: data.unlocked,
    total: data.total,
  };
}

async function route(request, url, env, ctx) {
  const path = url.pathname;

  if (path === "/") return { service: "steamlocked-api", ok: true };
  if (path === "/health") return { ok: true };
  if (path === "/api/steam/trending") return steam.trending(url, ctx);

  if (path === "/api/me") {
    return steam.profile(env, await requireUser(request, env));
  }
  if (path === "/api/me/games") {
    return steam.ownedGames(env, await requireUser(request, env));
  }

  const match = path.match(/^\/api\/games\/(\d{1,10})\/(achievements|roll)$/);
  if (match) {
    const [, appid, action] = match;
    if (!isAppId(appid)) throw new ApiError(400, "Invalid app id");
    const steamid = await requireUser(request, env);
    return action === "achievements"
      ? steam.achievements(env, steamid, appid, ctx)
      : roll(env, steamid, appid, url, ctx);
  }

  throw new ApiError(404, "Not found");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Auth endpoints are browser redirects, not fetch() calls — they return
    // 302s rather than JSON, so they sit outside the normal route table.
    try {
      if (url.pathname === "/auth/steam/login") {
        return beginLogin(request, url, url.origin);
      }
      if (url.pathname === "/auth/steam/callback") {
        return await completeLogin(request, url, env);
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || "Internal error" }, { status }, cors);
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405 }, cors);
    }

    try {
      const body = await route(request, url, env, ctx);
      return json(body, {}, cors);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || "Internal error" }, { status }, cors);
    }
  },
};
