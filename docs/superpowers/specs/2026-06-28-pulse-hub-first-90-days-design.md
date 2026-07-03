# Pulse hub + first-90-days journey — design

**Date:** 2026-06-28 · **Approved by:** Richard (chat) · **Sub-project 1 of 3** (next: cohort/team leaderboards, seasonal transformation challenge)

## Goal

Move the north-star metric — **% of new members who attend 9+ classes in their first 6 weeks (~2/week)** — by making the threshold visible to the member (motivation) and actionable for coaches (intervention), plus stand up the **`/pulse` operator hub** in un1t-crm as the management home for all Pulse features.

## Hard constraints

1. **Pulse never books, pauses, or cancels** (`pulse-scope-no-booking`). The member nudge is **purely motivational — zero booking reference** (Richard's explicit choice). No copy may contain "book"/"booking"/a booking deep-link.
2. Ship **member card + CRM lane together**; per-member state also surfaces on the contact profile.
3. Nudges must respect **`contacts.push_prefs`** (mig 352) — the payload type maps to the existing **`'progress'`** channel via `shared/customer-push-channels.js`; no new pref key.
4. Compute-on-read — **no new state table**. One additive migration only (nudge-type CHECK + cron heartbeat seed).
5. Nothing merges to prod without Richard's review of the PRs.

## Architecture

CRM computes; app renders. All pace math in one pure, TDD'd lib.

### Pace model (pure: `src/lib/onboarding-journey.js`)
- Window: `joined_at` → +42 days. Target: 9 attended classes. Both per-location configurable via `locations.notification_config.categories.onboarding_pace.{window_days, target_classes}` (defaults 42/9), read like `resolveClassReminderLeadTimes`.
- `journeyStatus({ joinedAt, attendedAt[], now, config })` → `{ inWindow, dayIndex, weekIndex, attended, target, expectedByNow, status }`
  - `expectedByNow = floor((dayIndex / windowDays) * target)`
  - `completed` (attended ≥ target) · `expired` (dayIndex > windowDays) · `at_risk` (attended ≤ expected−2, or no attendance in last 10 days once dayIndex ≥ 10) · `behind` (attended < expected) · else `on_track`. Grace: days 0–6 are always `on_track` (no judging week one).
- Attendance source: `class_bookings` rows with `attended === true`, status ≠ CANCELLED, `starts_at` within the member's window. Dublin-day bucketing for "days since last attended".
- `buildOnboardingPacePush(statusRow)` — payload `data.type: 'onboarding_pace'`; warm, motivational copy variants by status; **tested to contain no booking language**.

### Data layer (`src/lib/onboarding-journey-data.js`)
- `loadJourneyLane(db, locationId, nowMs)` — members with `joined_at` in the last `window_days + 14`, paginated (1k-cap), + their in-window attended bookings → status rows sorted worst-first.
- `loadContactJourney(db, contactId, nowMs)` — single-contact version for the profile panel and `/api/me/journey`.

### Routes
- `GET /api/pulse/journey` — staff: `getCurrentUser` → `hasPermission('pulse_admin')` → `assertLocationAccess`. Returns the lane.
- `GET /api/me/journey` — customer: `resolveCustomerContact` (copy `api/me/body-metrics`), own contact only; 200 `{ journey: null }` when out-of-window (app hides the card).
- `POST /api/pulse/journey/touch` — staff logs a coach outreach on a member (writes `action_log` the way churn-radar actions do); powers "who's been contacted".
- All registered in `src/lib/openapi.js`; cron exempt-listed per `check:route-guards`.

### Nudge cron (`/api/cron/notify-onboarding-pace`)
- Daily (~10:30 UTC, offset from streak/winback crons). `CRON_SECRET` Bearer; `stampHeartbeat('notify-onboarding-pace')`.
- Selects in-window members with status `behind`/`at_risk`, app-linked with push tokens. **Max one nudge per member per week**: dedup `customer_engagement_nudges` `type='onboarding_pace'`, `dedup_key='<contact_id>:wk<weekIndex>'`.
- Sends via `sendCustomerPush` (push_prefs filter applies automatically once `'onboarding_pace'` is mapped to the `'progress'` channel in `shared/customer-push-channels.js` — mirror the mapping in champ-app's copy).

### Migration (next free number, likely 354 — verify at apply time)
- ALTER `customer_engagement_nudges` CHECK → add `'onboarding_pace'` (exact pattern of mig 323).
- Seed `cron_heartbeats` row `'notify-onboarding-pace'`. Applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj` **before merge**; `get_advisors` after.

### `/pulse` hub (un1t-crm)
- New nav entry **Pulse** → `src/app/pulse/page.js`. Permission `pulse_admin` in `shared/permissions.js` (owner/manager/head_coach default true, staff false) + `WEB_ONLY_OK` (desktop operator surface, like the radar).
- v1 content: **Journey lane** — table of new members: name (→ profile), joined date, day X/42, attended/9 progress, status chip, last attended, last coach touch, "Log touch" button. Status chips follow the light-theme contrast rule (`bg-*-500/10 text-*-700`).
- Cross-links to the existing `/dashboard/engagement` tab and challenges admin — the hub **links** to existing surfaces, never duplicates them. Future Pulse features (leaderboards, seasonal challenge) mount here.
- Note: `studio-pulse-data.js` (operator "studio pulse" metric) is unrelated — nav copy says "Pulse app" to avoid confusion.

### Contact profile panel
- On `contacts/[id]`: a compact Pulse block shown only when the contact is in-window — day X/42, attended/9, status chip. Reads `loadContactJourney`.

### Member card (champ-app)
- `mobile/components/JourneyCard.jsx`, mounted **top of the Home stack** for in-window members via `crmApi('/api/me/journey')`; renders nothing on `journey: null`, error, or 404 (fail-invisible). Auto-hides after completion (short celebration state first) or window end.
- Design: dark-monochrome UN1T identity, segmented 9-tick progress ring, week marker, status-driven motivational copy. Distinctive per the design bar — mockup approved in chat before build finalizes.
- Display shaping in pure `shared/onboarding-journey.js` (champ-app) with tests; **no dependency changes** (lockfile untouched — nitro-modules gotcha).

## Error handling
- Data loaders: DB errors throw to the route (500 with standard shape); `/api/me/journey` returns `{ journey: null }` for out-of-window rather than erroring; the app treats any failure as "no card".
- Cron is best-effort per member (one failed send never aborts the run) and idempotent via the ledger.

## Testing
- TDD on both pure libs (status boundaries: day 0/6/7, expected-floor edges, at-risk 10-day rule, completed/expired, config overrides, Dublin-day bucketing; copy contains no booking words).
- Data layer: mocked-db unit tests for pagination + window filters. Routes covered by `check:route-guards`.
- Full CI mirror + `next build` (un1t-crm); tests + lint (champ-app). Adversarial review before PRs; Richard merges.

## Out of scope (later sub-projects)
Cohort/team leaderboards; seasonal transformation challenge; any Glofox deep-link handoff (rejected for now — purely motivational); WhatsApp variants of the nudge.
