# Challenges + leaderboards — design spec

**Date:** 2026-06-20
**Status:** approved (brainstorm), ready for implementation plan
**Slice:** Slice **B** of the "challenges + tiers" initiative (slice A = tiers, shipped). Friends/social graph + friend-filtered boards are explicitly a SEPARATE later slice ("social v1").
**Repos:** `un1t-crm` (operator CRUD, public TV board + endpoint, daily cron) + `champ-app` (member Challenges screen, the member `/api/challenges`, dashboard teaser). **Cross-repo:** the PURE challenge helpers (metric / rank / phase / window / shortName) are byte-synced like `tiers.js`/`goals.js` (`un1t-crm/src/lib/challenges.js` ↔ `champ-app/shared/challenges.js`). The standings DB read+aggregate is a thin per-repo IO layer over those helpers — un1t-crm-side for the operator + TV + cron, champ-app-side (`load-challenges.js`, using champ-app's service client) for the member's own-rank view. The query duplication is consistent with the tier-status pattern.
**Related:** [[hr-platform-product-audit]] (Tier-2). Reuses the engagement-loop (`sendCustomerPush`, `customer_engagement_nudges`), the tiers work, the live-TV public-route pattern, and `achievements.sessionMetric`.

## 1. Goal

Operator-created, date-bounded **challenges** that members compete in (ranked leaderboard) or pull toward together (collective gym goal), plus an always-on **gym-wide leaderboard** — surfaced in the member app AND on the in-gym TV (the primary surface for competitive energy). The category's proven recurring-retention engine (Myzone challenges, OTF Transformation Challenge).

## 2. Context / reuse

- Per-session metrics already exist: `effort_points`, `zones_seconds` on `heart_rate_sessions`; `achievements.js sessionMetric(session, field)` extracts `effort_points`/`classes`/zone-minutes. We add a `z4plus_minutes` case `((z4+z5)/60)`.
- Public TV route pattern: `src/app/tv/[locationId]/{page.jsx,LiveTvClient.jsx}` + `/api/public/live/[locationId]` (capability = location id, no auth, polls, projects to first-name + last-initial). The challenge TV board mirrors this.
- The engagement loop: `sendCustomerPush` + `champ_push_tokens` + the deep-link switch.
- Operator CRUD pattern: races/events (`race-control.js`, `/api/races`, `RaceEventForm.jsx`).
- champ-app reads cross-member data it can't see under RLS via the **service client** (the tier-status / session-report precedent).
- Tier metals (`#e8b931`/`#c2c8ce`/`#c77b3a`) for podium ranks 1–3 (visual continuity with tiers).

## 3. Scope

**In:** operator challenge CRUD; both modes (individual-ranked + collective-goal); 3 metrics (points / classes / z4plus_minutes); auto-enrol all members at the location; compute-on-read standings; member app Challenges screen + dashboard teaser; always-on gym-wide board; **public TV board (portrait + landscape, auto-rolls top 25)**; daily notification cron (start / end-winner / collective-target).

**Out (v1):** friends/social graph + friend-filtered boards (separate "social v1" slice); leaderboard opt-out; prizes/rewards redemption; team challenges; per-challenge custom audience (auto-all only); editing a challenge's metric/window after it has started (allow name/target edits only — see §7).

## 4. Architecture

- **One unified leaderboard engine.** A challenge = `{name, mode, metric, window, target?}`. Standings are **computed on read** from `heart_rate_sessions` over the window at the location (service-role, cross-member, projected to first-name + last-initial; anonymous walk-ins excluded). No stored-standings table — gym-scale (~hundreds of sessions/month) is cheap and always fresh.
- **The gym-wide board** is the same engine with a rolling current-month + `points` window — a built-in board, not a `challenges` row.
- **Daily cron** for the date-driven events (start/end/winner/collective-target) — challenges are time-bounded, unlike the session-triggered loop.
- **TV board** is a public route that is **CSS-orientation-responsive** (`@media (orientation: portrait)`) with an optional `?orientation=portrait|landscape` override, and **auto-pages through the top 25** on a timer (no dependency on a `tv_displays` orientation column).

## 5. Data model — one migration

```
challenges (
  id uuid pk default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  name text not null,
  mode text not null check (mode in ('individual','collective')),
  metric text not null check (metric in ('points','classes','z4plus_minutes')),
  starts_on date not null,
  ends_on date not null,                  -- inclusive
  target integer,                         -- collective only; null for individual
  created_by uuid references profiles(id),
  announced_start_at timestamptz,         -- cron idempotency
  announced_end_at timestamptz,
  announced_target_at timestamptz,        -- collective target-reached
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```
Index `(location_id, ends_on)`. RLS: staff-at-location manage (`auth_is_in_location`); customers read rows at their location where `ends_on >= today` (active/upcoming definitions only); service-role writes. **No standings table.**

## 6. Engine

**Pure helpers — byte-synced `un1t-crm/src/lib/challenges.js` ↔ `champ-app/shared/challenges.js`** (like `tiers.js`), unit-tested:
- `metricValue(session, metric)` — `points`→effort_points, `classes`→1, `z4plus_minutes`→(z4+z5 seconds)/60. (Same zones extraction as `achievements.sessionMetric`.)
- `rankStandings(rows)` — sort by value desc, assign ranks with **ties sharing a rank** (1,2,2,4…).
- `challengePhase(challenge, nowMs)` → `'upcoming' | 'active' | 'ended'` from `starts_on`/`ends_on` (UTC day boundaries).
- `windowIso(challenge)` → `{ fromIso, toIso }` = `[starts_on T00:00:00Z, (ends_on+1) T00:00:00Z)`.
- `shortName(first, last)` → `"First L."` (reuse the share-card/TV convention).

IO (thin, over the pure helpers; exists per-repo — un1t-crm `src/lib/challenges-io.js` for operator/TV/cron, champ-app `src/lib/load-challenges.js` for the member's own-rank view):
- `computeStandings(db, { locationId, metric, fromIso, toIso })` — paginated read of `heart_rate_sessions` (location, `ended_at not null`, `contact_id not null`, started_at in window) joined to `contacts(first/last)`, aggregate `metricValue` per contact → `rankStandings`. Returns ranked rows.
- `computeCollective(db, {...})` — same load, returns `{ total, target, pct }`.
- Both exclude anonymous (null-contact) sessions and project names.

## 7. Operator CRUD (un1t-crm)

- Page `src/app/challenges/` (or `settings/challenges`) — list + create/edit/end form (name, mode, metric, `starts_on`/`ends_on`, `target` when collective). Mirrors `RaceEventForm`.
- API `/api/challenges` (POST/GET) + `/api/challenges/[id]` (PUT/DELETE) — manager+ at the location. After a challenge **starts**, only `name` + `target` are editable (metric/window/mode lock — they'd invalidate standings/announcements).
- New web permission `challenges` (operator-web-only → add to `WEB_ONLY_OK` in the parity linter; no mobile counterpart).

## 8. Member surfaces (champ-app)

- `GET /api/challenges` — active + upcoming challenges at the member's location + the gym board. Standings computed **server-side via the service client** (cross-member) and projected; returns each challenge's top-N (e.g. top 10) + the member's own `{rank, value}`. (Mirrors `/api/tier-status` skeleton: getUser → contact → service client.)
- **Challenges screen** (`mobile/app/...` + web `src/app/challenges/`): list of active challenges (ranked → leaderboard with the member's row highlighted; collective → progress bar) + the gym board; tap for detail. Web + native.
- **Dashboard teaser card**: the top active challenge (member's rank or the collective %) on the home dashboard, linking to the screen.

## 9. Gym-wide board

The unified engine with `{ metric: 'points', window: current UTC month }`, mode individual. Exposed in the member API + screen + (optionally) the TV. No `challenges` row.

## 10. TV board (un1t-crm public route)

- Route `src/app/tv/[locationId]/challenges/` (child of the existing `/tv/[locationId]` — no slug conflict) + `GET /api/public/challenges/[locationId]` (public, capability = location id; returns the active challenge(s) — top **25** projected + collective `{total,target,pct}`; the gym board if no active challenge). Polls (~every 30–60s; standings don't move fast).
- Client (`ChallengeTvClient.jsx`): **auto-pages through the top 25** (page size ~8, ~2.6s/page, looping) with a page indicator; **CSS-orientation-responsive** (portrait = taller list/more rows; landscape = wide) + `?orientation=` override. Podium ranks 1–3 in tier metals. Collective challenges render the big progress bar instead of the list. Black kiosk styling like `LiveTvClient`.
- Privacy: first-name + last-initial; anonymous excluded.

## 11. Notifications — daily cron `run-challenge-events` + loop

`GET /api/cron/run-challenge-events` (daily, CRON_SECRET, maxDuration 300, heartbeat row + `vercel.json`):
- **Start:** challenges with `starts_on == today` AND `announced_start_at IS NULL` → push "New challenge: {name} — you're in" to app-linked members at the location → stamp `announced_start_at`.
- **End/winner:** challenges with `ends_on < today` AND `announced_end_at IS NULL` → compute final standings → individual: push the winner + each member's finish ("{name} winner: {first L.} · you finished #N"); collective: "We hit {target}!" or "We reached {pct}%" → stamp `announced_end_at`.
- **Collective target:** active collective challenges where `computeCollective.total >= target` AND `announced_target_at IS NULL` → celebrate → stamp.
- Push `data.type`: `challenge` → deep-link to the Challenges screen (add the case to `mobile/app/_layout.jsx`).

## 12. Privacy

First-name + last-initial everywhere (TV, app, pushes); anonymous walk-ins excluded; all cross-member standings computed server-side (service client) — customer RLS never used for leaderboards. Consistent with the live TV + share cards.

## 13. Testing (pure, per repo style)

- `metricValue` (points/classes/z4plus; missing zones); `rankStandings` (desc, ties share rank, empty); `challengePhase` (upcoming/active/ended boundaries, TZ sweep); `windowIso`; `shortName`; collective `pct` (clamp, target 0).
- TV roll paging (page count, wrap) if extracted as a pure helper.

## 14. Out of scope (v1)

Friends/social graph + friend boards (social v1); leaderboard opt-out; prizes/rewards; team challenges; per-challenge custom audience; post-start metric/window edits.

## 15. Suggested phasing (for the plan)

1. **Engine + table** — `challenges.js` (pure + `computeStandings`/`computeCollective`) + migration + tests. (+ `z4plus_minutes` in the metric extractor.)
2. **Operator CRUD** — page + API + `challenges` permission.
3. **Member API + screen** — `GET /api/challenges` + champ-app Challenges screen (web + native) + dashboard teaser.
4. **TV board** — public route + `/api/public/challenges/[locationId]` + `ChallengeTvClient` (rolling, portrait+landscape).
5. **Notifications cron** — `run-challenge-events` + heartbeat + `vercel.json` + the `challenge` deep-link case.

Each phase is independently shippable; the gym-board (§9) falls out of phase 1's engine and surfaces in 3/4.
