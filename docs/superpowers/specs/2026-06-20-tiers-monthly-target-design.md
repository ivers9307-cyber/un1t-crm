# Monthly target + status tiers — design spec

**Date:** 2026-06-20
**Status:** approved (brainstorm), ready for implementation plan
**Slice:** This is slice **A** of the "challenges + tiers" initiative. Slice B (operator-created challenges + persistent leaderboards) is a separate later spec.
**Repos:** `un1t-crm` (target setting, engine, push) + `champ-app` (dashboard tier card, tier-status API).
**Related:** [[hr-platform-product-audit]] (Tier-2, the engagement layer), the engagement-loop feature (this reuses its session-end hook + `sendCustomerPush` + `customer_engagement_nudges`), [[champ-app-design-bar]] (dark UN1T identity, metal tier colours).

## 1. Goal

Give members an always-on progression: a shared **monthly UN1T-Points target** and a **status-tier/belt ladder** that climbs as they hit that target month after month. Rewards the retention behaviour that matters (show up, hit your target every month) and gives members a reason to open the app. No operator setup beyond one number; works for every member.

## 2. Context / reuse

- **UN1T Points** are computed at session-end into `heart_rate_sessions.effort_points` (`heart-rate.js`).
- The engagement loop (just shipped) gives us the pattern this extends: a best-effort block in `endSession` (`live-class.js`), `sendCustomerPush` (`customer-push.js`), pure builders in `customer-notifications.js`, idempotency via `customer_engagement_nudges`, and `periodKey('month', nowMs)` → `'YYYY-MM'`.
- `goals.js` already has a `monthly_points` *personal goal* — left untouched; the gym target is a separate shared benchmark.
- champ-app reads location settings via a **service client** (the Slice-3 precedent: `loadSessionReport(supabase, id, {serviceSupabase})`) because customer RLS can't read `locations`.

## 3. Scope

**In:** gym-wide monthly target (operator number); cumulative months-hit tier ladder (no demotion); event-driven banking at session-end; member dashboard tier card (web + native) + a session-report line; target-hit + tier-up push.

**Out (v1):** demotion; any cron; end-of-month email/summary; TV tier display; operator-editable ladder (names/thresholds are code constants); gym-wide tier leaderboard; challenges (slice B).

## 4. Architecture — event-driven banking (Approach A)

The instant a member's **this-month** UN1T Points cross the gym target, we bank that month immediately (in the `endSession` best-effort block), recompute their tier, and fire the push — no cron. Tier is **derived** from the count of banked months (no mutable tier column). Mid-month progress is computed live. Tiers never demote, so there is nothing to evaluate at month-end → no cron needed.

## 5. Tier ladder (code constants, byte-synced)

New shared module `tiers.js` — byte-identical in `un1t-crm/src/lib/tiers.js` and `champ-app/shared/tiers.js` (same convention as `goals.js`/`hr-analytics.js`; champ-app web re-exports via `src/lib`, native imports from `shared/`).

```js
export const TIERS = [
  { slug: 'bronze',   name: 'Bronze',   months: 1,  color: '#c77b3a' },
  { slug: 'silver',   name: 'Silver',   months: 3,  color: '#c2c8ce' },
  { slug: 'gold',     name: 'Gold',     months: 6,  color: '#e8b931' },
  { slug: 'platinum', name: 'Platinum', months: 12, color: '#cfe2ea' },
  { slug: 'elite',    name: 'Elite',    months: 24, color: '#ff5a1f' },
]
// tierForMonths(n): highest TIERS entry with months <= n, else null (0 months = "not yet ranked")
// nextTier(n): the first TIERS entry with months > n, else null (at Elite)
```

`tierForMonths`/`nextTier` are pure + unit-tested. un1t-crm uses them for the push (tier name); champ-app uses them for the badge (name + colour).

## 6. Data model

- **Setting:** `locations.settings.monthly_points_target` (integer; **feature is off when unset/0** — no target means no banking, no tier card). No migration (JSONB).
- **New table (1 migration):**
```
member_monthly_targets (
  id uuid pk default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  period_month text not null,          -- 'YYYY-MM' (UTC)
  points integer not null,             -- member's points that month at bank time
  target integer not null,             -- gym target at bank time (locks the "hit" against later target edits)
  banked_at timestamptz not null default now(),
  unique (contact_id, period_month)
)
```
Only **hit** months get a row (no "missed" rows — no demotion). `months_hit = count(rows)`; tier = `tierForMonths(months_hit)`. RLS: customer self-read own (`contact_id = private.auth_contact_id()`) + staff-at-location read (mirror `customer_engagement_nudges`); service-role write. Index `(contact_id)`.
- **Push idempotency:** reuse `customer_engagement_nudges` — `tier_up` (dedup_key = tier slug). Target-hit idempotency is the `member_monthly_targets` unique constraint itself (a fresh insert = the moment to notify), so no nudge row for target-hit.

## 7. Engine — session-end (extends `endSession`)

A new best-effort `try/catch` block after the goal block (gated on `session.contact_id`; never blocks finalisation):

1. Read `target = locations.settings.monthly_points_target` for the session's location (service client; the route already uses the service client). If falsy → return (feature off).
2. `month = periodKey('month', nowMs)`. Compute `monthPoints` = sum of `effort_points` for this contact for sessions in this calendar month (reuse the goal block's this-month `gSessions`, or its own query).
3. If `monthPoints < target` → return.
4. Insert `member_monthly_targets {contact_id, location_id, period_month: month, points: monthPoints, target}` with `.select('id')`. On unique conflict / no row → already banked this month → return (idempotent).
5. Fresh bank → recompute `monthsHit = count(member_monthly_targets where contact_id)`. `before = monthsHit - 1`. If `tierForMonths(monthsHit)` is a higher tier than `tierForMonths(before)` → **tier-up**: send `buildTierUpPush(tier)`, record `customer_engagement_nudges('tier_up', dedup_key=tier.slug)` (skip if exists). Else → **target-hit**: send `buildTargetHitPush({month, monthsHit, next})`.
   - **One push per banking:** tier-up *replaces* the target-hit push that month (a tier-up implies the target was hit).

Pure, unit-tested helpers in `customer-notifications.js`: `buildTargetHitPush`, `buildTierUpPush`. (`tierForMonths`/`nextTier` from `tiers.js`.)

## 8. Member surfaces (champ-app)

- **Tier-status loader + API.** `loadTierStatus(supabase, {serviceSupabase})` returns `{ monthsHit, tier, nextTier, monthPoints, target, periodLabel }`: member rows via RLS `supabase`; `target` via `serviceSupabase` (customer RLS can't read `locations`). Exposed as `GET /api/tier-status` (champ-app) for native; the web dashboard server-component calls the loader directly. Pure `buildTierStatus(...)` shapes the card model (byte-synced helper).
- **Dashboard `TierCard`** (web `src/app/page.jsx` + native `mobile/app/(tabs)/index.jsx`): tier badge in its metal colour (or a "Hit this month's target to earn Bronze" starter when `monthsHit === 0`), `monthsHit` + "X to {nextTier}", and the live monthly-target ring (`monthPoints / target`) with "{remaining} pts to bank {month}". Hidden entirely when `target` is unset. Matches the approved dark mock (metals per tier; ember progress ring).
- **Session report:** one line — "{remaining} pts to your {month} target" (or "{month} target hit ✓").

## 9. Operator surface (un1t-crm)

One number input — **Monthly points target** — on a location settings page (manager+; reuse the existing class-categories/HR settings page, no new permission key), persisted to `locations.settings.monthly_points_target`. Blank/0 = feature off for that location.

## 10. Notification copy

| Trigger | Title | Body |
|---|---|---|
| Target hit (no tier change) | `{Month} target hit 🎯` | `Month {N} banked — {X} to {NextTier}.` (or `Month {N} banked — your best run yet.` at Elite) |
| Tier up | `You reached {Tier} 🏆` | `{N} months hit. Keep the run going.` |

`data.type`: `monthly_target_hit` → dashboard `/`; `tier_up` → dashboard `/`. Add both cases to `mobile/app/_layout.jsx` (the deep-link switch the loop introduced).

## 11. Testing (pure, per repo style)

- `tierForMonths` / `nextTier`: 0→none, 1–2→Bronze, 3→Silver, 6→Gold, 12→Platinum, 24 & 100→Elite; `nextTier` at each step and null at Elite.
- Banking decision: crossed & unbanked → bank; already banked → skip; below target → skip.
- `buildTargetHitPush` / `buildTierUpPush`: exact copy incl. Elite (no next tier) branch.
- `buildTierStatus`: starter state (0 months), mid-tier, at-Elite; ring math; target-unset → null.
- `tiers.js` byte-sync guard (un1t-crm ↔ champ-app).

## 12. Parameters / defaults

- Ladder: Bronze 1 · Silver 3 · Gold 6 · Platinum 12 · Elite 24 (months-hit, cumulative, no demotion).
- Metal colours per §5. Monthly target: operator-set per location (no default — feature off until set).
- One push per banking (tier-up supersedes target-hit).

## 13. Risks / notes

- Reuses the load-bearing `endSession`; the tier block must stay best-effort try/catch (same contract as the achievement/goal blocks).
- `member_monthly_targets.target` snapshots the gym target at bank time so editing the target later never retroactively un-hits a banked month.
- champ-app must read `monthly_points_target` via the **service** client (customer RLS can't read `locations`) — follow the Slice-3 `{serviceSupabase}` pattern exactly.
- `tiers.js` joins `goals.js`/`hr-analytics.js` as a byte-synced cross-repo lib — edit both copies together; add the guard test.
- Dormant until an operator sets a target AND members are app-linked (same adoption gate as the rest of the platform).

## 14. Suggested phasing (for the plan)

1. `tiers.js` (both repos) + tests.
2. Migration (`member_monthly_targets`) + the operator target field.
3. Engine block in `endSession` + `buildTargetHitPush`/`buildTierUpPush` + mobile deep-link cases.
4. `loadTierStatus` + `/api/tier-status` + `buildTierStatus`.
5. Dashboard `TierCard` (web + native) + session-report line.
