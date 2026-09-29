import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { mintToken } from "../src/auth.js";

const ALICE = "76561198099579975";
const BOB = "76561190000000001";

let aliceToken;
let bobToken;

beforeAll(async () => {
  aliceToken = await mintToken(env, ALICE);
  bobToken = await mintToken(env, BOB);
});

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM active_tasks"),
    env.DB.prepare("DELETE FROM completed_tasks"),
    env.DB.prepare("DELETE FROM game_skips"),
  ]);
});

async function call(path, { token = aliceToken, method = "GET" } = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://steamlocked.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const ok = (body) => () => Response.json(body);

function stubSteam(routes) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return respond(url);
    }
    throw new Error(`Unmocked outbound fetch: ${url}`);
  });
}

/** COMMON and RARE start locked; DONE is already unlocked. */
const game = ({ unlock = [] } = {}) => ({
  GetPlayerAchievements: ok({
    playerstats: {
      gameName: "Test Game",
      success: true,
      achievements: [
        { apiname: "DONE", achieved: 1, unlocktime: 1 },
        { apiname: "COMMON", achieved: unlock.includes("COMMON") ? 1 : 0, unlocktime: 0 },
        { apiname: "RARE", achieved: unlock.includes("RARE") ? 1 : 0, unlocktime: 0 },
      ],
    },
  }),
  GetSchemaForGame: ok({
    game: {
      availableGameStats: {
        achievements: [
          { name: "DONE", displayName: "Done", description: "", icon: "i" },
          { name: "COMMON", displayName: "Common Task", description: "c", icon: "i" },
          { name: "RARE", displayName: "Rare Task", description: "r", icon: "i" },
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

const rollInsane = (appid) =>
  call(`/api/games/${appid}/roll?difficulty=insane`, { method: "POST" });

describe("state survives across devices", () => {
  it("returns an empty slate for a player with no history", async () => {
    const body = await (await call("/api/me/state")).json();
    expect(body.games).toEqual({});
    expect(body.totals).toEqual({ completed: 0, skipped: 0, active: 0 });
  });

  it("serves a task rolled on one device to a completely separate request", async () => {
    stubSteam(game());
    await rollInsane(730);
    vi.restoreAllMocks();

    // A second "device": new request, same token, no shared client state.
    const body = await (await call("/api/me/state")).json();
    expect(body.games["730"].active).toMatchObject({ key: "RARE", name: "Rare Task" });
    expect(body.totals.active).toBe(1);
  });

  it("keeps the progress of one player invisible to another", async () => {
    stubSteam(game());
    await rollInsane(730);
    vi.restoreAllMocks();

    const bob = await (await call("/api/me/state", { token: bobToken })).json();
    expect(bob.games).toEqual({});
  });

  it("carries full task metadata through storage, not just an id", async () => {
    stubSteam(game());
    await rollInsane(730);
    vi.restoreAllMocks();

    const task = (await (await call("/api/me/state")).json()).games["730"].active;
    expect(task).toMatchObject({ key: "RARE", tier: "insane", globalPercent: 1.2 });
    expect(task.rolledAt).toBeTypeOf("number");
  });
});

describe("the active-task lock", () => {
  it("refuses a second roll while a task is already active", async () => {
    stubSteam(game());
    expect((await rollInsane(730)).status).toBe(200);

    const second = await call("/api/games/730/roll", { method: "POST" });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already have an active task/i);
  });

  it("only lets one of two simultaneous rolls win", async () => {
    stubSteam(game());
    // Two devices rolling at the same instant.
    const [a, b] = await Promise.all([
      call("/api/games/730/roll", { method: "POST" }),
      call("/api/games/730/roll", { method: "POST" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM active_tasks").first();
    expect(rows.n).toBe(1);
  });

  it("allows an active task in a different game at the same time", async () => {
    stubSteam(game());
    expect((await rollInsane(730)).status).toBe(200);
    expect((await rollInsane(570)).status).toBe(200);

    const body = await (await call("/api/me/state")).json();
    expect(body.totals.active).toBe(2);
  });
});

describe("completion is verified, not trusted", () => {
  it("refuses to bank a task Steam still reports as locked", async () => {
    stubSteam(game());
    await rollInsane(730);

    const res = await call("/api/games/730/complete", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).completed).toBe(false);

    // Still active, still uncounted.
    const state = await (await call("/api/me/state")).json();
    expect(state.games["730"].active).toMatchObject({ key: "RARE" });
    expect(state.totals.completed).toBe(0);
  });

  it("banks the task once Steam reports it unlocked", async () => {
    stubSteam(game());
    await rollInsane(730);
    vi.restoreAllMocks();

    stubSteam(game({ unlock: ["RARE"] }));
    const body = await (await call("/api/games/730/complete", { method: "POST" })).json();

    expect(body.completed).toBe(true);
    expect(body.task.key).toBe("RARE");
    expect(body.game.active).toBeNull();
    expect(body.game.completed[0]).toMatchObject({ key: "RARE", tier: "insane" });
    expect(body.totals.completed).toBe(1);
  });

  it("409s a completion when there is no active task", async () => {
    expect((await call("/api/games/730/complete", { method: "POST" })).status).toBe(409);
  });

  it("does not double-credit the same achievement on a repeated call", async () => {
    stubSteam(game());
    await rollInsane(730);
    vi.restoreAllMocks();

    stubSteam(game({ unlock: ["RARE"] }));
    await call("/api/games/730/complete", { method: "POST" });
    // A retry — flaky network, or an impatient second click.
    await call("/api/games/730/complete", { method: "POST" });

    const state = await (await call("/api/me/state")).json();
    expect(state.totals.completed).toBe(1);
  });

  it("frees the slot so the next task can be rolled", async () => {
    stubSteam(game());
    await rollInsane(730);
    vi.restoreAllMocks();

    stubSteam(game({ unlock: ["RARE"] }));
    await call("/api/games/730/complete", { method: "POST" });
    vi.restoreAllMocks();

    stubSteam(game({ unlock: ["RARE"] }));
    const next = await call("/api/games/730/roll", { method: "POST" });
    expect(next.status).toBe(200);
    expect((await next.json()).task.key).toBe("COMMON");
  });
});

describe("skipping", () => {
  it("clears the task and charges a skip", async () => {
    stubSteam(game());
    await rollInsane(730);

    const body = await (await call("/api/games/730/skip", { method: "POST" })).json();
    expect(body.skipped.key).toBe("RARE");
    expect(body.game.active).toBeNull();
    expect(body.game.skipped).toBe(1);
    expect(body.totals.skipped).toBe(1);
  });

  it("does not count a skip as a completion", async () => {
    stubSteam(game());
    await rollInsane(730);
    await call("/api/games/730/skip", { method: "POST" });

    const state = await (await call("/api/me/state")).json();
    expect(state.totals).toMatchObject({ completed: 0, skipped: 1, active: 0 });
  });

  it("accumulates skips across rolls", async () => {
    stubSteam(game());
    for (let i = 0; i < 3; i++) {
      await rollInsane(730);
      await call("/api/games/730/skip", { method: "POST" });
    }
    const state = await (await call("/api/me/state")).json();
    expect(state.games["730"].skipped).toBe(3);
  });

  it("409s a skip when there is no active task", async () => {
    expect((await call("/api/games/730/skip", { method: "POST" })).status).toBe(409);
  });
});

describe("auth still gates everything", () => {
  it.each([
    ["/api/me/state", "GET"],
    ["/api/games/730/roll", "POST"],
    ["/api/games/730/complete", "POST"],
    ["/api/games/730/skip", "POST"],
  ])("401s %s without a token", async (path, method) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://steamlocked.test${path}`, { method }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
