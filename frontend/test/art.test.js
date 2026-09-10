import { describe, expect, it } from "vitest";
import { hueFor, initials } from "../js/art.js";

describe("initials — placeholder text for apps with no cover art", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Dedicated Server Tool")).toBe("DS");
  });

  it("uses a single letter for a one-word name", () => {
    expect(initials("Portal")).toBe("P");
  });

  it("uppercases lowercase names", () => {
    expect(initials("hollow knight")).toBe("HK");
  });

  it("ignores punctuation that would otherwise become the initial", () => {
    expect(initials("!Bang Boom")).toBe("BB");
    expect(initials("(Beta) Client")).toBe("BC");
  });

  it("keeps digits, which are real Steam app names", () => {
    expect(initials("7 Days to Die")).toBe("7D");
    expect(initials("2064: Read Only Memories")).toBe("2R");
  });

  it("handles non-Latin names without mangling them", () => {
    expect(initials("Дота 2")).toBe("Д2");
  });

  it("collapses runs of separators rather than emitting blanks", () => {
    expect(initials("Half-Life:  Alyx")).toBe("HL");
  });

  it.each([
    ["an empty string", ""],
    ["only punctuation", "!!! ---"],
    ["only whitespace", "   "],
  ])("falls back to ? for %s", (_label, value) => {
    expect(initials(value)).toBe("?");
  });

  it("survives a missing name instead of throwing", () => {
    expect(initials(undefined)).toBe("?");
    expect(initials(null)).toBe("?");
  });
});

describe("hueFor — deterministic tile colour", () => {
  it("returns the same hue for the same app every time", () => {
    expect(hueFor(700580)).toBe(hueFor(700580));
  });

  it("stays within a valid hue range", () => {
    for (const appid of [0, 1, 730, 570, 999999999]) {
      const hue = hueFor(appid);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("gives neighbouring app ids visibly different hues", () => {
    // Consecutive ids are common in a library; they shouldn't all look alike.
    expect(Math.abs(hueFor(730) - hueFor(731))).toBeGreaterThan(10);
  });

  it("accepts a numeric string, since app ids arrive from URLs", () => {
    expect(hueFor("730")).toBe(hueFor(730));
  });

  it("falls back to a sane hue for a non-numeric id", () => {
    expect(hueFor("abc")).toBe(210);
    expect(hueFor(undefined)).toBe(210);
  });
});
