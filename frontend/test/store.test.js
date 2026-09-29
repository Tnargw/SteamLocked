import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../js/store.js";
import * as api from "../js/api.js";

const CS2 = 730;

const task = (over = {}) => ({
  key: "RARE",
  name: "Rare Task",
  description: "Do the hard thing.",
  icon: null,
  tier: "insane",
  globalPercent: 1.2,
  rolledAt: 1700000000000,
  ...over,
});

const serverState = (games = {}, totals = { completed: 0, skipped: 0, active: 0 }) => ({
  games,
  totals,
});

beforeEach(() => {
  store.reset();
  vi.restoreAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe("load — the server is the source of truth", () => {
  it("starts empty before anything is loaded", () => {
    expect(store.totals()).toEqual({ completed: 0, skipped: 0, active: 0 });
    expect(store.activeAppIds()).toEqual([]);
  });

  it("mirrors whatever the server returns", async () => {
    vi.spyOn(api, "getState").mockResolvedValue(
      serverState(
        { [CS2]: { active: task(), completed: [], skipped: 2 } },
        { completed: 0, skipped: 2, active: 1 },
      ),
    );

    await store.load();

    expect(store.getGame(CS2).active).toMatchObject({ key: "RARE" });
    expect(store.getGame(CS2).skipped).toBe(2);
    expect(store.totals()).toEqual({ completed: 0, skipped: 2, active: 1 });
  });

  it("reads progress that was made on another device", async () => {
    // Nothing was rolled in this browser — it all comes down from the server.
    vi.spyOn(api, "getState").mockResolvedValue(
      serverState(
        { [CS2]: { active: null, completed: [task({ key: "OLD" })], skipped: 0 } },
        { completed: 1, skipped: 0, active: 0 },
      ),
    );

    await store.load();

    expect(store.getGame(CS2).completed).toHaveLength(1);
    expect(store.totals().completed).toBe(1);
  });

  it("returns a blank game for an app with no history", () => {
    expect(store.getGame(999)).toEqual({ active: null, completed: [], skipped: 0 });
  });

  it("lists the games holding an active task", async () => {
    vi.spyOn(api, "getState").mockResolvedValue(
      serverState({
        730: { active: task(), completed: [], skipped: 0 },
        570: { active: null, completed: [], skipped: 1 },
        553850: { active: task({ key: "B" }), completed: [], skipped: 0 },
      }),
    );

    await store.load();
    expect(store.activeAppIds().sort((a, b) => a - b)).toEqual([730, 553850]);
  });

  it("propagates a load failure rather than silently showing an empty slate", async () => {
    vi.spyOn(api, "getState").mockRejectedValue(new Error("offline"));
    await expect(store.load()).rejects.toThrow("offline");
  });
});

describe("roll", () => {
  it("folds the server response into local state", async () => {
    vi.spyOn(api, "rollTask").mockResolvedValue({
      appid: CS2,
      game: { active: task(), completed: [], skipped: 0 },
      totals: { completed: 0, skipped: 0, active: 1 },
      task: task(),
    });

    const result = await store.roll(CS2, { difficulty: "insane" });

    expect(result.task.key).toBe("RARE");
    expect(store.getGame(CS2).active).toMatchObject({ key: "RARE" });
    expect(store.totals().active).toBe(1);
  });

  it("passes the difficulty through to the API", async () => {
    const spy = vi.spyOn(api, "rollTask").mockResolvedValue({
      appid: CS2,
      game: { active: task(), completed: [], skipped: 0 },
      totals: { completed: 0, skipped: 0, active: 1 },
      task: task(),
    });

    await store.roll(CS2, { difficulty: "hard" });
    expect(spy).toHaveBeenCalledWith(CS2, { difficulty: "hard" });
  });

  it("leaves local state untouched when the server refuses", async () => {
    vi.spyOn(api, "rollTask").mockRejectedValue(new Error("already have an active task"));

    await expect(store.roll(CS2)).rejects.toThrow(/active task/);
    expect(store.getGame(CS2).active).toBeNull();
  });
});

describe("complete", () => {
  it("applies a successful completion", async () => {
    vi.spyOn(api, "completeTask").mockResolvedValue({
      appid: CS2,
      completed: true,
      task: task(),
      game: { active: null, completed: [task()], skipped: 0 },
      totals: { completed: 1, skipped: 0, active: 0 },
    });

    const result = await store.complete(CS2);

    expect(result.completed).toBe(true);
    expect(store.getGame(CS2).active).toBeNull();
    expect(store.getGame(CS2).completed).toHaveLength(1);
    expect(store.totals().completed).toBe(1);
  });

  it("treats a still-locked achievement as an answer, not an error", async () => {
    vi.spyOn(api, "completeTask").mockResolvedValue({
      appid: CS2,
      completed: false,
      game: { active: task(), completed: [], skipped: 0 },
      totals: { completed: 0, skipped: 0, active: 1 },
    });

    const result = await store.complete(CS2);

    expect(result.completed).toBe(false);
    // The task stays locked in.
    expect(store.getGame(CS2).active).toMatchObject({ key: "RARE" });
    expect(store.totals().completed).toBe(0);
  });
});

describe("skip", () => {
  it("clears the task and records the skip the server reports", async () => {
    vi.spyOn(api, "skipTask").mockResolvedValue({
      appid: CS2,
      skipped: task(),
      game: { active: null, completed: [], skipped: 1 },
      totals: { completed: 0, skipped: 1, active: 0 },
    });

    const result = await store.skip(CS2);

    expect(result.skipped.key).toBe("RARE");
    expect(store.getGame(CS2).active).toBeNull();
    expect(store.getGame(CS2).skipped).toBe(1);
    expect(store.totals()).toMatchObject({ completed: 0, skipped: 1 });
  });
});

describe("reset", () => {
  it("drops everything on sign-out", async () => {
    vi.spyOn(api, "getState").mockResolvedValue(
      serverState(
        { [CS2]: { active: task(), completed: [task()], skipped: 3 } },
        { completed: 1, skipped: 3, active: 1 },
      ),
    );
    await store.load();

    store.reset();

    expect(store.totals()).toEqual({ completed: 0, skipped: 0, active: 0 });
    expect(store.getGame(CS2).active).toBeNull();
    expect(store.activeAppIds()).toEqual([]);
  });

  it("does not leave the previous account's progress visible to the next", async () => {
    vi.spyOn(api, "getState").mockResolvedValueOnce(
      serverState(
        { [CS2]: { active: task(), completed: [], skipped: 0 } },
        { completed: 0, skipped: 0, active: 1 },
      ),
    );
    await store.load();
    store.reset();

    vi.spyOn(api, "getState").mockResolvedValue(serverState());
    await store.load();

    expect(store.getGame(CS2).active).toBeNull();
    expect(store.totals().active).toBe(0);
  });
});
