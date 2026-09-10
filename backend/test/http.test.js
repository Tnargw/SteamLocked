import { describe, expect, it } from "vitest";
import { corsHeaders, isAppId, isSteamId64, json, safeReturnUrl } from "../src/http.js";

const withOrigin = (origin) =>
  new Request("https://api.example/x", origin ? { headers: { Origin: origin } } : undefined);

describe("safeReturnUrl — open-redirect protection", () => {
  it("allows the production site origin", () => {
    expect(safeReturnUrl("https://tnargw.github.io/SteamLocked/", null)).toBe(
      "https://tnargw.github.io/SteamLocked/",
    );
  });

  it("allows localhost dev origins", () => {
    expect(safeReturnUrl("http://localhost:5173/", null)).toBe("http://localhost:5173/");
  });

  it("rejects an unrelated origin", () => {
    expect(safeReturnUrl("https://evil.example.com/steal", "FALLBACK")).toBe("FALLBACK");
  });

  it("rejects a look-alike subdomain of an allowed host", () => {
    expect(safeReturnUrl("https://tnargw.github.io.evil.com/", "FALLBACK")).toBe("FALLBACK");
  });

  it("rejects an http downgrade of an https origin", () => {
    expect(safeReturnUrl("http://tnargw.github.io/", "FALLBACK")).toBe("FALLBACK");
  });

  it("rejects a javascript: URL", () => {
    expect(safeReturnUrl("javascript:alert(1)", "FALLBACK")).toBe("FALLBACK");
  });

  it("rejects unparseable input", () => {
    expect(safeReturnUrl("not a url", "FALLBACK")).toBe("FALLBACK");
  });

  it("falls back when nothing is supplied", () => {
    expect(safeReturnUrl(null, "FALLBACK")).toBe("FALLBACK");
  });
});

describe("corsHeaders", () => {
  it("echoes an allowed origin and varies on Origin", () => {
    const headers = corsHeaders(withOrigin("https://tnargw.github.io"));
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://tnargw.github.io");
    expect(headers.Vary).toBe("Origin");
  });

  it("permits the Authorization header, which the session token needs", () => {
    const headers = corsHeaders(withOrigin("https://tnargw.github.io"));
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
  });

  it("returns nothing for a disallowed origin", () => {
    expect(corsHeaders(withOrigin("https://evil.example.com"))).toEqual({});
  });

  it("returns nothing when there is no Origin header at all", () => {
    expect(corsHeaders(withOrigin(null))).toEqual({});
  });

  it("never emits a wildcard origin", () => {
    const headers = corsHeaders(withOrigin("https://tnargw.github.io"));
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
  });
});

describe("json helper", () => {
  it("merges CORS headers into the response", async () => {
    const res = json({ ok: true }, {}, { "Access-Control-Allow-Origin": "https://x.test" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://x.test");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("honours an explicit status", () => {
    expect(json({ error: "nope" }, { status: 418 }).status).toBe(418);
  });
});

describe("identifier validators", () => {
  it("accepts a real 17-digit SteamID64", () => {
    expect(isSteamId64("76561198099579975")).toBe(true);
  });

  it.each([
    ["too short", "7656119809957997"],
    ["too long", "765611980995799751"],
    ["non-numeric", "7656119809957997a"],
    ["empty", ""],
  ])("rejects a SteamID that is %s", (_label, value) => {
    expect(isSteamId64(value)).toBe(false);
  });

  it("rejects a non-string SteamID", () => {
    expect(isSteamId64(76561198099579975)).toBe(false);
  });

  it("accepts plausible app ids", () => {
    expect(isAppId("730")).toBe(true);
    expect(isAppId("2676230")).toBe(true);
  });

  it.each([
    ["alphabetic", "abc"],
    ["empty", ""],
    ["over ten digits", "12345678901"],
  ])("rejects an app id that is %s", (_label, value) => {
    expect(isAppId(value)).toBe(false);
  });
});
