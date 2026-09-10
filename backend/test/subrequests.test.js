import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { mintToken } from "../src/auth.js";

/**
 * Cloudflare aborts an invocation that exceeds its subrequest budget — 50 on
 * the Free plan. Every outbound fetch and every Cache API operation counts, so
 * these guard the per-request budget for realistic library sizes.
 */
const FREE_PLAN_LIMIT = 50;
const STEAMID = "76561198099579975";

let token;
beforeAll(async () => {
  token = await mintToken(env, STEAMID);
});
afterEach(() => vi.restoreAllMocks());

/** Count outbound fetches AND Cache API calls, the way Cloudflare does. */
function meter(routes) {
  const counts = { fetch: 0, cacheMatch: 0, cachePut: 0 };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    counts.fetch += 1;
    const url = input instanceof Request ? input.url : String(input);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return respond(url);
    }
    throw new Error(`Unmocked outbound fetch: ${url}`);
  });

  const cache = caches.default;
  vi.spyOn(cache, "match").mockImplementation(async () => {
    counts.cacheMatch += 1;
    return undefined; // always a miss: the worst case for the budget
  });
  vi.spyOn(cache, "put").mockImplementation(async () => {
    counts.cachePut += 1;
  });

  return counts;
}

const total = (c) => c.fetch + c.cacheMatch + c.cachePut;

async function call(path, headers) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://steamlocked.test${path}`, { headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const json = (body) => () => Response.json(body);

const library = (n) => ({
  response: {
    game_count: n,
    games: Array.from({ length: n }, (_, i) => ({
      appid: 100000 + i,
      name: `Game ${i}`,
      playtime_forever: n - i,
    })),
  },
});

const getItemsFor = (url) => {
  const payload = JSON.parse(decodeURIComponent(url.split("input_json=")[1]));
  return Response.json({
    response: {
      store_items: payload.ids.map(({ appid }) => ({
        id: appid,
        success: 1,
        assets: {
          asset_url_format: `steam/apps/${appid}/\${FILENAME}?t=1`,
          header: "hash/header.jpg",
        },
      })),
    },
  });
};

describe("subrequest budget", () => {
  it.each([50, 250, 1000, 5000])(
    "stays under the Free-plan limit for a %i-game library",
    async (size) => {
      const counts = meter({
        GetOwnedGames: json(library(size)),
        "IStoreBrowseService/GetItems": getItemsFor,
      });

      const res = await call("/api/me/games", { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(total(counts)).toBeLessThan(FREE_PLAN_LIMIT);
    },
  );

  it("does not scale subrequests with library size", async () => {
    const small = meter({
      GetOwnedGames: json(library(20)),
      "IStoreBrowseService/GetItems": getItemsFor,
    });
    await call("/api/me/games", { Authorization: `Bearer ${token}` });
    const smallTotal = total(small);

    vi.restoreAllMocks();

    const big = meter({
      GetOwnedGames: json(library(2000)),
      "IStoreBrowseService/GetItems": getItemsFor,
    });
    await call("/api/me/games", { Authorization: `Bearer ${token}` });

    // 100x the games must cost far less than 100x the subrequests. Before the
    // fix this grew ~2 per game; now it is bounded by the chunk cap.
    expect(total(big)).toBeLessThan(smallTotal * 10);
    expect(total(big)).toBeLessThan(FREE_PLAN_LIMIT);
  });

  it("uses no Cache API calls on the library path", async () => {
    const counts = meter({
      GetOwnedGames: json(library(400)),
      "IStoreBrowseService/GetItems": getItemsFor,
    });
    await call("/api/me/games", { Authorization: `Bearer ${token}` });

    expect(counts.cacheMatch).toBe(0);
    expect(counts.cachePut).toBe(0);
  });

  it("stays under the limit for the largest trending request", async () => {
    const counts = meter({
      GetMostPlayedGames: json({
        response: {
          rollup_date: 1,
          ranks: Array.from({ length: 30 }, (_, i) => ({
            rank: i + 1,
            appid: 200000 + i,
            peak_in_game: 10,
          })),
        },
      }),
      "IStoreBrowseService/GetItems": getItemsFor,
      "api/appdetails": json({}),
    });

    const res = await call("/api/steam/trending?limit=30");
    expect(res.status).toBe(200);
    expect(total(counts)).toBeLessThan(FREE_PLAN_LIMIT);
  });

  it("stays well under the limit for an achievements request", async () => {
    const counts = meter({
      GetPlayerAchievements: json({
        playerstats: {
          gameName: "G",
          success: true,
          achievements: [{ apiname: "A", achieved: 0, unlocktime: 0 }],
        },
      }),
      GetSchemaForGame: json({ game: { availableGameStats: { achievements: [] } } }),
      GetGlobalAchievementPercentagesForApp: json({ achievementpercentages: { achievements: [] } }),
    });

    await call("/api/games/730/achievements", { Authorization: `Bearer ${token}` });
    expect(total(counts)).toBeLessThan(10);
  });
});
