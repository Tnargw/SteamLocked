/**
 * SteamLocked backend API (Cloudflare Worker).
 *
 * The frontend is a static site on GitHub Pages; this Worker handles all
 * dynamic work — fetching and shaping Steam data for that frontend.
 *
 * Routes:
 *   GET /                        service info
 *   GET /health                  liveness
 *   GET /api/steam/profile       ?steamid=            -> GetPlayerSummaries
 *   GET /api/steam/owned-games   ?steamid=            -> GetOwnedGames
 *   GET /api/steam/achievements  ?steamid=&appid=     -> GetPlayerAchievements
 *
 * Requires the STEAM_API_KEY secret:
 *   cd backend && npx wrangler secret put STEAM_API_KEY
 * For local dev put it in backend/.dev.vars (see .dev.vars.example).
 */

// Origins allowed to call this API from browser JavaScript.
const ALLOWED_ORIGINS = new Set([
  "https://tnargw.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

const STEAM_API = "https://api.steampowered.com";
const EDGE_TTL_SECONDS = 300;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  return {};
}

function json(data, init = {}, cors = {}) {
  return Response.json(data, {
    ...init,
    headers: { ...cors, ...(init.headers || {}) },
  });
}

const isSteamId64 = (v) => typeof v === "string" && /^\d{17}$/.test(v);
const isAppId = (v) => typeof v === "string" && /^\d{1,10}$/.test(v);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Call a Steam Web API method and return its parsed JSON body. */
async function steamGet(env, path, params) {
  if (!env.STEAM_API_KEY) {
    throw new ApiError(500, "STEAM_API_KEY is not configured on this Worker");
  }
  const url = new URL(STEAM_API + path);
  url.searchParams.set("key", env.STEAM_API_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { cf: { cacheTtl: EDGE_TTL_SECONDS } });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(502, "Steam rejected the request (bad API key or private data)");
  }
  if (!res.ok) {
    throw new ApiError(502, `Steam API responded ${res.status}`);
  }
  return res.json();
}

async function getProfile(env, url) {
  const steamid = url.searchParams.get("steamid");
  if (!isSteamId64(steamid)) throw new ApiError(400, "steamid must be a 17-digit SteamID64");

  const data = await steamGet(env, "/ISteamUser/GetPlayerSummaries/v2/", { steamids: steamid });
  const player = data?.response?.players?.[0];
  if (!player) throw new ApiError(404, "No Steam profile found for that steamid");

  return {
    steamid: player.steamid,
    name: player.personaname,
    avatar: player.avatarfull,
    profileUrl: player.profileurl,
    // 1 = public, 3 = friends-only/private for game details
    visibility: player.communityvisibilitystate,
  };
}

async function getOwnedGames(env, url) {
  const steamid = url.searchParams.get("steamid");
  if (!isSteamId64(steamid)) throw new ApiError(400, "steamid must be a 17-digit SteamID64");

  const data = await steamGet(env, "/IPlayerService/GetOwnedGames/v1/", {
    steamid,
    include_appinfo: "1",
    include_played_free_games: "1",
  });

  const response = data?.response ?? {};
  // Steam returns an empty object when the profile's game details are private.
  if (response.games === undefined) {
    return { private: true, count: 0, games: [] };
  }

  const games = response.games.map((g) => ({
    appid: g.appid,
    name: g.name,
    playtimeMinutes: g.playtime_forever ?? 0,
    lastPlayed: g.rtime_last_played ?? 0,
    iconUrl: g.img_icon_url
      ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
      : null,
    headerUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
  }));
  games.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);

  return { private: false, count: response.game_count ?? games.length, games };
}

async function getAchievements(env, url) {
  const steamid = url.searchParams.get("steamid");
  const appid = url.searchParams.get("appid");
  if (!isSteamId64(steamid)) throw new ApiError(400, "steamid must be a 17-digit SteamID64");
  if (!isAppId(appid)) throw new ApiError(400, "appid must be a numeric Steam app id");

  let data;
  try {
    data = await steamGet(env, "/ISteamUserStats/GetPlayerAchievements/v1/", {
      steamid,
      appid,
      l: "english",
    });
  } catch (err) {
    // Steam 400s for games with no achievement schema or a private profile.
    if (err instanceof ApiError && err.status === 502) {
      return { appid: Number(appid), available: false, achievements: [] };
    }
    throw err;
  }

  const stats = data?.playerstats ?? {};
  if (!stats.success || !Array.isArray(stats.achievements)) {
    return { appid: Number(appid), available: false, achievements: [] };
  }

  const achievements = stats.achievements.map((a) => ({
    key: a.apiname,
    name: a.name || a.apiname,
    description: a.description || "",
    unlocked: a.achieved === 1,
    unlockedAt: a.unlocktime || 0,
  }));

  return {
    appid: Number(appid),
    game: stats.gameName ?? null,
    available: true,
    unlockedCount: achievements.filter((a) => a.unlocked).length,
    total: achievements.length,
    achievements,
  };
}

const ROUTES = {
  "/api/steam/profile": getProfile,
  "/api/steam/owned-games": getOwnedGames,
  "/api/steam/achievements": getAchievements,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/") return json({ service: "steamlocked-api", ok: true }, {}, cors);
    if (url.pathname === "/health") return json({ ok: true }, {}, cors);

    const handler = ROUTES[url.pathname];
    if (!handler) return json({ error: "Not found" }, { status: 404 }, cors);
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405 }, cors);
    }

    // Serve identical requests from the edge cache for a few minutes.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const body = await handler(env, url);
      const response = json(
        body,
        { headers: { "Cache-Control": `public, max-age=${EDGE_TTL_SECONDS}` } },
        cors,
      );
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || "Internal error" }, { status }, cors);
    }
  },
};
