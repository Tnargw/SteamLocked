import { describe, expect, it } from "vitest";
import { headerUrl, storeUrl, tierFor } from "../src/steam.js";

describe("tierFor — difficulty from global unlock rate", () => {
  it.each([
    [100, "easy"],
    [50, "easy"],
    [49.9, "medium"],
    [20, "medium"],
    [19.9, "hard"],
    [5, "hard"],
    [4.9, "insane"],
    [0, "insane"],
  ])("maps %s percent of players to tier %s", (percent, expected) => {
    expect(tierFor(percent)).toBe(expected);
  });

  it("treats a missing percentage as unrated rather than guessing", () => {
    expect(tierFor(null)).toBe("unknown");
    expect(tierFor(undefined)).toBe("unknown");
  });

  it("never reports 0% as easy — the boundary bug that would flip the hardest tier", () => {
    expect(tierFor(0)).not.toBe("easy");
  });
});

describe("Steam URL builders", () => {
  it("builds a CDN header image URL", () => {
    expect(headerUrl(730)).toBe(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg",
    );
  });

  it("builds a store page URL", () => {
    expect(storeUrl(730)).toBe("https://store.steampowered.com/app/730/");
  });
});
