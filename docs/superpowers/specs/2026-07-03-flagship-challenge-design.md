# Flagship transformation challenge — design

**Date:** 2026-07-03 · **Approved by:** Richard (chat) · **Sub-project 3 of 3** of the Pulse engagement roadmap.

## Goal
Turn a normal operator-created challenge into a **flagship transformation challenge** by ticking one flag — which switches on: an **InBody transformation bookend** (your body-comp change over the challenge), a **challenge "Wrapped" finisher** story, and **consistency + cohort-fair scoring**. Reuse-first: most parts already shipped.

## Decisions (Richard, this session)
- **Operator-flagged flagship** (not auto-cadence): a `is_flagship` flag on a normal challenge.
- Build: **InBody bookend**, **challenge Wrapped**, **consistency + cohort scoring**. **WhatsApp cohort group DEFERRED.**
- Flagship = an **individual** challenge; consistency-scored (metric `classes` = the mig-347 class-linked + device-backed attendance), so beginner-fair, and **sub-project 2's cohort scope already applies**.

## Reuse map (verified on current main)
- Challenge create: `un1t-crm src/components/ChallengeForm.jsx` + `POST /api/challenges` (`CreateSchema`); GET `challenges.select('*')` carries new columns free.
- InBody: `champ-app mobile/app/coaching/inbody.jsx` (inline delta logic + `METRICS` [weight/muscle/body-fat, `betterWhenLower`], reads `inbody_scans`). No shared helper yet → extract one.
- Wrapped: `champ-app mobile/app/wrapped/month.jsx` (+ `sessions/[id]/wrapped.jsx`) — count-up hero, stat tiles, confetti, reduce-motion.
- Challenges surface: `champ-app mobile/app/challenges.jsx` (`ChallengesScreen`) + `src/lib/load-challenges.js` (challenge_standings RPC) + Compete tab.

## Architecture

### un1t-crm (small)
- **mig 358** — `alter table challenges add column is_flagship boolean not null default false`. Additive, reversible. Applied via Supabase MCP before merge; `get_advisors` after.
- `POST /api/challenges` `CreateSchema`: add `is_flagship: z.boolean().optional().default(false)`; a flagship must be `mode='individual'` (refine); include in the `insert`. `PATCH /api/challenges/[id]` likewise if it supports edits.
- `ChallengeForm.jsx`: a "Flagship transformation challenge" checkbox (only enabled for individual mode; helper text: switches on the InBody bookend + Wrapped finisher in the app). Light-theme chip/label conventions.
- No read change — GET already `select('*')`, so `is_flagship` reaches the app.

### champ-app — pure helper (extract)
- `shared/inbody.js` (+ test): move the `METRICS` defs out of `coaching/inbody.jsx` into here (single source), and add `inbodyBookend(scans, { fromMs, toMs })` → `{ baseline, latest, metrics: [{ key,label,unit,from,to,delta,improved }], score }` or `null` when fewer than 2 usable scans span the window. Baseline = latest scan **on/before** the window start, else the earliest scan **within** the window; latest = the latest scan on/before `toMs`. `improved` uses `betterWhenLower`. Pure, timezone-safe (ms compares). Refactor `coaching/inbody.jsx` to import `METRICS` from here (behaviour-preserving; keeps one source).

### champ-app — InBody bookend card
- `mobile/components/ChallengeTransformationCard.jsx` — on a **flagship** challenge's surface in the Compete/Challenges screen: reads `inbody_scans` via the member's RLS-scoped client (same select as `coaching/inbody.jsx`), computes `inbodyBookend(scans, challenge window)`, renders muscle↑/fat↓/score deltas (ember on improvement). **Private** (own data only). Gated on `is_flagship` + a non-null bookend; otherwise a one-line "Get scanned on the InBody to track your transformation" (NO booking language). Tapping "full trends" routes to the existing `coaching/inbody`.

### champ-app — challenge Wrapped finisher
- `mobile/app/wrapped/challenge/[id].jsx` — a story screen reusing the `wrapped/month.jsx` pattern (extract the shared story primitives — count-up hero, stat tile, confetti/reduce-motion — into `mobile/components/wrapped/` if cleanly shareable; otherwise mirror). Stats (own only): classes attended in the window, points, cohort/overall rank (from the standings the app already loads), InBody delta (if any), a **finisher badge** (hit target / completed). Data via a small loader (reuse `load-challenges` + the cohort/standings the Compete screen has).
- **Trigger (in-app, no cron change):** on the Compete screen, when a **flagship** challenge has **ended within the last N days** and the member **participated** (has a standings row / sessions in window), show a "See your Challenge Wrapped ›" entry that opens the story. (A push on flagship end via `run-challenge-events` is a later enhancement, out of scope.)

### Consistency + cohort (mostly wiring)
- Flagship is individual + `metric='classes'` → consistency. The Compete → Challenges `New members` cohort scope (sub-project 2) already applies to individual challenges, so a beginner sees their cohort board on the flagship. Add a small **"Flagship"** badge on the challenge card so it reads as the marquee event.

## Privacy / safety
- InBody bookend + Wrapped are **own-stats-only**, never social/ranked-to-others beyond the existing masked standings. `inbody_scans` read via the member's RLS-scoped self client (never service). No booking/reserve/pause/cancel copy. No raw HR beyond the existing masked board.

## Testing
- Pure `shared/inbody.js`: baseline selection (scan before window vs first in window), delta + `improved` direction, `<2 scans` → null, unit/dp. `metricValue`/rank reuse is unchanged.
- un1t-crm: `CreateSchema` accepts/validates `is_flagship` (+ the individual-only refine); insert carries it. Full CI mirror + `next build`.
- champ-app: helper + `next lint` + bundle export; no dep/lockfile change.

## Out of scope (deferred)
WhatsApp cohort group; auto-cadence/recurrence; challenge-end push for the Wrapped; TV-board flagship treatment; any new scoring metric or challenge mode.
