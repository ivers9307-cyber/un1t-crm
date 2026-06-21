# Win-back nudge — design spec

**Date:** 2026-06-21
**Status:** approved (brainstorm), ready for implementation plan
**Slice:** First of the two remaining **Tier-2** items from [[hr-platform-product-audit]] (the other = member progress dashboard). The audit's named "no win-back nudges" gap.
**Repos:** `un1t-crm` (cron + pure detector + push builder + migration) + `champ-app` (byte-synced `customer-notifications.js` + the `winback` deep-link case). Reuses the engagement-loop infra wholesale.

## 1. Goal
Re-engage members whose **HR-class attendance is dropping** with an in-app push nudge, before they fully lapse — the retention back-half of the engagement loop (streak-at-risk catches the about-to-break end; win-back catches the slowing-down end).

## 2. Locked decisions (brainstorm)
- **Shape:** in-app push (a new daily cron, sibling of `notify-streak-at-risk`). Reaches app-linked members with a push token — same reach gate as the rest of the loop (lands as adoption grows). Off-app channels (WhatsApp/email) + an operator radar are explicitly OUT of this slice.
- **Trigger:** **personalized frequency drop** — recent attendance rate meaningfully below the member's OWN baseline (not a fixed lapse window).
- **Cadence:** at most **one win-back per member per ~month**.

## 3. The detector — `attendanceDrop(sessions, nowMs, config)` (pure, byte-synced in `customer-notifications.js`, unit-tested)
Given a member's ended `heart_rate_sessions` (each `{ started_at }`) over the last ~84 days:
- **baselineRate** = sessions/week in the prior window `[nowMs-84d, nowMs-14d)` (≈10 weeks = their "normal").
- **recentRate** = sessions/week in `[nowMs-14d, nowMs)` (last 2 weeks).
- **Returns "dropping"** (truthy) iff ALL hold:
  1. **Was a regular:** `baselineRate >= MIN_BASELINE_PER_WEEK` (default **1.0/wk** → ≥~10 sessions in the baseline window). Naturally excludes trials/one-offs (they never build a sustained rate).
  2. **Meaningful drop:** `recentRate <= DROP_FRACTION * baselineRate` (default **0.5**).
  3. **Still current, not long-gone:** at least 1 session in the last `STILL_CURRENT_DAYS` (default **42d**) — this is a *slowdown*, not someone who left months ago (that's a different reactivation cohort, out of scope).
- All thresholds are hardcoded constants in the cron for v1 (operator-tunable later, like the tiers target). Return shape includes the rates so the cron can log/personalise (e.g. `{ dropping: true, baselineRate, recentRate }`).
- Pure + deterministic (takes `nowMs`); no IO.

## 4. Push — `buildWinbackPush({ ... })` (pure, byte-synced)
Returns `{ title, body, data: { type: 'winback' } }`, warm + low-pressure copy, e.g. title "We've missed you 👋", body "Fancy getting back in this week?". `data.type: 'winback'` deep-links to the home dashboard (add the `winback` case to `mobile/app/_layout.jsx`).

## 5. Cron — `GET /api/cron/notify-winback` (mirror `notify-streak-at-risk`)
Daily, `CRON_SECRET`-gated, `maxDuration=300`, stamps heartbeat, paginated reads:
1. **Candidates** = contacts with ≥1 ended HR session in the last ~84 days (paginate `heart_rate_sessions`, distinct `contact_id`).
2. **Load** each candidate's ended sessions over the last 84 days (batched `.in()` chunks), group by contact.
3. Run `attendanceDrop(...)` per candidate → the dropping set.
4. Keep only **reachable** (has a `champ_push_tokens` row).
5. **Idempotent insert** into `customer_engagement_nudges` `{ contact_id, type: 'winback', dedup_key: <YYYY-MM> }` → only push if the insert succeeded (not already nudged this month) → `sendCustomerPush(db, cid, buildWinbackPush(...))`, best-effort (swallow push errors).

## 6. Migration (un1t-crm/supabase/migrations)
One migration: widen the `customer_engagement_nudges.type` CHECK to add `'winback'` (currently `streak_at_risk`/`goal_complete`/`tier_up`/`reaction`), and INSERT the `notify-winback` `cron_heartbeats` row (expected_interval 86400, grace 7200). Applied to prod (controller).

## 7. vercel.json
Add `{ "path": "/api/cron/notify-winback", "schedule": "0 10 * * *" }` (daily 10:00 UTC — offset from streak-at-risk's 11:00 so they don't contend).

## 8. champ-app
Byte-sync the updated `customer-notifications.js` (`attendanceDrop` + `buildWinbackPush`) into `champ-app/shared/` (it's already a byte-sync pair). Add `case 'winback':` → home in `mobile/app/_layout.jsx`. (No new native dep → OTA-able.)

## 9. Testing
`attendanceDrop`: dropping (regular → recent half); not-dropping (steady); was-not-a-regular (baseline below MIN → never fires); long-gone (no session in 42d → excluded); recent==baseline; empty sessions; boundary windows (DST-agnostic since it's pure ms math). `buildWinbackPush` shape + `data.type`.

## 10. Out of scope (v1)
Off-app outreach (WhatsApp/email), operator radar/cohort, operator-tunable thresholds, reactivation of long-gone members.

## 11. Phasing (for the plan)
1. Pure `attendanceDrop` + `buildWinbackPush` + tests (un1t-crm `customer-notifications.js`); migration (CHECK + heartbeat).
2. `notify-winback` cron + `vercel.json` (mirror streak-at-risk).
3. Byte-sync `customer-notifications.js` → champ-app + `winback` deep-link case.
