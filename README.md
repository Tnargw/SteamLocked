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
| `GET /api/leaderboard?limit=`            | opt  | Public board; adds your own rank if signed in |
| `GET /api/me`                            | ✔    | Profile                                   |
| `GET /api/me/games`                      | ✔    | Owned games                               |
| `GET /api/me/state`                      | ✔    | All task progress for the player          |
| `GET /api/me/settings`                   | ✔    | Leaderboard visibility                    |
| `POST /api/me/settings`                  | ✔    | `{"listed": bool}`                        |
| `GET /api/games/:appid/achievements`     | ✔    | Player state + schema + global rarity      |
| `POST /api/games/:appid/roll?difficulty=`| ✔    | Rolls and claims the active slot          |
| `POST /api/games/:appid/complete`        | ✔    | Verifies against Steam, then banks it     |
| `POST /api/games/:appid/skip`            | ✔    | Drops the task and counts a skip          |

Difficulty tiers come from global unlock percentages: **easy** ≥50%,
**medium** 20–50%, **hard** 5–20%, **insane** <5%.

## Task state

Progress lives in **Cloudflare D1**, keyed by SteamID, so it follows a player
between devices. Three tables: `active_tasks`, `completed_tasks`, `game_skips`
(see `backend/migrations/`).

Two rules are enforced by the schema rather than by application code:

- `active_tasks` is keyed on `(steamid, appid)`, so a game can only ever hold
  one active task. Rolling uses a conditional insert, so if two devices roll at
  the same moment exactly one wins and the other gets a `409`.
- `completed_tasks` is keyed on `(steamid, appid, achievement)`, so a retried
  request cannot credit the same achievement twice.

**The server verifies completions.** A client can ask to complete a task, but
the Worker re-checks the Steam API before banking it — otherwise anyone could
POST their way to a perfect record, which would defeat the whole premise.

## Leaderboard

Ranked by **rarity-weighted points**, not raw task count — ranking by count
alone would reward grinding easy achievements over beating hard ones:

| Tier | Global unlock rate | Points |
| ---- | ------------------ | ------ |
| Insane | under 5% | 100 |
| Hard | 5–20% | 50 |
| Medium | 20–50% | 25 |
| Easy | 50%+ | 10 |

Unrated achievements score as medium. The scoring table lives in one place
(`TIER_POINTS` in `backend/src/db.js`) and the SQL `CASE` is generated from it,
so the rule cannot drift between the query and the UI.

The board is **public** and readable signed out. Sending a token also returns
the caller's own standing, including when they rank below the visible page.

**Players are listed by default and can opt out** in Settings. Opting out hides
them from the rankings and removes their own rank; it does not touch their
progress, which keeps counting and reappears if they opt back in. Nothing is
exposed beyond public Steam identity — name, avatar, SteamID — plus the score.

Display names and avatars are cached in the `players` table, refreshed whenever
a player loads their profile, so rendering a 50-row board is one query rather
than 50 calls to `GetPlayerSummaries`.

## Animation

Four effects, all in `frontend/js/anim.js` plus a block at the end of
`style.css`. Timing logic lives in the module rather than the views so it can
be unit tested:

- **Roll reel** — cycles the *actual* candidate achievement names from the
  locked pool, decelerating (cubic easing on the frame gap) and landing on the
  winner. Runs for at least 1s even on a fast reply, or the whole thing
  flickers and reads as broken. A rejected roll stops the reel immediately.
- **Stat count-up** — the library totals tick from zero.
- **Padlock snap** — the shackle drops into the lock and the task card jolts,
  but only on the roll that created the task, never on a revisit.
- **Discard on skip** — the card desaturates the moment you press, then tumbles
  away once the *server* confirms, and the skip tally flinches red.

Two rules the code holds to:

- **`prefers-reduced-motion` disables all of it.** The information is never
  carried by the motion: under reduced motion the reel is skipped entirely, the
  numbers appear at their final value, and the roll still completes normally.
- **Compositor-only properties** — `transform` and `opacity`, so none of it
  triggers layout.

`countUp` also guards against starved animation frames: a hidden tab fires no
`requestAnimationFrame` callbacks, which would otherwise leave a stale number
on screen, so it shows the true value immediately and keeps a timeout as a
backstop.

## Local development

```bash
cd backend
cp .dev.vars.example .dev.vars   # then fill in both values
npm install
npx wrangler d1 migrations apply steamlocked --local
npm run dev                      # Worker on :8787
```

`wrangler dev` uses a *local* copy of the database. Add `--remote` only when you
deliberately want to work against production data.

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
- **Database:** `npx wrangler d1 create steamlocked`, then paste the printed
  `database_id` into `backend/wrangler.jsonc`. The deploy workflow applies
  migrations before each deploy, so the schema is never behind the code. The
  API token needs **D1: Edit** in addition to the Workers permissions.

Live API: <https://steamlocked.grant-watson.workers.dev>

## Notes

- Cloudflare counts every outbound `fetch` **and every Cache API call** as a
  subrequest, capped per invocation (50 on the Free plan). Caching therefore
  rides on `fetch`'s own `cf.cacheTtl` rather than `caches.default`: a
  read-through cache costs a `match` plus a `put` per item, which a real library
  blows through instantly. App ids are sorted before batching so a given library
  always produces the same URLs, which is what lets the edge cache hit.
- Cover art comes from `IStoreBrowseService/GetItems`, not the legacy
  `steam/apps/<id>/header.jpg` path. That path is wrong for some newer titles:
  a few 404, and some — Battlefield 6 among them — serve a blank 1.4 KB
  placeholder that loads *successfully*, so the browser never fires an error and
  the card just looks empty. GetItems is keyless and takes 200 ids per call, so
  a whole library costs a handful of requests. Apps with no store art at all
  resolve to `null` and the UI draws a generated tile from the game's initials.
- A player's **Game details** privacy must be Public for their library to load.
- Not affiliated with Valve. Game data from the Steam Web API.
