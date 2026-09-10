/** Steam Web API + store client, with edge caching for the slow/stable bits. */

import { ApiError } from "./http.js";

const STEAM_API = "https://api.steampowered.com";
const STEAM_STORE = "https://store.steampowered.com";
const CDN = "https://cdn.cloudflare.steamstatic.com";
const STORE_ASSETS = "https://shared.akamai.steamstatic.com/store_item_assets/";
// IStoreBrowseService accepts 200 ids per call; 400 is rejected outright.
const ART_CHUNK = 100;

const TTL = {
  trending: 900, // 15 min — chart rollups move slowly
  appDetails: 86400, // 24 h — store metadata is near-static
  schema: 86400, // 24 h — achievement lists change only on patches
  globalPercents: 21600, // 6 h — rarity drifts slowly
  art: 86400, // 24 h — asset hashes change only when a store page is redressed
};

/** Difficulty tiers derived from how many owners have unlocked an achievement. */
export function tierFor(percent) {
  if (percent === null || percent === undefined) return "unknown";
  if (percent >= 50) return "easy";
  if (percent >= 20) return "medium";
  if (percent >= 5) return "hard";
  return "insane";
}

/**
 * Legacy CDN path. Correct for most of the catalogue, but wrong for some
 * newer titles — see resolveArt. Kept as the last-resort fallback.
 */
export const headerUrl = (appid) => `${CDN}/steam/apps/${appid}/header.jpg`;
export const storeUrl = (appid) => `${STEAM_STORE}/app/${appid}/`;

/** Read-through edge cache for responses that are expensive but stable. */
async function cached(ctx, key, ttl, produce) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.steamlocked/${key}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const value = await produce();
  const store = Response.json(value, {
    headers: { "Cache-Control": `public, max-age=${ttl}` },
  });
  ctx.waitUntil(cache.put(cacheKey, store.clone()));
  return value;
}

const cacheKeyFor = (key) => new Request(`https://cache.steamlocked/${key}`);

/** undefined = not cached. A cached null is a real "this app has no art". */
async function cacheGet(key) {
  const hit = await caches.default.match(cacheKeyFor(key));
  return hit ? hit.json() : undefined;
}

function cacheSet(ctx, key, value, ttl) {
  const stored = Response.json(value, {
    headers: { "Cache-Control": `public, max-age=${ttl}` },
  });
  ctx.waitUntil(caches.default.put(cacheKeyFor(key), stored));
}

const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

/** Build the hashed asset URL from a GetItems entry, if it has one. */
function assetHeaderUrl(item) {
  const assets = item?.assets;
  if (!assets?.asset_url_format || !assets?.header) return null;
  return STORE_ASSETS + assets.asset_url_format.replace("${FILENAME}", assets.header);
}

/**
 * Real header art for a batch of apps.
 *
 * The legacy CDN path is unreliable for newer titles: some 404, and some —
 * Battlefield 6 among them — serve a blank 1.4 KB placeholder that loads
 * successfully, so a browser never fires an error event and the card just looks
 * empty. Only the hashed path from Steam's own asset manifest is trustworthy.
 * IStoreBrowseService returns it, keyless, for many apps at once, so enriching
 * a whole library costs a handful of requests rather than one per game.
 *
 * Returns { [appid]: url | null }; null means Steam has no store art at all.
 */
export async function resolveArt(appids, ctx) {
  const unique = [...new Set(appids.map(String))];
  const resolved = {};
  const misses = [];

  await Promise.all(
    unique.map(async (id) => {
      const hit = await cacheGet(`art/${id}`);
      if (hit === undefined) misses.push(id);
      else resolved[id] = hit;
    }),
  );

  await Promise.all(
    chunk(misses, ART_CHUNK).map(async (ids) => {
      const payload = {
        ids: ids.map((appid) => ({ appid: Number(appid) })),
        context: { language: "english", country_code: "US" },
        data_request: { include_assets: true },
      };
      const url =
        `${STEAM_API}/IStoreBrowseService/GetItems/v1/` +
        `?input_json=${encodeURIComponent(JSON.stringify(payload))}`;

      let items;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GetItems responded ${res.status}`);
        items = (await res.json())?.response?.store_items ?? [];
      } catch {
        // Leave these unresolved — callers fall back to the legacy URL rather
        // than losing the whole library over an art lookup.
        return;
      }

      const seen = new Set();
      for (const item of items) {
        const id = String(item?.id ?? item?.appid ?? "");
        if (!id) continue;
        seen.add(id);
        const art = assetHeaderUrl(item);
        resolved[id] = art;
        cacheSet(ctx, `art/${id}`, art, TTL.art);
      }
      // Apps Steam didn't answer for have no store entry; remember that too.
      for (const id of ids) {
        if (seen.has(id)) continue;
        resolved[id] = null;
        cacheSet(ctx, `art/${id}`, null, TTL.art);
      }
    }),
  );

  return resolved;
}

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(502, `Steam ${label} responded ${res.status}`);
  return res.json();
}

/** Call a keyed Steam Web API method. */
async function steamGet(env, path, params) {
  if (!env.STEAM_API_KEY) {
    throw new ApiError(500, "STEAM_API_KEY is not configured on this Worker");
  }
  const url = new URL(STEAM_API + path);
  url.searchParams.set("key", env.STEAM_API_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(502, "Steam rejected the request (bad API key, or the data is private)");
  }
  if (!res.ok) throw new ApiError(502, `Steam API responded ${res.status}`);
  return res.json();
}

// --- Public / keyless ---------------------------------------------------------

export async function appDetails(appid, ctx) {
  return cached(ctx, `appdetails/${appid}`, TTL.appDetails, async () => {
    const fallback = {
      appid: Number(appid),
      name: `App ${appid}`,
      shortDescription: "",
      isFree: false,
      price: null,
      releaseDate: null,
    };
    try {
      const res = await fetch(
        `${STEAM_STORE}/api/appdetails?appids=${appid}&filters=basic,price_overview,release_date`,
      );
      if (!res.ok) return fallback;
      const d = (await res.json())?.[appid]?.data;
      if (!d) return fallback;
      return {
        appid: Number(appid),
        name: d.name ?? fallback.name,
        shortDescription: d.short_description ?? "",
        isFree: Boolean(d.is_free),
        price: d.price_overview
          ? {
              final: d.price_overview.final_formatted,
              discountPercent: d.price_overview.discount_percent ?? 0,
            }
          : null,
        releaseDate: d.release_date?.date ?? null,
      };
    } catch {
      // A missing store entry shouldn't sink the whole list.
      return fallback;
    }
  });
}

export async function trending(url, ctx) {
  const raw = parseInt(url.searchParams.get("limit") ?? "12", 10);
  const limit = Math.min(Math.max(Number.isNaN(raw) ? 12 : raw, 1), 30);

  return cached(ctx, `trending/${limit}`, TTL.trending, async () => {
    const data = await fetchJson(
      `${STEAM_API}/ISteamChartsService/GetMostPlayedGames/v1/`,
      "most-played",
    );
    const ranks = (data?.response?.ranks ?? []).slice(0, limit);

    const art = await resolveArt(
      ranks.map((r) => r.appid),
      ctx,
    );

    const games = await Promise.all(
      ranks.map(async (r) => {
        const d = await appDetails(String(r.appid), ctx);
        return {
          rank: r.rank,
          appid: r.appid,
          lastWeekRank: r.last_week_rank ?? null,
          peakInGame: r.peak_in_game ?? null,
          name: d.name,
          shortDescription: d.shortDescription,
          isFree: d.isFree,
          price: d.price,
          releaseDate: d.releaseDate,
          headerUrl: art[String(r.appid)] ?? headerUrl(r.appid),
          storeUrl: storeUrl(r.appid),
        };
      }),
    );

    return { rollupDate: data?.response?.rollup_date ?? null, count: games.length, games };
  });
}

async function globalPercents(appid, ctx) {
  return cached(ctx, `globalpct/${appid}`, TTL.globalPercents, async () => {
    try {
      const data = await fetchJson(
        `${STEAM_API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`,
        "global percentages",
      );
      const out = {};
      for (const a of data?.achievementpercentages?.achievements ?? []) {
        out[a.name] = Number(a.percent);
      }
      return out;
    } catch {
      return {};
    }
  });
}

// --- Keyed --------------------------------------------------------------------

export async function profile(env, steamid) {
  const data = await steamGet(env, "/ISteamUser/GetPlayerSummaries/v2/", { steamids: steamid });
  const player = data?.response?.players?.[0];
  if (!player) throw new ApiError(404, "No Steam profile found for that ID");
  return {
    steamid: player.steamid,
    name: player.personaname,
    avatar: player.avatarfull,
    profileUrl: player.profileurl,
    visibility: player.communityvisibilitystate,
  };
}

export async function ownedGames(env, steamid, ctx) {
  const data = await steamGet(env, "/IPlayerService/GetOwnedGames/v1/", {
    steamid,
    include_appinfo: "1",
    include_played_free_games: "1",
  });

  const response = data?.response ?? {};
  // Steam returns an empty object when "Game details" privacy is not public.
  if (response.games === undefined) return { private: true, count: 0, games: [] };

  const art = await resolveArt(
    response.games.map((g) => g.appid),
    ctx,
  );

  const games = response.games.map((g) => ({
    appid: g.appid,
    name: g.name,
    playtimeMinutes: g.playtime_forever ?? 0,
    lastPlayed: g.rtime_last_played ?? 0,
    // null means Steam has no art; the UI draws a generated tile instead.
    headerUrl: art[String(g.appid)] ?? headerUrl(g.appid),
    hasCommunityStats: Boolean(g.has_community_visible_stats),
  }));
  games.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes || a.name.localeCompare(b.name));

  return { private: false, count: response.game_count ?? games.length, games };
}

async function schema(env, appid, ctx) {
  return cached(ctx, `schema/${appid}`, TTL.schema, async () => {
    try {
      const data = await steamGet(env, "/ISteamUserStats/GetSchemaForGame/v2/", {
        appid,
        l: "english",
      });
      const out = {};
      for (const a of data?.game?.availableGameStats?.achievements ?? []) {
        out[a.name] = {
          displayName: a.displayName || a.name,
          description: a.description || "",
          icon: a.icon || null,
          iconGray: a.icongray || null,
          hidden: a.hidden === 1,
        };
      }
      return out;
    } catch {
      return {};
    }
  });
}

/**
 * Every achievement for a game, merged from three sources: the player's
 * unlock state, the game's schema (names/icons), and global rarity.
 */
export async function achievements(env, steamid, appid, ctx) {
  let playerStats;
  try {
    const data = await steamGet(env, "/ISteamUserStats/GetPlayerAchievements/v1/", {
      steamid,
      appid,
      l: "english",
    });
    playerStats = data?.playerstats ?? {};
  } catch {
    // Steam 400s for titles with no achievement schema at all.
    playerStats = { success: false };
  }

  if (!playerStats.success || !Array.isArray(playerStats.achievements)) {
    return {
      appid: Number(appid),
      available: false,
      reason: "This game has no achievements, or its stats aren't public.",
      unlocked: 0,
      total: 0,
      achievements: [],
    };
  }

  const [meta, percents] = await Promise.all([
    schema(env, appid, ctx),
    globalPercents(appid, ctx),
  ]);

  const list = playerStats.achievements.map((a) => {
    const m = meta[a.apiname] ?? {};
    const percent = percents[a.apiname] ?? null;
    return {
      key: a.apiname,
      name: m.displayName || a.name || a.apiname,
      description: m.description || a.description || "",
      icon: m.icon ?? null,
      iconGray: m.iconGray ?? null,
      hidden: Boolean(m.hidden),
      unlocked: a.achieved === 1,
      unlockedAt: a.unlocktime || 0,
      globalPercent: percent,
      tier: tierFor(percent),
    };
  });

  return {
    appid: Number(appid),
    game: playerStats.gameName ?? null,
    available: true,
    unlocked: list.filter((a) => a.unlocked).length,
    total: list.length,
    achievements: list,
  };
}
