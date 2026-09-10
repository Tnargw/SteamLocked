import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { mintToken } from "../src/auth.js";

const STEAMID = "76561198099579975";
const ORIGIN = "https://tnargw.github.io";

let token;
beforeAll(async () => {
  token = await mintToken(env, STEAMID);
});
afterEach(() => vi.restoreAllMocks());

/** Drive the Worker exactly as the runtime would. */
async function call(path, { headers, method = "GET" } = {}) {
  const request = new Request(`https://steamlocked.test${path}`, { method, headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const authed = () => ({ Authorization: `Bearer ${token}` });

/**
 * Replace outbound fetch with a fixed routing table. Anything the Worker calls
 * that isn't listed throws, so a test can never silently hit the real Steam API.
 */
function stubSteam(routes) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    // The Worker passes URL objects, Requests and strings — normalise all three.
    const url = input instanceof Request ? input.url : String(input);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return respond(url, init);
    }
    throw new Error(`Unmocked outbound fetch: ${url}`);
  });
}

const ok = (body) => () => Response.json(body);
const openIdSays = (valid) => () => new Response(`is_valid:${valid}\n`, { status: 200 });

const PLAYER_SUMMARY = {
  response: {
    players: [
      {
        steamid: STEAMID,
        personaname: "TestPlayer",
        avatarfull: "https://avatars.test/full.jpg",
        profileurl: "https://steamcommunity.com/id/test/",
        communityvisibilitystate: 3,
      },
    ],
  },
};

/** One unlocked, one common, one ultra-rare. */
const sampleGame = () => ({
  GetPlayerAchievements: ok({
    playerstats: {
      gameName: "Test Game",
      success: true,
      achievements: [
        { apiname: "DONE", achieved: 1, unlocktime: 1600000000 },
        { apiname: "COMMON", achieved: 0, unlocktime: 0 },
        { apiname: "RARE", achieved: 0, unlocktime: 0 },
      ],
    },
  }),
  GetSchemaForGame: ok({
    game: {
      availableGameStats: {
        achievements: [
          { name: "DONE", displayName: "Already Done", description: "d", icon: "i", icongray: "g" },
          { name: "COMMON", displayName: "Common Task", description: "c", icon: "i", icongray: "g" },
          { name: "RARE", displayName: "Rare Task", description: "r", icon: "i", hidden: 1 },
        ],
      },
    },
  }),
  GetGlobalAchievementPercentagesForApp: ok({
    achievementpercentages: {
      achievements: [
        { name: "DONE", percent: "80.0" },
        { name: "COMMON", percent: "65.5" },
        { name: "RARE", percent: "1.2" },
      ],
    },
  }),
});

// --- basics ------------------------------------------------------------------

describe("service endpoints", () => {
  it("reports liveness on /health", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("identifies itself at the root", async () => {
    expect(await (await call("/")).json()).toMatchObject({ service: "steamlocked-api" });
  });

  it("404s an unknown path", async () => {
    expect((await call("/api/nope")).status).toBe(404);
  });

  it("405s a non-GET request to a known route", async () => {
    expect((await call("/api/me", { method: "POST" })).status).toBe(405);
  });
});

describe("CORS", () => {
  it("answers a preflight with 204 and the allowed origin", async () => {
    const res = await call("/api/me", { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("attaches CORS headers to a real response for an allowed origin", async () => {
    const res = await call("/health", { headers: { Origin: ORIGIN } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("withholds CORS headers from a disallowed origin", async () => {
    const res = await call("/health", { headers: { Origin: "https://evil.example.com" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("still attaches CORS headers to error responses, so the browser can read them", async () => {
    const res = await call("/api/me", { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});

// --- auth flow ---------------------------------------------------------------

describe("Steam OpenID login", () => {
  it("redirects to Steam with checkid_setup parameters", async () => {
    const res = await call(`/auth/steam/login?return=${encodeURIComponent(ORIGIN + "/")}`);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("Location"));
    expect(location.origin + location.pathname).toBe("https://steamcommunity.com/openid/login");
    expect(location.searchParams.get("openid.mode")).toBe("checkid_setup");
    expect(location.searchParams.get("openid.return_to")).toContain("/auth/steam/callback");
  });

  it("refuses to start a login that would return to an unapproved origin", async () => {
    const res = await call("/auth/steam/login?return=https%3A%2F%2Fevil.example.com%2F");
    expect(res.status).toBe(400);
  });

  it("refuses a login with no return URL", async () => {
    expect((await call("/auth/steam/login")).status).toBe(400);
  });
});

describe("Steam OpenID callback", () => {
  const callback = (claimedId, ret = ORIGIN + "/") =>
    call(
      `/auth/steam/callback?return=${encodeURIComponent(ret)}` +
        `&openid.claimed_id=${encodeURIComponent(claimedId)}` +
        `&openid.mode=id_res&openid.sig=abc`,
    );

  it("issues a token when Steam confirms the assertion", async () => {
    stubSteam({ "steamcommunity.com/openid/login": openIdSays(true) });

    const res = await callback(`https://steamcommunity.com/openid/id/${STEAMID}`);
    expect(res.status).toBe(302);

    const dest = new URL(res.headers.get("Location"));
    expect(dest.origin).toBe(ORIGIN);
    expect(dest.hash).toMatch(/^#token=/);
  });

  it("verifies the assertion with Steam rather than trusting the redirect", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("is_valid:true\n"));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);

    await callback(`https://steamcommunity.com/openid/id/${STEAMID}`);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("openid.mode=check_authentication");
  });

  it("rejects the login when Steam says the assertion is not valid", async () => {
    stubSteam({ "steamcommunity.com/openid/login": openIdSays(false) });

    const res = await callback(`https://steamcommunity.com/openid/id/${STEAMID}`);
    expect(new URL(res.headers.get("Location")).hash).toBe("#error=verification_failed");
  });

  it("rejects a claimed_id that is not a Steam identity URL, without calling Steam", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await callback("https://evil.example.com/openid/id/76561198099579975");
    expect(new URL(res.headers.get("Location")).hash).toBe("#error=steam_denied");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to redirect anywhere outside the allowlist", async () => {
    const res = await callback(
      `https://steamcommunity.com/openid/id/${STEAMID}`,
      "https://evil.example.com/",
    );
    expect(res.status).toBe(400);
  });
});

// --- authenticated routes ----------------------------------------------------

describe("authentication gate", () => {
  it.each(["/api/me", "/api/me/games", "/api/games/730/achievements", "/api/games/730/roll"])(
    "401s %s without a token",
    async (path) => {
      expect((await call(path)).status).toBe(401);
    },
  );

  it("401s with an unsigned token", async () => {
    const res = await call("/api/me", { headers: { Authorization: "Bearer forged.token" } });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/me", () => {
  it("returns the signed-in player's profile", async () => {
    stubSteam({ GetPlayerSummaries: ok(PLAYER_SUMMARY) });
    const res = await call("/api/me", { headers: authed() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ steamid: STEAMID, name: "TestPlayer" });
  });

  it("sends the API key to Steam but never back to the client", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(Response.json(PLAYER_SUMMARY));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);

    const body = await (await call("/api/me", { headers: authed() })).text();

    expect(String(fetchSpy.mock.calls[0][0])).toContain("key=test-steam-key");
    expect(body).not.toContain("test-steam-key");
  });
});

describe("GET /api/me/games", () => {
  it("returns owned games sorted by playtime, most played first", async () => {
    stubSteam({
      GetOwnedGames: ok({
        response: {
          game_count: 2,
          games: [
            { appid: 570, name: "Dota 2", playtime_forever: 100 },
            { appid: 730, name: "Counter-Strike 2", playtime_forever: 900 },
          ],
        },
      }),
    });

    const body = await (await call("/api/me/games", { headers: authed() })).json();
    expect(body.private).toBe(false);
    expect(body.games.map((g) => g.appid)).toEqual([730, 570]);
    expect(body.games[0].headerUrl).toContain("/steam/apps/730/header.jpg");
  });

  it("reports a private library instead of erroring", async () => {
    stubSteam({ GetOwnedGames: ok({ response: {} }) });
    expect(await (await call("/api/me/games", { headers: authed() })).json()).toMatchObject({
      private: true,
      count: 0,
    });
  });
});

// --- achievements & rolling ---------------------------------------------------

describe("GET /api/games/:appid/achievements", () => {
  it("merges player state, schema metadata and global rarity", async () => {
    stubSteam(sampleGame());
    const body = await (await call("/api/games/101/achievements", { headers: authed() })).json();

    expect(body).toMatchObject({ available: true, unlocked: 1, total: 3 });
    expect(body.achievements.find((a) => a.key === "RARE")).toMatchObject({
      name: "Rare Task", // from the schema, not the player payload
      globalPercent: 1.2, // from global percentages
      tier: "insane", // derived
      unlocked: false, // from player state
      hidden: true,
    });
  });

  it("reports games with no achievement schema as unavailable rather than failing", async () => {
    stubSteam({ GetPlayerAchievements: () => new Response("no stats", { status: 400 }) });

    const body = await (await call("/api/games/102/achievements", { headers: authed() })).json();
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/no achievements/i);
  });

  it("rejects a non-numeric app id", async () => {
    expect((await call("/api/games/abc/achievements", { headers: authed() })).status).toBe(404);
  });
});

describe("GET /api/games/:appid/roll", () => {
  const roll = (appid, query = "") =>
    call(`/api/games/${appid}/roll${query}`, { headers: authed() });

  it("only ever rolls an achievement the player has not unlocked", async () => {
    stubSteam(sampleGame());
    // Roll repeatedly: an off-by-one in the filter would eventually surface.
    for (let i = 0; i < 15; i++) {
      const body = await (await roll(201)).json();
      expect(body.task.unlocked).toBe(false);
      expect(["COMMON", "RARE"]).toContain(body.task.key);
    }
  });

  it("reports accurate progress alongside the task", async () => {
    stubSteam(sampleGame());
    expect(await (await roll(202)).json()).toMatchObject({ locked: 2, unlocked: 1, total: 3 });
  });

  it("honours a difficulty filter", async () => {
    stubSteam(sampleGame());
    const body = await (await roll(203, "?difficulty=insane")).json();
    expect(body.task.key).toBe("RARE");
    expect(body.task.tier).toBe("insane");
  });

  it("409s when the requested difficulty has nothing left", async () => {
    stubSteam(sampleGame());
    const res = await roll(204, "?difficulty=medium");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no medium achievements/i);
  });

  it("excludes a skipped task so the same one isn't handed straight back", async () => {
    stubSteam(sampleGame());
    const body = await (await roll(205, "?exclude=RARE")).json();
    expect(body.task.key).toBe("COMMON");
  });

  it("still returns the only remaining task even if it is the excluded one", async () => {
    stubSteam({
      GetPlayerAchievements: ok({
        playerstats: {
          gameName: "Test Game",
          success: true,
          achievements: [{ apiname: "ONLY", achieved: 0, unlocktime: 0 }],
        },
      }),
      GetSchemaForGame: ok({
        game: {
          availableGameStats: {
            achievements: [{ name: "ONLY", displayName: "Only One", description: "", icon: "i" }],
          },
        },
      }),
      GetGlobalAchievementPercentagesForApp: ok({
        achievementpercentages: { achievements: [{ name: "ONLY", percent: "10.0" }] },
      }),
    });

    const body = await (await roll(206, "?exclude=ONLY")).json();
    expect(body.task.key).toBe("ONLY");
  });

  it("409s when the game is already 100% complete", async () => {
    stubSteam({
      GetPlayerAchievements: ok({
        playerstats: {
          gameName: "Test Game",
          success: true,
          achievements: [{ apiname: "DONE", achieved: 1, unlocktime: 1 }],
        },
      }),
      GetSchemaForGame: ok({
        game: {
          availableGameStats: {
            achievements: [{ name: "DONE", displayName: "Done", description: "", icon: "i" }],
          },
        },
      }),
      GetGlobalAchievementPercentagesForApp: ok({
        achievementpercentages: { achievements: [{ name: "DONE", percent: "50.0" }] },
      }),
    });

    const res = await roll(207);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already unlocked/i);
  });

  it("400s an unknown difficulty rather than silently rolling anything", async () => {
    stubSteam(sampleGame());
    expect((await roll(208, "?difficulty=trivial")).status).toBe(400);
  });
});
