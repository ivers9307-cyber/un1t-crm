# Pulse hub + first-90-days journey — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Tasks A1–A5 (un1t-crm, branch `feat/pulse-first-90-days`) are SEQUENTIAL; tasks B1–B3 (champ-app, branch `feat/journey-pace-card`) are SEQUENTIAL; the A and B chains run in parallel (separate repos). Spec: `docs/superpowers/specs/2026-06-28-pulse-hub-first-90-days-design.md` — read it first; it is the contract.

**Goal:** `/pulse` operator hub + first-90-days journey (9-in-6 pace) across CRM and member app, booking-free.
**Architecture:** CRM computes (pure lib + compute-on-read data layer + daily nudge cron), app renders. One additive migration.
**Tech:** Next.js 16 App Router, Supabase service-role routes, Vitest, Expo/RN + NativeWind.

## un1t-crm chain (A)

### A1 — pure pace lib (TDD)
Create `src/lib/onboarding-journey.js` + `src/lib/onboarding-journey.test.js`.
- `resolveJourneyConfig(location)` → `{ windowDays: 42, targetClasses: 9 }` merged from `notification_config.categories.onboarding_pace` (copy the `resolveClassReminderLeadTimes` defensive style in `class-reminders.js`).
- `journeyStatus({ joinedAt, attendedAt, now, config })` per the spec's formulas + statuses (`on_track|behind|at_risk|completed|expired`, days 0–6 always on_track, at-risk 10-day-quiet rule uses Dublin day keys — copy `dublinDateKey` idiom from champ-app's `hr-analytics` or use `dublinTodayStr` from `@/lib/dublin-time`).
- `buildOnboardingPacePush(row)` → `{ title, body, data: { type: 'onboarding_pace' } }` with status-variant copy. Test asserts `/book/i` matches nothing in any variant.
- Write failing tests first (boundaries: day 0/6/7/42/43; expected floor at day 21 = 4; attended 2 @ expected 4 → at_risk; completed; config override 28/6). Run `npx vitest run src/lib/onboarding-journey.test.js` red → implement → green. Commit `PULSE-90.1`.

### A2 — data layer + routes
Create `src/lib/onboarding-journey-data.js` (+ test with mocked db): `loadJourneyLane(db, locationId, nowMs)`, `loadContactJourney(db, contactId, nowMs)` per spec (paginate with `.range()` + `.order()`; members = contacts w/ `joined_at >= now − (windowDays+14)d`, location-scoped, membership statuses like `fetchMembers`; attendance = `class_bookings` `attended=true`, status ≠ CANCELLED, `starts_at` in window).
Routes: `GET /api/pulse/journey` (getCurrentUser → `hasPermission(user,'pulse_admin')` 403 → assertLocationAccess), `GET /api/me/journey` (copy `src/app/api/me/body-metrics/route.js` auth exactly; out-of-window → `{ success: true, data: { journey: null } }`), `POST /api/pulse/journey/touch` (validateBody zod `{ contact_id: uuidLike }`; insert `action_log` mirroring the churn-radar outreach write — grep `action_log` inserts and copy shape). Register all three in `src/lib/openapi.js`. Commit `PULSE-90.2`.

### A3 — push channel + cron + migration file + vercel.json
- Map `onboarding_pace: 'progress'` in `shared/customer-push-channels.js` (keep both repos' copies in sync — B-chain mirrors it).
- `src/app/api/cron/notify-onboarding-pace/route.js`: CRON_SECRET Bearer (copy `send-class-booking-reminders` skeleton), loadJourneyLane per live location → filter `behind|at_risk` + has champ push token → dedup insert `customer_engagement_nudges` `(type:'onboarding_pace', dedup_key: contactId+':wk'+weekIndex)` claim-before-send → `sendCustomerPush` → `stampHeartbeat('notify-onboarding-pace')`. Per-member try/catch.
- `supabase/migrations/354_onboarding_pace_nudges.sql` (renumber if 354 is taken at PR time): CHECK swap copying mig 323 verbatim + `'onboarding_pace'`; INSERT `cron_heartbeats` `('notify-onboarding-pace')` ON CONFLICT DO NOTHING. DO NOT APPLY — the controller applies via Supabase MCP pre-merge.
- `vercel.json`: cron entry `/api/cron/notify-onboarding-pace` daily 10:30 UTC. Commit `PULSE-90.3`.

### A4 — /pulse hub + permission + profile panel
- `shared/permissions.js`: add `pulse_admin` key (label "Pulse app", hint per spec) + role defaults owner/manager/head_coach true, staff false + `WEB_ONLY_OK` entry with reason (desktop operator surface). Update permission tests/counts if any assert totals.
- `src/app/pulse/page.js` (+ client component `src/components/pulse/JourneyLane.jsx`): fetch `/api/pulse/journey`; table per spec columns; status chips `bg-emerald-500/10 text-emerald-700` (on_track/completed), `bg-amber-500/10 text-amber-700` (behind), `bg-red-500/10 text-red-700` (at_risk) — NEVER -300/-400 text (lint `no-low-contrast-chip` enforces); "Log touch" → POST touch + optimistic refresh; header cross-links to `/dashboard/engagement` + challenges admin. Nav: add Pulse to `src/lib/nav-items.js` under the retention/engagement group, gated `pulse_admin`; update `nav-items.test.js`.
- Contact profile: in `src/app/contacts/[id]/page.js` render a compact Pulse journey block (day/attended/chip) only when `loadContactJourney` returns in-window. Commit `PULSE-90.4`.

### A5 — validation
`npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build`. Fix everything; commit `PULSE-90.5` + CHANGELOG row (next number after current top). Do NOT push.

## champ-app chain (B)

### B1 — pure display lib (TDD)
`shared/onboarding-journey.js` + `.test.js`: `shapeJourneyCard(journey)` → `null` when journey null/expired/completed>3d; else `{ ringPct, ticks: [{filled}×9], weekLabel ('Week 2 of 6'), countLabel ('4 of 9 classes'), message }` with status-variant motivational copy (test: no `/book/i`). Mirror `onboarding_pace: 'progress'` into champ-app's `shared/customer-push-channels.js`. Run `npm test` from repo root. Commit.

### B2 — JourneyCard + Home wiring
`mobile/components/JourneyCard.jsx`: dark-mono UN1T card, segmented 9-tick ring (react-native-svg, already a dep — NO new dependencies, package.json/lockfile untouched), week label, message; celebration variant on completed. Wire in `mobile/app/(tabs)/index.jsx` ABOVE ProfileNudgeCard: `crmApi('/api/me/journey')` in the existing load pattern; any error/null → render nothing. Push routing: `onboarding_pace` type opens Home (add to the NotificationRouter map in `_layout.jsx` if type-routing exists there). Commit.

### B3 — validation
`npm test && npm run lint` (root). `git diff --stat` must show NO package.json/package-lock changes; grep lockfile still contains `react-native-nitro-modules`. Commit any fixes. Do NOT push.

## Verification gate (controller, after both chains)
Adversarial review of both diffs (booking-language grep `-i 'book'` over customer-facing strings; invariant checklist: pagination, awaited writes, route guards, chip contrast, openapi registration, heartbeat stamp), full CI mirrors re-run, `next build`, then: apply migration via Supabase MCP (verify next free number vs `list_migrations`), `get_advisors`, push both branches, open PRs, hold for Richard.
