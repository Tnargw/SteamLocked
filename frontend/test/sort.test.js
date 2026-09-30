import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SORT,
  SORTS,
  isSortKey,
  loadPreference,
  naturalDirection,
  savePreference,
  sortGames,
} from "../js/sort.js";

const game = (name, playtimeMinutes, lastPlayed = 0, appid = name.length) => ({
  appid,
  name,
  playtimeMinutes,
  lastPlayed,
});

// Deliberately unordered, with ties on every field.
const LIBRARY = [
  game("Dota 2", 4300, 1700000200),
  game("Apex Legends", 0, 0),
  game("Counter-Strike 2", 12045, 1700000300),
  game("Baba Is You", 4300, 1700000100), // playtime tie with Dota 2
  game("Zeus Defence", 0, 0), // never-played tie with Apex
];

const names = (list) => list.map((g) => g.name);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("sort definitions", () => {
  it("offers hours played, name and recently played", () => {
    expect(Object.keys(SORTS)).toEqual(["playtime", "name", "recent"]);
  });

  it("starts each field in the direction people expect", () => {
    expect(naturalDirection("playtime")).toBe("desc"); // most played first
    expect(naturalDirection("name")).toBe("asc"); // A–Z
    expect(naturalDirection("recent")).toBe("desc"); // newest first
  });

  it("recognises only real sort keys", () => {
    expect(isSortKey("name")).toBe(true);
    expect(isSortKey("nonsense")).toBe(false);
    expect(isSortKey(undefined)).toBe(false);
  });
});

describe("sortGames", () => {
  it("sorts by hours played, most first", () => {
    const sorted = sortGames(LIBRARY, "playtime", "desc");
    expect(names(sorted).slice(0, 3)).toEqual(["Counter-Strike 2", "Baba Is You", "Dota 2"]);
  });

  it("reverses when asked", () => {
    const desc = sortGames(LIBRARY, "playtime", "desc");
    const asc = sortGames(LIBRARY, "playtime", "asc");
    expect(names(asc).at(-1)).toBe(names(desc)[0]);
  });

  it("sorts alphabetically", () => {
    expect(names(sortGames(LIBRARY, "name", "asc"))).toEqual([
      "Apex Legends",
      "Baba Is You",
      "Counter-Strike 2",
      "Dota 2",
      "Zeus Defence",
    ]);
  });

  it("sorts Z–A", () => {
    expect(names(sortGames(LIBRARY, "name", "desc"))[0]).toBe("Zeus Defence");
  });

  it("sorts by most recently played", () => {
    expect(names(sortGames(LIBRARY, "recent", "desc")).slice(0, 3)).toEqual([
      "Counter-Strike 2",
      "Dota 2",
      "Baba Is You",
    ]);
  });

  it("breaks ties by name, ascending, whichever way the sort runs", () => {
    // Baba Is You and Dota 2 both have 4300 minutes; Apex and Zeus both have 0.
    const desc = sortGames(LIBRARY, "playtime", "desc");
    const asc = sortGames(LIBRARY, "playtime", "asc");

    const tiedDesc = names(desc).filter((n) => n === "Baba Is You" || n === "Dota 2");
    const tiedAsc = names(asc).filter((n) => n === "Baba Is You" || n === "Dota 2");
    expect(tiedDesc).toEqual(["Baba Is You", "Dota 2"]);
    expect(tiedAsc).toEqual(["Baba Is You", "Dota 2"]);
  });

  it("is stable across repeated calls, so the grid does not shuffle", () => {
    const first = names(sortGames(LIBRARY, "recent", "desc"));
    for (let i = 0; i < 5; i++) {
      expect(names(sortGames(LIBRARY, "recent", "desc"))).toEqual(first);
    }
  });

  it("does not mutate the array it was given", () => {
    const original = [...LIBRARY];
    sortGames(LIBRARY, "name", "asc");
    expect(LIBRARY).toEqual(original);
  });

  it("falls back to the default sort for an unknown key", () => {
    expect(names(sortGames(LIBRARY, "nonsense", "desc"))[0]).toBe("Counter-Strike 2");
  });

  it("tolerates games missing the field being sorted on", () => {
    const patchy = [{ appid: 1, name: "No Playtime" }, game("Has Playtime", 100)];
    expect(() => sortGames(patchy, "playtime", "desc")).not.toThrow();
    expect(names(sortGames(patchy, "playtime", "desc"))[0]).toBe("Has Playtime");
  });

  it("handles an empty library", () => {
    expect(sortGames([], "name", "asc")).toEqual([]);
  });
});

describe("remembering the choice", () => {
  it("defaults to hours played, descending", () => {
    expect(loadPreference()).toEqual({ key: DEFAULT_SORT, direction: "desc" });
  });

  it("round-trips a saved choice", () => {
    savePreference({ key: "name", direction: "asc" });
    expect(loadPreference()).toEqual({ key: "name", direction: "asc" });
  });

  it("ignores a saved key that no longer exists", () => {
    localStorage.setItem("steamlocked.sort.v1", JSON.stringify({ key: "retired", direction: "asc" }));
    expect(loadPreference().key).toBe(DEFAULT_SORT);
  });

  it("ignores a bogus direction", () => {
    savePreference({ key: "name", direction: "sideways" });
    expect(loadPreference().direction).toBe("desc");
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("steamlocked.sort.v1", "{not json");
    expect(loadPreference().key).toBe(DEFAULT_SORT);
  });

  it("does not throw when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => savePreference({ key: "name", direction: "asc" })).not.toThrow();
  });

  it("returns the default when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    expect(loadPreference().key).toBe(DEFAULT_SORT);
  });
});
