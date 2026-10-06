# SteamLocked

An achievement challenge tracker. Sign in through Steam, pick a game, roll a
random achievement you haven't earned, and it stays locked in until Steam itself
confirms the unlock.

## Layout

| Path        | What                                              | Deploys to         |
| ----------- | ------------------------------------------------- | ------------------ |
| `frontend/` | Static site — vanilla ES modules, **no build step** | GitHub Pages       |
| `backend/`  | Cloudflare Worker — auth, Steam data, D1           | Cloudflare Workers |

`backend/src/`: `index.js` (router) · `auth.js` (Steam OpenID + session tokens) ·
`steam.js` (Steam API client) · `db.js` (D1) · `http.js` (CORS, errors).

`frontend/js/`: `app.js` (views + routing) · `api.js` (client) · `store.js`
(task state) · `sort.js` · `anim.js` · `art.js`.

## Commands

```bash
cd backend  && npm test     # 156 tests, run inside workerd
cd frontend && npm test     # 103 tests, happy-dom

cd backend && npm run dev                                  # Worker on :8787
cd frontend && python -m http.server 5173                  # site on :5173
cd backend && npx wrangler d1 migrations apply steamlocked --local
```

Secrets for local dev go in `backend/.dev.vars` (gitignored) — see
`.dev.vars.example`. Without `STEAM_API_KEY` the Steam-backed routes fail, but
`/api/steam/trending` and the whole frontend still work.

## Gotchas

These are all things that look like bugs and aren't. Most cost an hour to
rediscover.

**Never run `wrangler d1 execute --local` while `wrangler dev` is running.** Both
processes grab the same local SQLite file and the Worker hangs on every request
with no error. Stop dev first.

**`compatibility_date` in `wrangler.jsonc` must stay at or below the date the
pinned workerd supports.** Vitest runs tests inside workerd and refuses to start
if the date is ahead of it. Currently `2026-08-01`.

**Cloudflare counts every outbound `fetch` *and* every Cache API call as a
subrequest**, capped per invocation (50 on the Free plan). Per-item caching
therefore rides on `fetch`'s own `cf.cacheTtl` — a read-through cache costs a
`match` plus a `put` *per item*, which a real library blows through instantly.
The one surviving `caches.default` use is `cached()` wrapping the whole
`trending` result, where a hit replaces ~15 subrequests with 1.
`backend/test/subrequests.test.js` guards the budget.

**Steam's legacy art path lies.** `cdn.cloudflare.steamstatic.com/steam/apps/<id>/header.jpg`
returns a blank 1.4 KB placeholder with a **200 status** for some newer titles,
and 404s for others. Always go through `resolveArt()` in `steam.js`, which reads
the real hashed URL from `IStoreBrowseService/GetItems`.

**`npm install` needs `--legacy-peer-deps` locally** — npm 10.9.2 has an arborist
bug resolving vitest's peer graph. `npm ci` works without it, so CI is unaffected.

**Several `wrangler dev` instances can end up fighting over port 8787** after a
crash, which produces nondeterministic responses. Check with
`netstat -ano | grep 8787` and kill the whole tree before restarting.

**`<main>` also carries `.wrap`**, whose `padding` shorthand zeroes the block
sides. Vertical padding on it needs matching specificity (`main.wrap`), or it
silently does nothing.

## Conventions

- **The server owns the rules.** A client can ask to complete a task, but the
  Worker re-checks the Steam API before banking it. Never add a path that trusts
  the client's word for a completion.
- **The one-task-per-game rule is enforced by the schema**, not application code:
  `active_tasks` is keyed on `(steamid, appid)` so a game can only hold one task;
  `completed_tasks` is keyed on `(steamid, appid, achievement)` so a retry can't
  double-credit.
- **Tests stub outbound fetch and throw on anything un-stubbed**, so a test can
  never quietly hit live Steam. Keep it that way.
- **Animations defer to `prefers-reduced-motion`** and use `transform`/`opacity`
  only. Motion never carries information.
- Frontend has no build step and no framework. Keep it that way unless there's a
  real reason.

## Deploying

Push to `main`. Path-filtered workflows run the test suite first and only deploy
if it's green; the backend workflow applies D1 migrations before the Worker goes
out. Required GitHub secrets: `CLOUDFLARE_API_TOKEN` (needs **D1: Edit** as well
as Workers), `CLOUDFLARE_ACCOUNT_ID`, `STEAM_API_KEY`, `SESSION_SECRET`.

Live site: <https://tnargw.github.io/SteamLocked/>
Live API: <https://steamlocked.grant-watson.workers.dev>

## Known limitations

Unobtainable and DLC-gated achievements can still be rolled — neither is
filtered yet. Both are surfaced honestly on the `#/how-it-works` page.
