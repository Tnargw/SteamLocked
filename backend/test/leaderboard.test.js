import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { mintToken } from "../src/auth.js";
import { TIER_POINTS } from "../src/db.js";

const ALICE = "76561198000000001";
const BOB = "76561198000000002";
const CARA = "76561198000000003";

const tokens = {};

beforeAll(async () => {
  for (const id of [ALICE, BOB, CARA]) tokens[id] = await mintToken(env, id);
});

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM active_tasks"),
    env.DB.prepare("DELETE FROM completed_tasks"),
    env.DB.prepare("DELETE FROM game_skips"),
    env.DB.prepare("DELETE FROM players"),
  ]);
});

async function call(path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://steamlocked.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** Register a player and give them completions of the given tiers. */
async function seed(steamid, name, tiers, { listed = 1 } = {}) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO players (steamid, name, avatar, listed, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(steamid, name, `https://avatars.test/${steamid}.jpg`, listed, now, now)
    .run();

  if (!tiers.length) return;
  await env.DB.batch(
    tiers.map((tier, i) =>
      env.DB.prepare(
        `INSERT INTO completed_tasks
           (steamid, appid, achievement, name, tier, global_percent, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(steamid, 730, `ACH_${i}`, `Task ${i}`, tier, 10, now + i),
    ),
  );
}

const board = (opts) => call("/api/leaderboard", opts).then((r) => r.json());

describe("ranking", () => {
  it("returns an empty board when nobody has finished anything", async () => {
    const body = await board();
    expect(body.entries).toEqual([]);
    expect(body.me).toBeNull();
  });

  it("scores by rarity rather than raw task count", async () => {
    // Bob grinds four easy ones; Alice lands a single insane.
    await seed(ALICE, "Alice", ["insane"]);
    await seed(BOB, "Bob", ["easy", "easy", "easy", "easy"]);

    const { entries } = await board();

    expect(entries[0]).toMatchObject({ rank: 1, name: "Alice", tasks: 1 });
    expect(entries[1]).toMatchObject({ rank: 2, name: "Bob", tasks: 4 });
    expect(entries[0].points).toBe(TIER_POINTS.insane);
    expect(entries[1].points).toBe(TIER_POINTS.easy * 4);
  });

  it("adds up mixed tiers correctly", async () => {
    await seed(ALICE, "Alice", ["insane", "hard", "medium", "easy"]);
    const { entries } = await board();
    expect(entries[0].points).toBe(
      TIER_POINTS.insane + TIER_POINTS.hard + TIER_POINTS.medium + TIER_POINTS.easy,
    );
  });

  it("treats an unrated achievement as medium rather than worthless", async () => {
    await seed(ALICE, "Alice", ["unknown"]);
    const { entries } = await board();
    expect(entries[0].points).toBe(TIER_POINTS.unknown);
  });

  it("breaks a points tie on task count", async () => {
    await seed(ALICE, "Alice", ["hard"]); // 50 from one task
    await seed(BOB, "Bob", ["medium", "medium"]); // 50 from two
    const { entries } = await board();
    expect(entries.map((e) => e.name)).toEqual(["Bob", "Alice"]);
  });

  it("assigns ranks in descending order with no gaps", async () => {
    await seed(ALICE, "Alice", ["insane"]);
    await seed(BOB, "Bob", ["hard"]);
    await seed(CARA, "Cara", ["easy"]);
    const { entries } = await board();
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("leaves out players who have registered but finished nothing", async () => {
    await seed(ALICE, "Alice", ["easy"]);
    await seed(BOB, "Bob", []);
    const { entries } = await board();
    expect(entries.map((e) => e.name)).toEqual(["Alice"]);
  });

  it("caps the page size", async () => {
    await seed(ALICE, "Alice", ["easy"]);
    await seed(BOB, "Bob", ["easy"]);
    const body = await call("/api/leaderboard?limit=1").then((r) => r.json());
    expect(body.entries).toHaveLength(1);
  });

  it("clamps an absurd limit instead of trusting it", async () => {
    await seed(ALICE, "Alice", ["easy"]);
    const res = await call("/api/leaderboard?limit=999999");
    expect(res.status).toBe(200);
  });
});

describe("opting out", () => {
  it("hides a player who has turned listing off", async () => {
    await seed(ALICE, "Alice", ["insane"], { listed: 0 });
    await seed(BOB, "Bob", ["easy"]);

    const { entries } = await board();
    expect(entries.map((e) => e.name)).toEqual(["Bob"]);
  });

  it("defaults a new player to listed", async () => {
    const body = await call("/api/me/settings", { token: tokens[ALICE] }).then((r) => r.json());
    expect(body.listed).toBe(true);
  });

  it("persists an opt-out and an opt-back-in", async () => {
    await seed(ALICE, "Alice", ["insane"]);

    let body = await call("/api/me/settings", {
      token: tokens[ALICE],
      method: "POST",
      body: { listed: false },
    }).then((r) => r.json());
    expect(body.listed).toBe(false);
    expect((await board()).entries).toEqual([]);

    body = await call("/api/me/settings", {
      token: tokens[ALICE],
      method: "POST",
      body: { listed: true },
    }).then((r) => r.json());
    expect(body.listed).toBe(true);
    expect((await board()).entries).toHaveLength(1);
  });

  it("keeps a player's completions while they are unlisted", async () => {
    await seed(ALICE, "Alice", ["insane"], { listed: 0 });
    const state = await call("/api/me/state", { token: tokens[ALICE] }).then((r) => r.json());
    expect(state.totals.completed).toBe(1);
  });

  it("gives an opted-out caller no rank of their own", async () => {
    await seed(ALICE, "Alice", ["insane"], { listed: 0 });
    const body = await board({ token: tokens[ALICE] });
    expect(body.me).toBeNull();
  });

  it("rejects a settings body that is not a boolean", async () => {
    for (const bad of [{ listed: "yes" }, { listed: 1 }, {}]) {
      const res = await call("/api/me/settings", {
        token: tokens[ALICE],
        method: "POST",
        body: bad,
      });
      expect(res.status).toBe(400);
    }
  });

  it("requires a token to change settings", async () => {
    const res = await call("/api/me/settings", { method: "POST", body: { listed: false } });
    expect(res.status).toBe(401);
  });
});

describe("the caller's own standing", () => {
  it("marks the caller when they are on the visible page", async () => {
    await seed(ALICE, "Alice", ["insane"]);
    await seed(BOB, "Bob", ["easy"]);

    const body = await board({ token: tokens[BOB] });
    expect(body.me).toMatchObject({ rank: 2, name: "Bob" });
  });

  it("reports a rank even when the caller falls off the page", async () => {
    await seed(ALICE, "Alice", ["insane", "insane"]);
    await seed(BOB, "Bob", ["insane"]);
    await seed(CARA, "Cara", ["easy"]);

    // Only the top scorer is shown, but Cara still learns she is third.
    const body = await call("/api/leaderboard?limit=1", { token: tokens[CARA] }).then((r) =>
      r.json(),
    );
    expect(body.entries).toHaveLength(1);
    expect(body.me).toMatchObject({ rank: 3, name: "Cara" });
  });

  it("gives no rank to a caller who has finished nothing", async () => {
    await seed(ALICE, "Alice", ["easy"]);
    await seed(BOB, "Bob", []);
    expect((await board({ token: tokens[BOB] })).me).toBeNull();
  });
});

describe("access", () => {
  it("serves the board without a token, so it works signed out", async () => {
    await seed(ALICE, "Alice", ["easy"]);
    const res = await call("/api/leaderboard");
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toHaveLength(1);
  });

  it("ignores a junk token rather than failing the whole board", async () => {
    await seed(ALICE, "Alice", ["easy"]);
    const res = await call("/api/leaderboard", { token: "not.a.real.token" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.me).toBeNull();
  });

  it("never exposes anything beyond public Steam identity", async () => {
    await seed(ALICE, "Alice", ["easy"]);
    const [entry] = (await board()).entries;
    expect(Object.keys(entry).sort()).toEqual(
      ["avatar", "name", "points", "rank", "steamid", "tasks"].sort(),
    );
  });
});
