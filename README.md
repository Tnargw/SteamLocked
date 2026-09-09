# SteamLocked

A Taskman-style challenge tracker for any Steam game: roll a task, complete it, unlock the next.

## Layout

| Path        | What                                             | Deploys to                                  |
| ----------- | ------------------------------------------------ | ------------------------------------------- |
| `frontend/` | Static site — HTML/CSS/JS                        | GitHub Pages (`deploy-frontend.yml`)        |
| `backend/`  | Cloudflare Worker — Steam data API for the frontend | Cloudflare Workers (`deploy-backend.yml`) |

Each workflow is path-filtered, so a change under `frontend/` never redeploys the
Worker and vice versa.

## Backend (local)

```bash
cd backend
npm install
npm run dev      # wrangler dev
npm run deploy    # manual deploy
```

Live: https://steamlocked.grant-watson.workers.dev

## Deploy setup (one-time)

- **Frontend:** repo Settings → Pages → Source → **GitHub Actions**.
- **Backend:** repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
