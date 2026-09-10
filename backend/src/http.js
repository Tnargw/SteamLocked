/** Shared HTTP helpers: CORS, JSON responses, typed errors. */

// Origins allowed to call this API from browser JavaScript, and to be
// redirected back to after a Steam login. Anything not listed is rejected.
export const ALLOWED_ORIGINS = new Set([
  "https://tnargw.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  return {};
}

export function json(data, init = {}, cors = {}) {
  return Response.json(data, {
    ...init,
    headers: { ...cors, ...(init.headers || {}) },
  });
}

/** Only redirect to origins we control — blocks open-redirect abuse. */
export function safeReturnUrl(candidate, fallback) {
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    return ALLOWED_ORIGINS.has(url.origin) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

export const isSteamId64 = (v) => typeof v === "string" && /^\d{17}$/.test(v);
export const isAppId = (v) => typeof v === "string" && /^\d{1,10}$/.test(v);
