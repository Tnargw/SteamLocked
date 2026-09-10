import { beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../js/store.js";

const PLAYER = "76561198099579975";
const OTHER = "76561190000000000";
const CS2 = 730;

const task = (over = {}) => ({
  key: "RARE",
  name: "Rare Task",
  description: "Do the hard thing.",
  icon: null,
  tier: "insane",
  globalPercent: 1.2,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  store.reset();
});

describe("load — per-player isolation", () => {
  it("starts a player with an empty slate", () => {
    store.load(PLAYER);
    expect(store.totals()).toEqual({ completed: 0, skipped: 0, active: 0 });
  });

  it("persists a player's progress across reloads", () => {
    store.load(PLAYER);
    store.setActive(CS2, task());
    store.load(PLAYER); // simulates a page refresh
    expect(store.getGame(CS2).active).toMatchObject({ key: "RARE" });
  });

  it("wipes state when a different account signs in", () => {
    store.load(PLAYER);
    store.setActive(CS2, task());
    store.load(OTHER);
    expect(store.getGame(CS2).active).toBeNull();
    expect(store.totals().active).toBe(0);
  });

  it("discards state written by an incompatible future version", () => {
    localStorage.setItem("steamlocked.state.v1", JSON.stringify({ version: 99, games: {} }));
    store.load(PLAYER);
    expect(store.totals()).toEqual({ completed: 0, skipped: 0, active: 0 });
  });

  it("survives corrupt JSON in storage instead of throwing", () => {
    localStorage.setItem("steamlocked.state.v1", "{not json");
    expect(() => store.load(PLAYER)).not.toThrow();
    expect(store.totals().completed).toBe(0);
  });
});

describe("the one-active-task rule", () => {
  beforeEach(() => store.load(PLAYER));

  it("records a rolled task as active with a timestamp", () => {
    store.setActive(CS2, task());
    const active = store.getGame(CS2).active;
    expect(active.key).toBe("RARE");
    expect(active.rolledAt).toBeTypeOf("number");
  });

  it("counts one active task per game, not per roll", () => {
    store.setActive(CS2, task({ key: "A" }));
    store.setActive(CS2, task({ key: "B" }));
    expect(store.totals().active).toBe(1);
    expect(store.getGame(CS2).active.key).toBe("B");
  });

  it("tracks active tasks across multiple games independently", () => {
    store.setActive(CS2, task({ key: "A" }));
    store.setActive(570, task({ key: "B" }));
    expect(store.totals().active).toBe(2);
    expect(store.activeAppIds().sort()).toEqual([570, 730]);
  });

  it("reports no active app ids when nothing is rolled", () => {
    expect(store.activeAppIds()).toEqual([]);
  });
});

describe("completing a task", () => {
  beforeEach(() => store.load(PLAYER));

  it("moves the active task into the completed list and clears the slot", () => {
    store.setActive(CS2, task());
    const done = store.completeActive(CS2);

    expect(done.key).toBe("RARE");
    expect(done.completedAt).toBeTypeOf("number");
    expect(store.getGame(CS2).active).toBeNull();
    expect(store.getGame(CS2).completed).toHaveLength(1);
  });

  it("puts the most recent completion first", () => {
    store.setActive(CS2, task({ key: "FIRST" }));
    store.completeActive(CS2);
    store.setActive(CS2, task({ key: "SECOND" }));
    store.completeActive(CS2);

    expect(store.getGame(CS2).completed.map((c) => c.key)).toEqual(["SECOND", "FIRST"]);
  });

  it("does nothing when there is no active task to complete", () => {
    expect(store.completeActive(CS2)).toBeNull();
    expect(store.getGame(CS2).completed).toHaveLength(0);
  });

  it("frees the slot so a new task can be rolled", () => {
    store.setActive(CS2, task());
    store.completeActive(CS2);
    store.setActive(CS2, task({ key: "NEXT" }));
    expect(store.getGame(CS2).active.key).toBe("NEXT");
  });
});

describe("skipping a task", () => {
  beforeEach(() => store.load(PLAYER));

  it("clears the task and counts the skip", () => {
    store.setActive(CS2, task());
    const skipped = store.skipActive(CS2);

    expect(skipped.key).toBe("RARE");
    expect(store.getGame(CS2).active).toBeNull();
    expect(store.getGame(CS2).skipped).toBe(1);
  });

  it("does not count a skip as a completion", () => {
    store.setActive(CS2, task());
    store.skipActive(CS2);
    expect(store.totals()).toMatchObject({ completed: 0, skipped: 1, active: 0 });
  });

  it("accumulates skips across repeated rolls", () => {
    for (const key of ["A", "B", "C"]) {
      store.setActive(CS2, task({ key }));
      store.skipActive(CS2);
    }
    expect(store.getGame(CS2).skipped).toBe(3);
  });
});

describe("totals across the library", () => {
  beforeEach(() => store.load(PLAYER));

  it("sums completions, skips and active tasks over every game", () => {
    store.setActive(CS2, task({ key: "A" }));
    store.completeActive(CS2);
    store.setActive(CS2, task({ key: "B" }));
    store.skipActive(CS2);
    store.setActive(570, task({ key: "C" }));

    expect(store.totals()).toEqual({ completed: 1, skipped: 1, active: 1 });
  });
});

describe("storage failures (private browsing)", () => {
  it("keeps working in memory when localStorage.setItem throws", () => {
    store.load(PLAYER);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    expect(() => store.setActive(CS2, task())).not.toThrow();
    expect(store.getGame(CS2).active.key).toBe("RARE");

    spy.mockRestore();
  });

  it("treats an unreadable store as empty rather than crashing", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });

    expect(() => store.load(PLAYER)).not.toThrow();

    spy.mockRestore();
  });
});
