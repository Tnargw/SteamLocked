# SteamLocked

A Taskman-style challenge tracker for any Steam game: roll a task, complete it, unlock the next.

Sign in through Steam, pick a game, and roll a random achievement you haven't
earned. It stays locked in as your only task for that game until Steam itself
confirms the unlock — no honour system, no cherry-picking.

## Layout

| Path        | What                                                | Deploys to                              |
| ----------- | --------------------------------------------------- | --------------------------------------- |
| `frontend/` | Static site — HTML/CSS/JS, no build step             | GitHub Pages (`deploy-frontend.yml`)    |
| `backend/`  | Cloudflare Worker — auth + Steam data                | Cloudflare Workers (`deploy-backend.yml`) |

Each workflow is path-filtered, so a change under `frontend/` never redeploys
the Worker and vice versa.

## How sign-in works

Steam has no OAuth, so SteamLocked uses **Steam OpenID 2.0**. The player logs in
on Steam's own page; we never see their credentials. Steam returns a claimed
identity, the Worker verifies it directly with Steam, and mints an HMAC-signed
token carrying only the SteamID64.

The frontend keeps that token in `localStorage` and sends it as
`Authorization: Bearer …`. A token is used rather than a cookie because the site
and the API sit on different origins, and browsers increasingly block
third-party cookies.

`return` URLs are validated against an allowlist, so the flow can't be used as
an open redirect.

## API

| Route                                    | Auth | Notes                                     |
| ---------------------------------------- | ---- | ----------------------------------------- |
| `GET /health`                            | —    | Liveness                                  |
| `GET /api/steam/trending?limit=`         | —    | Most-played chart, enriched with store data |
| `GET /auth/steam/login?return=`          | —    | Redirects to Steam                        |
| `GET /auth/steam/callback`               | —    | Verifies, redirects back with `#token=`   |
| `GET /api/me`                            | ✔    | Profile                                   |
| `GET /api/me/games`                      | ✔    | Owned games                               |
| `GET /api/games/:appid/achievements`     | ✔    | Player state + schema + global rarity      |
| `GET /api/games/:appid/roll?difficulty=` | ✔    | Random locked achievement                 |

Difficulty tiers come from global unlock percentages: **easy** ≥50%,
**medium** 20–50%, **hard** 5–20%, **insane** <5%.

## Local development

```bash
cd backend
cp .dev.vars.example .dev.vars   # then fill in both values
npm install
npm run dev                      # Worker on :8787
```

In a second terminal:

```bash
cd frontend
python -m http.server 5173       # site on :5173
```

Open <http://localhost:5173>. The frontend auto-targets `localhost:8787` when
served from localhost. Use port 5173 or 3000 — those origins are in the Worker's
CORS and redirect allowlists.

## Deploy setup (one-time)

- **Frontend:** repo Settings → Pages → Source → **GitHub Actions**.
- **Backend:** repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `STEAM_API_KEY`, and `SESSION_SECRET`. The deploy workflow pushes the last two
  to the Worker on every run.

Live API: <https://steamlocked.grant-watson.workers.dev>

## Notes

- Cover art comes from `IStoreBrowseService/GetItems`, not the legacy
  `steam/apps/<id>/header.jpg` path. That path is wrong for some newer titles:
  a few 404, and some — Battlefield 6 among them — serve a blank 1.4 KB
  placeholder that loads *successfully*, so the browser never fires an error and
  the card just looks empty. GetItems is keyless and takes 200 ids per call, so
  a whole library costs a handful of requests. Apps with no store art at all
  resolve to `null` and the UI draws a generated tile from the game's initials.
- A player's **Game details** privacy must be Public for their library to load.
- Not affiliated with Valve. Game data from the Steam Web API.
