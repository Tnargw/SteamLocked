/**
 * SteamLocked Worker.
 *
 * Static files in ./public are served automatically by the `assets` binding
 * configured in wrangler.jsonc. This handler only runs for requests that don't
 * match a static asset — put API routes / dynamic logic here as the project grows.
 */

// Origins allowed to call this Worker from browser JavaScript.
const ALLOWED_ORIGINS = new Set([
  "https://tnargw.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  return {};
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true }, { headers: cors });
    }

    // Fall back to the static site (index.html) for everything else.
    return env.ASSETS.fetch(request);
  },
};
