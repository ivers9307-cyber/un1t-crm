# Inclusion core (v1 of the fitness-hub program) — design spec

**Date:** 2026-06-21
**Status:** approved (brainstorm), ready for implementation plan
**Repos touched:** `un1t-crm` (backend, admin, canonical engine) + `champ-app` (member surfacing + byte-synced engine).
**Related:** `~/code/hr-platform-product-audit-2026-06-20.md`; the multi-vendor feasibility audit (this session). This is **v1** of a phased program — later phases (own specs): Strava personal ingestion → Apple HealthKit → Whoop → Garmin (partner-gated).

## 1. Goal

Make the platform include **everybody in the gym, device or not**: every member who attends a class automatically earns points and competes, with zero manual action and no external API. Achieved by turning the **attendance data we already sync from Glofox** into points-bearing sessions that flow through the existing (source-agnostic) points / streak / challenge / progress machinery, plus a **two-axis** model so no-device members compete on equal footing. Point figures are **operator-editable** from day one.

## 2. Key decisions (locked with operator)

- **Sourcing strategy (whole program):** direct integrations, built in-house, phased — no aggregator. v1 needs **no** external API.
- **v1 = the inclusion core.** Attendance → points is automatic off the existing Glofox `attended` flag; **no manual check-in UI** (an optional "I was here" tap is a deferred fallback if attendance-marking gaps appear).
- **Two-axis competition:** **Intensity** (HR effort points — rewards effort, device-only) and **Consistency** (classes attended / streak — equal for everyone). A no-HR attended class earns a flat **participation points** value (default 50) so it also moves the points score.
- **Operator-editable scoring** (the new requirement): the per-zone effort rates + the participation value live in `locations.settings` with code defaults and a CRM admin editor — so tuning figures is a settings write, not a code change.

## 3. The reuse win (why v1 is mostly backend)

The internal audit confirmed everything downstream of "a finished, contact-bound `heart_rate_sessions` row" is **source-agnostic** — verified, with file:line:
- **Points/streak/progress:** `summariseSession` (`shared/heart-rate.js:87`), `currentStreak` (`shared/hr-analytics.js:264`), `progress-analytics.js` — all read session columns, no source filter.
- **Challenges/leaderboards:** `metricValue` (`shared/challenges.js:8`) — `'classes'` returns `1` per session; `challenges-io.js computeStandings` (`:31`) queries `heart_rate_sessions` with **no source filter** (`location_id` + `contact_id NOT NULL` + `ended_at NOT NULL` + window).
- **Reward cascade:** `endSession` (`live-class.js:303–446`) — gated only on `contact_id`; runs achievements+push, goal completion, monthly-target/tier banking, export enqueue.

So the new work is narrow: **(a) a config-driven scoring layer, (b) a participation-session auto-credit job, (c) a shared finaliser, (d) a consistency leaderboard surface.** Once a `source='participation'` row with `ended_at` + `effort_points` exists, it counts toward challenges, streaks, progress, monthly target, and tiers automatically.

## 4. Components

### A. Operator-editable scoring config (un1t-crm)

- **Storage:** new `locations.settings.scoring` JSONB block (mirrors `settings.customer_agent.monthly_points_target` at `live-class.js:387`). Shape:
  ```json
  { "zone_points": { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 }, "participation_points": 50 }
  ```
- **Pure resolver:** `resolveScoringConfig(location)` → returns the blob with **code defaults** filled (zone_points = current `ZONE_DEFS` points 1–5; participation_points = 50). Lives in the byte-synced engine lib so both repos share defaults. Unset settings → today's behaviour exactly.
- **Engine threading:** extend `summariseSession(samples, maxHr, opts = {})` to accept `opts.zonePoints` (defaults to `ZONE_DEFS` points). `shared/heart-rate.js` is byte-identical in un1t-crm + champ-app — change both. Update the call site (`live-class.js endSession`, ~`:278`) to pass `resolveScoringConfig(location).zone_points`. Pure → fixture-tested.
- **Admin editor:** `/settings/scoring/page.js` + `PUT /api/settings/scoring/route.js`, **mirroring `/settings/customer-agent`** exactly (client form → Zod-validated route → writes `locations.settings.scoring`; `MANAGER_ROLES`/admin gate; `{ success, settings }` response). Fields: 5 zone rates + participation value, with inline defaults shown. New web permission NOT needed (reuses the settings gate); confirm parity linter (settings pages aren't permission-keyed).

### B. Migration — source enum (un1t-crm)

- Single additive migration: widen `heart_rate_sessions.source` CHECK to add `'participation'` (drop + re-add constraint; current set `('ble_bridge','apple_health','fitbit','whoop','garmin','manual')`). No other schema change — scoring is JSONB. Controller applies via Supabase MCP + advisors.

### C. Participation session helper + shared finaliser (un1t-crm)

- **`finalizeSessionRewards(db, sessionId)`** — extract `endSession`'s cascade (`live-class.js:303–446`) into a reusable function that reads the session **fresh** (`contact_id`, `location_id`, `effort_points`, `started_at`), then runs: achievement detection + consolidated push, goal-completion, monthly-target/tier banking. **Guard the export-enqueue step to HR sessions** (skip when `source='participation'` / no samples). `endSession` calls it after computing points; the auto-credit job (D) calls it after creating a participation row. Byte-for-byte behaviour-preserving for the live path.
- **`createParticipationSession(db, { contactId, locationId, glofoxEventId, className, startedAtIso, endedAtIso, participationPoints, maxHr })`** — centralises the insert shape (today inlined at `bridge-samples.js:337` + `live-class.js:206`). Inserts:
  - `source: 'participation'`, `contact_id`, `location_id`, `started_at`, `ended_at` (class end — **required** so challenge standings count it), `effort_points: participationPoints`, `zones_seconds: {}`, `max_hr_used: maxHr` (NOT-NULL — use `resolveMaxHr(contact)`, harmless with no zones), `glofox_event_id`, `class_name`, `class_link_source: 'attended'`, `device_identifier: null`.
  - `endedAtIso` = class end from `class_occurrences` (`resolveOccurrence` by `glofox_event_id`) if available, else `started_at + 60min` default.

### D. Auto-credit cron (un1t-crm)

- **`/api/cron/credit-attendance`** — daily (e.g. `0 3 * * *`), `CRON_SECRET`-gated, `maxDuration=300`, paginated per the 1k-row rule, `stampHeartbeat('credit-attendance')` + a `cron_heartbeats` row (in migration B) + `vercel.json` entry.
- **Logic per location:** find `class_bookings WHERE attended = true AND contact_id IS NOT NULL AND starts_at < now() - interval '1 hour'` (completed + attended). For each booking:
  - **Dedupe (idempotency):** skip if a `heart_rate_sessions` row already exists for `(contact_id, glofox_event_id)` — this covers both already-credited participation rows AND device users who already have an HR session for that class (no double-count; HR session's Intensity points win).
  - Else: `createParticipationSession(...)` with `participationPoints` from `resolveScoringConfig(location)` → then `finalizeSessionRewards(db, newSessionId)`.
- Idempotent across runs via the dedupe; safe to re-run / backfill.

### E. Two-axis surfacing (champ-app + verify)

- **Verify (tests, no behaviour change):** a `source='participation'` session contributes to the monthly points score, `currentStreak`, the progress dashboard, and the `'classes'` challenge metric. Add a unit assertion that `metricValue({source:'participation', effort_points:50, ...}, 'classes') === 1` and that progress/streak count it.
- **Consistency leaderboard (the visible payoff):** a persistent **"Classes this month"** board (most attended classes in the current calendar month), reusing `computeStandings(metric='classes')` — no new standings code. Surface on champ-app **web + native** (extend the existing challenges/leaderboard surface; privacy via the existing `shortName` projection; exclude anonymous). This is where no-device members visibly compete on equal footing. (Intensity ranking already exists via points-metric challenges.)

## 5. Scope

**In:** A–E above (config + admin editor, migration, helper + finaliser, auto-credit cron, consistency leaderboard + verification).

**Out (own later specs/phases):** Strava personal ingestion, Apple HealthKit, Whoop, Garmin; manual "I was here" tap; QR / coach-marks attendance; recovery/readiness; cross-source intensity normalisation.

## 6. Architecture choice (vs alternatives)

- **Chosen:** auto-credit off the existing Glofox `attended` sync; config-driven scoring; reuse the source-agnostic downstream. Minimal new surface; no external API; "everybody included" with no member action.
- *Rejected — manual in-app check-in as the primary path:* the operator confirmed attendance is already captured in Glofox; a manual tap is redundant for the common case (kept as a deferred fallback).
- *Rejected — hardcode point values, add editability later:* would force re-plumbing the pure engine; config-from-day-one is cheap (JSONB + one settings page).
- *Rejected — a dedicated participation/attendance table:* a `source='participation'` `heart_rate_sessions` row reuses the entire downstream for free; a separate table would need parallel points/streak/challenge wiring.

## 7. Dependencies / caveats

- **Completeness = Glofox attendance discipline.** A class not marked attended in Glofox won't auto-credit. Operator confirmed this data is reliable; if gaps surface, the deferred "I was here" tap closes them.
- **Dedupe is by `(contact_id, glofox_event_id)`** — assumes one credit per member per class event. Sound for class attendance.
- **`class_occurrences` may not cover every event** for the `ended_at` lookup — fall back to a nominal 60-min duration.

## 8. Self-review

- Spec coverage: config+admin (A), migration (B), helper+finaliser (C), cron (D), surfacing+verify (E) — all concrete with file:line hooks. ✓
- Type consistency: `resolveScoringConfig`→`{zone_points, participation_points}`, `summariseSession(...,opts.zonePoints)`, `createParticipationSession({...})`, `finalizeSessionRewards(db, sessionId)`, `source='participation'`, dedupe key `(contact_id, glofox_event_id)` — consistent across components. ✓
- No placeholders: settings shape, cron schedule + query, insert columns, finaliser line range all specified. ✓
- Scope: single coherent v1; ingestion phases explicitly carved out. ✓
- Reuse: no new downstream code — participation rows flow through existing points/streak/challenge/progress. ✓
