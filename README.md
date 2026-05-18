# Competition scheduler (web)

Standalone Next.js app (its own Git repo) that loads **live** Hitchkick schedule JSON through a **server-only** proxy, shows a **timeline** and plain-language schedule checks, and lets you **draft reorder** routines per day/cluster/stage bucket and **export** JSON/CSV. Nothing is written back to Hitchkick.

## Prerequisites

- Node 20+
- Hitchkick access via proxy and/or direct API (see env vars)

## Configuration

Copy `.env.example` to `.env.local` and set:

| Variable | Required | Purpose |
|----------|----------|---------|
| `HITCHKICK_PROXY_BASE` | Recommended | Base URL of your proxy (e.g. `https://…/hitchkick-proxy` without trailing path segments). The app requests `{BASE}/competition/{id}`. |
| `HITCHKICK_DIRECT_BASE` | Optional fallback | Direct Hitchkick schedule API base (path segments only—match the URL the macOS app uses for `/table`, without `/table`). |
| `HITCHKICK_API_KEY` | If using direct | API key appended as `key=` on the direct URL |
| `OPENAI_SCHEDULE_ENABLED` | Optional | Set to `1`, `true`, `yes`, or `on` to **attempt OpenAI** draft scheduling when `OPENAI_API_KEY` is set. If unset or false, **only the heuristic** runs (default). |
| `OPENAI_API_KEY` | Optional | Required for OpenAI draft attempts when `OPENAI_SCHEDULE_ENABLED` is on. Ignored for routing when AI is disabled. |
| `OPENAI_SCHEDULE_MODEL` | Optional | Overrides the default model name for draft scheduling; leave unset to use the app default in code. |
| `OPENAI_SCHEDULE_TEMPERATURE` | Optional | Sampling 0–2; default `0.15` (lower = steadier layout). |

Secrets stay on the server: **do not** prefix any secret with `NEXT_PUBLIC_*`.

Keep `.env.local` next to `package.json` and run `npm run dev` from this repository root.

If the proxy request fails, the API route tries **direct** when both `HITCHKICK_DIRECT_BASE` and `HITCHKICK_API_KEY` are set.

**Proxy returns HTTP 502:** the Lambda/API Gateway integration is failing (check CloudWatch). Until that’s fixed, set **`HITCHKICK_API_KEY`** in `.env.local` (same value the macOS app uses for direct Hitchkick requests) so the web app can load schedules without the proxy.

## Scripts

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Pick an event, review the timeline and findings, drag routines within a bucket if needed, then download:

- `schedule_findings_{id}.json` — same shape as the macOS export
- `proposed_routine_order_{id}.csv` — reflects **your** draft order (`note` column includes `user_reorder` when positions changed)

```bash
npm run build   # production build
npm run test    # Vitest (schedule parsing + analysis + draft export)
```

## Own repository

This project is meant to live in **its own** Git remote (not inside a larger monorepo):

1. Use this folder as the repo root (`git init` here if you are starting fresh).
2. **GitHub CLI (fastest):** one-time `gh auth login`, then from this folder run `./scripts/create-github-repo.sh` (optional: `./scripts/create-github-repo.sh your-repo-name`). Or create an empty repo on GitHub and run `git remote add origin …` then `git push -u origin main`.

3. Deploy with **Netlify** (or any Node host): connect the repo root; `netlify.toml` sets `npm run build` and Node 20. Copy env vars from `.env.example` into the host’s dashboard.

```bash
npm run deploy:netlify   # after `npx netlify-cli login` + `npx netlify-cli init` in this folder
```

## Netlify (dashboard)

1. **Log in** at [app.netlify.com](https://app.netlify.com) (GitHub SSO is fine).
2. **Add new site → Import an existing project → GitHub**, authorize if asked, pick **`competition-scheduler-web`** (your standalone repo).
3. **Build settings** — leave defaults; `netlify.toml` already sets:
   - **Build command:** `npm run build`
   - **Node:** 20 (`NODE_VERSION` in `netlify.toml`)
   - **Publish directory:** leave blank / auto — Netlify’s Next.js adapter sets this.
   - **Base directory:** empty (repo root *is* the app).
4. **Environment variables** — **Site configuration → Environment variables**. Add the same keys you use in `.env.local` (see **Configuration** above). Minimum for schedules to load:
   - `HITCHKICK_PROXY_BASE` — your proxy base URL (no trailing slash).
   - Optional: `HITCHKICK_DIRECT_BASE`, `HITCHKICK_API_KEY` if you use direct Hitchkick fallback.
   - Optional AI: `OPENAI_API_KEY`, `OPENAI_SCHEDULE_ASSISTANT_MODEL`, `OPENAI_SCHEDULE_ASSISTANT_TEMPERATURE`, `OPENAI_SCHEDULE_ASSISTANT_MAX_JSON_CHARS`, plus draft vars (`OPENAI_SCHEDULE_ENABLED`, `OPENAI_SCHEDULE_MODEL`, etc.) if you use `/api/schedule/build-draft` with OpenAI.  
   Use **Scopes:** at least **Production**; add **Deploy Previews** if you want previews to work the same way.
5. **Deploy site**. Open the production URL; try **`/competition/7`** (or another id from `src/lib/competitions.ts`). If the schedule API returns errors, check the deploy **Functions** logs and confirm env vars are set (no typos, values match local).

**CLI alternative:** from the repo root, `npx netlify-cli login` then `npx netlify-cli init` to link an existing site or create one; env vars are still easiest to manage in the dashboard.

## Architecture notes

- `GET /api/schedule/[competitionId]` forwards to Hitchkick (proxy first, then optional direct).
- `POST /api/schedule/build-draft` builds a **parallel-stage draft** from the registration pool using a **deterministic heuristic** by default. When **`OPENAI_SCHEDULE_ENABLED`** is truthy and **`OPENAI_API_KEY`** is set, it tries **OpenAI** first (validated JSON layout), then falls back to the heuristic. Enforces **no same studio on two stages in the same time slice** to avoid cross-stage conflicts. When turning draft slots into wall-clock times with **anchored days**, the UI applies the same **~30 minute end→start gap** between a studio’s routines on **different** stages as in schedule analysis (`cross_stage_gap_short`), so studios get time to move between floors (override via `scheduledRoutinesFromDraftSlots` options if you call it from code).
- Domain logic lives in `src/lib/schedule/` (ported from Swift: parsing, time helpers, `ScheduleAnalysisEngine` rules, proposed-order helper plus **user** order CSV builder).

## Security

Never commit `.env.local` or real API keys. Use `.env.example` as the only committed template.
