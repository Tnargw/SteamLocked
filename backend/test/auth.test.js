import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintToken, requireUser, verifyToken } from "../src/auth.js";

const STEAMID = "76561198099579975";
const authed = (token) =>
  new Request("https://api.example/api/me", { headers: { Authorization: `Bearer ${token}` } });

const expectStatus = async (promise, status, match) => {
  await expect(promise).rejects.toMatchObject({
    status,
    ...(match ? { message: expect.stringMatching(match) } : {}),
  });
};

describe("session tokens", () => {
  it("round-trips a SteamID through mint and verify", async () => {
    const token = await mintToken(env, STEAMID);
    await expect(verifyToken(env, token)).resolves.toBe(STEAMID);
  });

  it("produces a two-part payload.signature token", async () => {
    const token = await mintToken(env, STEAMID);
    expect(token.split(".")).toHaveLength(2);
  });

  it("does not store the SteamID in plaintext-readable form without a signature", async () => {
    // The payload is base64url, not encrypted — but it must not validate alone.
    const [payload] = (await mintToken(env, STEAMID)).split(".");
    await expectStatus(verifyToken(env, payload), 401);
  });
});

describe("session tokens — rejection cases", () => {
  it("rejects a tampered signature", async () => {
    const token = await mintToken(env, STEAMID);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    await expectStatus(verifyToken(env, tampered), 401, /Invalid session token/);
  });

  it("rejects a forged payload claiming a different SteamID", async () => {
    const token = await mintToken(env, STEAMID);
    const [, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "76561190000000000", exp: 9e9 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expectStatus(verifyToken(env, `${forged}.${sig}`), 401);
  });

  it("rejects an expired token with a message telling the user to sign in again", async () => {
    // Mint by hand so we can backdate the expiry.
    const encoder = new TextEncoder();
    const payloadJson = JSON.stringify({ sub: STEAMID, exp: Math.floor(Date.now() / 1000) - 60 });
    const b64 = (bytes) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const payload = b64(encoder.encode(payloadJson));
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = b64(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
    await expectStatus(verifyToken(env, `${payload}.${sig}`), 401, /expired/i);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintToken({ SESSION_SECRET: "some-other-secret" }, STEAMID);
    await expectStatus(verifyToken(env, token), 401);
  });

  it.each([
    ["a single segment", "garbage"],
    ["an empty string", ""],
    ["undefined", undefined],
  ])("rejects %s as malformed", async (_label, value) => {
    await expectStatus(verifyToken(env, value), 401, /Malformed/);
  });

  it("rejects non-base64 junk with a 401 rather than leaking a decode error", async () => {
    // Regression: atob() throws on invalid input, which used to surface as a 500.
    await expectStatus(verifyToken(env, "mock.token"), 401, /Invalid session token/);
  });

  it("fails loudly when SESSION_SECRET is not configured", async () => {
    await expectStatus(verifyToken({}, "a.b"), 500, /SESSION_SECRET/);
  });
});

describe("requireUser", () => {
  it("extracts the SteamID from a Bearer header", async () => {
    const token = await mintToken(env, STEAMID);
    await expect(requireUser(authed(token), env)).resolves.toBe(STEAMID);
  });

  it("accepts a lowercase 'bearer' scheme", async () => {
    const token = await mintToken(env, STEAMID);
    const request = new Request("https://api.example/api/me", {
      headers: { Authorization: `bearer ${token}` },
    });
    await expect(requireUser(request, env)).resolves.toBe(STEAMID);
  });

  it("rejects a request with no Authorization header", async () => {
    await expectStatus(requireUser(new Request("https://api.example/api/me"), env), 401);
  });

  it("rejects a non-Bearer scheme", async () => {
    const request = new Request("https://api.example/api/me", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    await expectStatus(requireUser(request, env), 401);
  });
});
