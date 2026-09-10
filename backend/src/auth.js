/**
 * "Sign in through Steam" — OpenID 2.0.
 *
 * Steam has no OAuth. The OpenID flow sends the player to Steam's own login
 * page; we never see their credentials. Steam redirects back with a claimed
 * identity that we verify directly with Steam, yielding only a SteamID64.
 *
 * That SteamID is then wrapped in an HMAC-signed token the frontend keeps in
 * localStorage and sends as `Authorization: Bearer <token>`. A token is used
 * instead of a cookie because the site and API live on different origins, and
 * browsers increasingly refuse third-party cookies.
 */

import { ApiError, safeReturnUrl } from "./http.js";

const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const encoder = new TextEncoder();

function b64urlEncode(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function requireSecret(env) {
  if (!env.SESSION_SECRET) {
    throw new ApiError(500, "SESSION_SECRET is not configured on this Worker");
  }
  return env.SESSION_SECRET;
}

export async function mintToken(env, steamid) {
  const key = await hmacKey(requireSecret(env));
  const payload = b64urlEncode(
    encoder.encode(
      JSON.stringify({ sub: steamid, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }),
    ),
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${b64urlEncode(sig)}`;
}

/** Returns the SteamID64 carried by a valid, unexpired token. */
export async function verifyToken(env, token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) throw new ApiError(401, "Malformed session token");

  const key = await hmacKey(requireSecret(env));

  // Anything malformed in here is a bad token, not a server fault — the
  // base64 decode throws on junk input, so it has to be guarded too.
  let ok;
  let claims;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), encoder.encode(payload));
    if (ok) claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    throw new ApiError(401, "Invalid session token");
  }
  if (!ok || !claims) throw new ApiError(401, "Invalid session token");
  if (!claims?.sub || claims.exp * 1000 < Date.now()) {
    throw new ApiError(401, "Session expired — sign in again");
  }
  return claims.sub;
}

/** Pulls the SteamID out of the Authorization header, or throws 401. */
export async function requireUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "Sign in through Steam to use this");
  return verifyToken(env, match[1]);
}

/** Step 1: bounce the player to Steam's login page. */
export function beginLogin(request, url, workerOrigin) {
  const returnTo = safeReturnUrl(url.searchParams.get("return"), null);
  if (!returnTo) throw new ApiError(400, "Missing or disallowed `return` URL");

  const callback = new URL("/auth/steam/callback", workerOrigin);
  callback.searchParams.set("return", returnTo);

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": callback.toString(),
    "openid.realm": workerOrigin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  return Response.redirect(`${STEAM_OPENID}?${params}`, 302);
}

/**
 * Step 2: Steam sent the player back. Ask Steam to confirm the assertion is
 * genuine before trusting the SteamID in it, then hand a token to the frontend.
 */
export async function completeLogin(request, url, env) {
  const returnTo = safeReturnUrl(url.searchParams.get("return"), null);
  if (!returnTo) throw new ApiError(400, "Missing or disallowed `return` URL");

  const claimedId = url.searchParams.get("openid.claimed_id") || "";
  const steamid = claimedId.match(CLAIMED_ID_RE)?.[1];
  if (!steamid) return redirectWithError(returnTo, "steam_denied");

  // Echo every openid.* param back to Steam with mode=check_authentication.
  const body = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k.startsWith("openid.")) body.set(k, v);
  }
  body.set("openid.mode", "check_authentication");

  const res = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok || !/is_valid\s*:\s*true/.test(text)) {
    return redirectWithError(returnTo, "verification_failed");
  }

  const token = await mintToken(env, steamid);
  const dest = new URL(returnTo);
  // Fragment, not query: keeps the token out of Referer headers and server logs.
  dest.hash = `token=${encodeURIComponent(token)}`;
  return Response.redirect(dest.toString(), 302);
}

function redirectWithError(returnTo, code) {
  const dest = new URL(returnTo);
  dest.hash = `error=${code}`;
  return Response.redirect(dest.toString(), 302);
}
