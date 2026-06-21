# Inclusion Core (v1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Every member who attends a class auto-earns points and competes — no device or manual action needed — by turning the existing Glofox `attended` sync into points-bearing `source='participation'` sessions that flow through the (already source-agnostic) points/streak/challenge/progress machinery. Plus operator-editable scoring and a consistency leaderboard.

**Architecture:** Mostly un1t-crm backend (config + cron + finaliser) reusing the source-agnostic downstream; champ-app surfaces the consistency board. Spec: `docs/superpowers/specs/2026-06-21-inclusion-core-design.md`.

**Branches:** `inclusion-core` in **un1t-crm** (created, spec committed) for T1–T5; `inclusion-core` in **champ-app** (create at T6) for T6. Do NOT stage the un1t-crm cookie-consent WIP (`src/app/layout.js`, `src/components/landing-page/BlockRenderers.jsx`, `.claude/`, `src/app/privacy/members/`, `src/components/CookieConsent.jsx`) — leave it uncommitted. Don't stage champ-app `mobile/package*.json` drift.

**Byte-sync note:** `heart-rate.js` is byte-identical across `un1t-crm/src/lib/heart-rate.js` (canonical), `champ-app/shared/heart-rate.js` (mirror, line-1 banner only), and `champ-app/src/lib/heart-rate.js` (re-export). T1 edits the canonical; T6 syncs the mirror.

---

### Task 1: Scoring config resolver + engine threading (un1t-crm, pure, TDD)

**Files:** Modify `src/lib/heart-rate.js`; its test file (find it — likely `src/lib/heart-rate.test.js`).

- [ ] **Read `src/lib/heart-rate.js` first** to see `ZONE_DEFS` (zone `points` 1–5) and the exact `summariseSession(samples, maxHr)` body (the points accumulation).
- [ ] **Write tests first** (append to the heart-rate test file), run to fail:
```js
import { resolveScoringConfig, SCORING_DEFAULTS, summariseSession } from './heart-rate.js'

describe('resolveScoringConfig', () => {
  it('returns defaults when settings absent', () => {
    const c = resolveScoringConfig({})
    expect(c.participationPoints).toBe(50)
    expect(c.zonePoints).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 })
  })
  it('overrides from locations.settings.scoring, partial-merges', () => {
    const c = resolveScoringConfig({ settings: { scoring: { participation_points: 25, zone_points: { 5: 8 } } } })
    expect(c.participationPoints).toBe(25)
    expect(c.zonePoints[5]).toBe(8)   // overridden
    expect(c.zonePoints[1]).toBe(1)   // default kept
  })
  it('ignores non-numeric garbage and falls back to defaults', () => {
    const c = resolveScoringConfig({ settings: { scoring: { participation_points: 'x', zone_points: { 3: 'y' } } } })
    expect(c.participationPoints).toBe(50)
    expect(c.zonePoints[3]).toBe(3)
  })
})

describe('summariseSession with configurable zonePoints', () => {
  // one minute solidly in zone 5 (use a maxHr so bpm sits in Z5)
  const minuteInZ5 = Array.from({ length: 61 }, (_, i) => ({ recorded_at: new Date(Date.parse('2026-06-21T10:00:00Z') + i * 1000).toISOString(), bpm: 190 }))
  it('uses default zone points when no opts', () => {
    const a = summariseSession(minuteInZ5, 200)
    const b = summariseSession(minuteInZ5, 200, { zonePoints: { 1:1,2:2,3:3,4:4,5:5 } })
    expect(a.effortPoints).toBe(b.effortPoints)
  })
  it('honours custom zone points (double Z5 → more points)', () => {
    const base = summariseSession(minuteInZ5, 200, { zonePoints: { 1:1,2:2,3:3,4:4,5:5 } })
    const dbl = summariseSession(minuteInZ5, 200, { zonePoints: { 1:1,2:2,3:3,4:4,5:10 } })
    expect(dbl.effortPoints).toBeGreaterThan(base.effortPoints)
  })
})
```
- [ ] **Implement** in `heart-rate.js`:
  - Add `export const SCORING_DEFAULTS = { zone_points: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }, participation_points: 50 }` (keep in sync with `ZONE_DEFS` points).
  - Add:
    ```js
    export function resolveScoringConfig(location) {
      const s = location?.settings?.scoring || {}
      const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
      const zp = {}
      for (const id of [1, 2, 3, 4, 5]) zp[id] = num(s?.zone_points?.[id], SCORING_DEFAULTS.zone_points[id])
      return { zonePoints: zp, participationPoints: num(s?.participation_points, SCORING_DEFAULTS.participation_points) }
    }
    ```
  - Modify `summariseSession(samples, maxHr, opts = {})`: where it accumulates points per zone, use `(opts.zonePoints?.[zone.id] ?? zone.points)` instead of `zone.points`. **Preserve the existing algorithm** (per-second gap attribution, 5s cap, floor) — only swap the points-per-zone source. Default (no opts) must be byte-identical behaviour.
- [ ] Run tests → pass; run `npm test` (no regressions) + `npm run lint`. Commit `heart-rate.js` + its test only.

### Task 2: Migration — source enum + cron heartbeat (un1t-crm)

**Files:** Create `supabase/migrations/304_inclusion_core.sql`. **Use 304, NOT 303** — the latest file on this branch is 302, but **303 is reserved by win-back's migration** (already applied to prod; its file lands when PR #620 merges), so 303 would collide. Use 304.

- [ ] Write:
```sql
-- NNN: inclusion core — allow source='participation' + credit-attendance cron heartbeat.
ALTER TABLE public.heart_rate_sessions DROP CONSTRAINT IF EXISTS heart_rate_sessions_source_check;
ALTER TABLE public.heart_rate_sessions ADD CONSTRAINT heart_rate_sessions_source_check
  CHECK (source IN ('ble_bridge','apple_health','fitbit','whoop','garmin','manual','participation'));

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('credit-attendance', 86400, 7200, 'Daily 03:00 UTC — credit participation sessions for Glofox-attended classes.')
ON CONFLICT (name) DO NOTHING;
```
- [ ] Confirm the exact constraint name first (`\d heart_rate_sessions` shape / migration 110) — adjust `DROP CONSTRAINT` name if it differs. Commit the migration file. (Controller applies via Supabase MCP + advisors.)

### Task 3: Shared finaliser + participation-session helper (un1t-crm)

**Files:** Modify `src/lib/live-class.js` (extract the cascade; thread zonePoints). Optionally create `src/lib/session-finalise.js`. Tests alongside.

- [ ] **Read `src/lib/live-class.js`** `endSession` (≈`:262–449`) — the finalisation (samples → `summariseSession` → stamp) and the reward cascade (`:303–446`: post-class email, `runDetectionForSession` + session push, goal completion, monthly-target/tier banking, export enqueue).
- [ ] **Extract** `export async function finalizeSessionRewards(db, sessionId)` — moves the `:303–446` cascade verbatim, but: (a) loads the session row fresh (`contact_id`, `location_id`, `effort_points`, `started_at`, `source`) at the top and returns early if no `contact_id`; (b) **guards the export-enqueue step** with `if (session.source !== 'participation')` (participation rows have no HR to export). Keep every other side-effect identical.
- [ ] **Rewire `endSession`** to call `await finalizeSessionRewards(db, sessionId)` where the inline cascade was. Also thread scoring: load the location (endSession already reads it for `monthly_points_target`) and pass `resolveScoringConfig(location).zonePoints` into the `summariseSession(...)` call. **Behaviour for live sessions must be unchanged** — existing `live-class` tests must stay green (they are the safety net).
- [ ] **Add** `export async function createParticipationSession(db, { contactId, locationId, glofoxEventId, className, startedAtIso, endedAtIso, participationPoints, maxHr })` — inserts a `heart_rate_sessions` row: `source:'participation'`, `contact_id`, `location_id`, `started_at: startedAtIso`, `ended_at: endedAtIso`, `effort_points: participationPoints`, `zones_seconds: {}`, `max_hr_used: maxHr`, `glofox_event_id`, `class_name`, `class_link_source: 'attended'`, `device_identifier: null`. Returns the new row id. (Mirror the insert shape at `bridge-samples.js:337`.)
- [ ] **Tests:** `createParticipationSession` builds the right insert payload (mock db, assert columns incl. `source:'participation'`, `ended_at` set, `effort_points`); `finalizeSessionRewards` returns early when `contact_id` null and skips export for `source:'participation'` (mock the export-enqueue + assert not called). Run the FULL `live-class` test suite → green. Commit.

### Task 4: credit-attendance cron + vercel.json (un1t-crm)

**Files:** Create `src/app/api/cron/credit-attendance/route.js`; modify `vercel.json`.

- [ ] **Mirror an existing cron** (`src/app/api/cron/notify-winback/route.js` or `notify-streak-at-risk`) for the skeleton: `export const runtime='nodejs'`, `maxDuration=300`, `POST`→`GET`, `CRON_SECRET` Bearer gate, `stampHeartbeat('credit-attendance')` on success, `{ success }` response.
- [ ] **Logic:** for each location (or all locations):
  - Paginate (`.range`, 1k rule) `class_bookings` where `attended = true`, `contact_id IS NOT NULL`, `starts_at < new Date(Date.now() - 60*60*1000).toISOString()`, `.order('starts_at')`.
  - For each booking: **dedupe** — query `heart_rate_sessions` for an existing row with the same `contact_id` AND `glofox_event_id`; if one exists, skip (covers already-credited + device users with an HR session). Batch the existence check per page (`.in('glofox_event_id', ids)` filtered by the page's contact_ids) to avoid N+1.
  - Else: resolve the class end (`class_occurrences` by `glofox_event_id` → its end; else `starts_at + 60min`), load the contact for `resolveMaxHr`, load the location for `resolveScoringConfig(location).participationPoints`, then `createParticipationSession(...)` → `finalizeSessionRewards(db, newId)`. Best-effort per booking (try/catch, log, continue).
- [ ] Add to `vercel.json` crons: `{ "path": "/api/cron/credit-attendance", "schedule": "0 3 * * *" }`.
- [ ] Verify `npm run check:route-guards` passes (CRON_SECRET-guarded) and `grep -L stampHeartbeat` doesn't list the new route. If the credit loop has a pure decision (e.g. `shouldCredit(booking, existingSessionKeys)`), extract + unit-test it. Commit both files.

### Task 5: Admin scoring editor (un1t-crm)

**Files:** Create `src/app/settings/scoring/page.js` + `src/app/api/settings/scoring/route.js`. Add a Settings nav link.

- [ ] **Read `/settings/customer-agent`** (`src/app/settings/customer-agent/page.js` + `src/app/api/settings/customer-agent/route.js`) and mirror it exactly (auth gate, location resolution, JSONB merge-write pattern, response shape).
- [ ] **Route** `src/app/api/settings/scoring/route.js`:
  - `GET` → return `resolveScoringConfig(location)` (current merged values) for the active location.
  - `PUT` → `MANAGER_ROLES`/admin gate + `assertLocationAccess`; Zod-validate `{ zone_points: { 1..5: number≥0 }, participation_points: number≥0 }`; write to `locations.settings.scoring` (merge, don't clobber other `settings.*` keys); return `{ success, settings }`.
- [ ] **Page** `src/app/settings/scoring/page.js` — client form: 5 zone-rate inputs + participation-value input, prefilled from `GET`, "Save" → `PUT`, inline success/error. Match the customer-agent page's styling/primitives.
- [ ] Add a "Scoring" entry to the Settings hub/nav next to "Customer agent".
- [ ] **Tests:** route validation (rejects negatives/garbage, gates non-managers). `npm run lint` + `npx next lint` (settings page link via `<Link>`) + `npm test`. Commit.

### Task 6: champ-app — byte-sync engine + consistency leaderboard (champ-app)

**Files (champ-app):** `git checkout -b inclusion-core` off main. Sync `shared/heart-rate.js`; verify `src/lib/heart-rate.js` re-export; add a consistency-leaderboard loader + web + native surface; verification tests.

- [ ] **Byte-sync** `champ-app/shared/heart-rate.js` to the un1t-crm canonical (add `SCORING_DEFAULTS`, `resolveScoringConfig`, `summariseSession` opts): `diff <(tail -n +2 un1t-crm/src/lib/heart-rate.js) <(tail -n +2 champ-app/shared/heart-rate.js)` → empty. Confirm `champ-app/src/lib/heart-rate.js` re-export still covers the new exports.
- [ ] **Consistency leaderboard loader** — mirror `champ-app/src/lib/load-challenges.js`: a loader that calls `computeStandings(db, { locationId, metric: 'classes', fromIso: <month start>, toIso: <month end> })` (the existing `challenges-io.js` standings; no source filter, so participation sessions count) → returns ranked `{ name, value, rank }` (privacy via `shortName`, exclude anonymous). Current calendar month.
- [ ] **Verification tests** (champ-app vitest): `metricValue({ source:'participation', effort_points:50, zones_seconds:{} }, 'classes') === 1`; a participation-shaped session is counted by `currentStreak` and appears in `progress-analytics` buckets (source-agnostic). Lock that participation flows through.
- [ ] **Surface (web + native):** a persistent **"Classes this month"** board. Web: a section/screen reusing the challenges board components (`src/app/challenges/page.jsx` patterns). Native: same, mirroring `mobile/app/challenges.jsx` board rendering. Keep it lean — reuse existing standings row/podium components; don't build a new design language.
- [ ] champ-app: `npm test`, `npm run lint`, `npm run build`, `cd mobile && npx expo export --platform ios`. Commit (NOT `mobile/package*.json`).

---

## Final verification
- un1t-crm: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build`.
- champ-app: `npm test && npm run lint && npm run build && (cd mobile && npx expo export --platform ios)`.
- Controller applies the migration (T2) + runs advisors.
- finishing-a-development-branch → **2 PRs** (un1t-crm + champ-app, base=main), cross-linked, cite the migration. **Stop before merge** (merging deploys prod + auto-OTAs members = operator's call). Note: the cron is dormant until it runs daily; nothing fires for members without app push tokens (same adoption gate as the rest).

## Self-review
- Spec coverage: config+engine (T1), migration (T2), finaliser+helper (T3), cron (T4), admin editor (T5), byte-sync+leaderboard+verify (T6). ✓
- Type consistency: `resolveScoringConfig`→`{zonePoints,participationPoints}`; `summariseSession(...,opts.zonePoints)`; `createParticipationSession({...})`; `finalizeSessionRewards(db,sessionId)`; `source='participation'`; dedupe `(contact_id, glofox_event_id)`; settings JSONB `zone_points`/`participation_points` — consistent across tasks. ✓
- No placeholders: lib code + migration SQL + cron logic + insert shape concrete; UI tasks name exact mirror files. ✓
- Risk: T3 refactors the live `endSession` path — guarded by keeping existing live-class tests green (behaviour-preserving extraction). ✓
- Reuse: no new downstream — participation rows flow through existing points/streak/challenge/progress. ✓
