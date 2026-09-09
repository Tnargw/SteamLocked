/**
 * SteamLocked Worker.
 *
 * Static files in ./public are served automatically by the `assets` binding
 * configured in wrangler.jsonc. This handler only runs for requests that don't
 * match a static asset — put API routes / dynamic logic here as the project grows.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // Fall back to the static site (index.html) for everything else.
    return env.ASSETS.fetch(request);
  },
};
