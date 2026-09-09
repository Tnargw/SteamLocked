/**
 * SteamLocked backend API (Cloudflare Worker).
 *
 * The frontend is a static site on GitHub Pages; this Worker handles all
 * dynamic work — fetching and shaping Steam data for that frontend.
 * Add routes under /api/* as features land.
 */

// Origins allowed to call this API from browser JavaScript.
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

function json(data, init = {}, cors = {}) {
  return Response.json(data, {
    ...init,
    headers: { ...cors, ...(init.headers || {}) },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    switch (url.pathname) {
      case "/":
        return json({ service: "steamlocked-api", ok: true }, {}, cors);
      case "/health":
        return json({ ok: true }, {}, cors);
    }

    // TODO: /api/steam/* routes for Steam data.

    return json({ error: "Not found" }, { status: 404 }, cors);
  },
};
