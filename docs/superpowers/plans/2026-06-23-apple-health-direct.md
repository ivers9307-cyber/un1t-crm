# Apple Health Direct HealthKit Ingestion + OW Decommission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use `- [ ]`.

**Goal:** Read a member's Apple Health workouts + HR directly on-device (HealthKit), upload straight to UN1T, and decommission OpenWearables + its Fly infra.

**Architecture:** champ-app native app (`@kingstinct/react-native-healthkit`, background delivery) reads HealthKit → POSTs a batch to a customer-authed un1t-crm endpoint → reuses the existing mapper + class-correlation + `finalizeSessionRewards` (the proven OW-webhook path, minus Svix + OW-fetch) → `heart_rate_sessions` + `member_health_metrics`. un1t-crm's proxy already passes a valid member Supabase JWT through `/api/*`, so the member auths in-handler.

**Tech Stack:** Next.js 16 / Supabase (un1t-crm); Expo / React Native + `@kingstinct/react-native-healthkit` (champ-app mobile); Vitest.

**Verify-before-teardown:** Phase 1 ships + Richard device-verifies before Phase 2 removes OW.

---

## File structure

**un1t-crm (Phase 1 — new):**
- `src/lib/apple-health-map.js` — pure workout→session mapper (copy of `openwearables-map.js` with `apple_*` raw_metadata keys). One responsibility: map.
- `src/lib/customer-auth.js` — `resolveCustomerContact(request, db)`: validate the member Bearer JWT → `contacts.user_id` → contact row. One responsibility: member auth.
- `src/app/api/wearables/apple-health/ingest/route.js` — POST batch ingest.
- `src/app/api/wearables/apple-health/connect/route.js` — POST/DELETE connection record.

**champ-app (Phase 1 — new/changed):**
- `shared/apple-health-payload.js` — pure: HealthKit query results → `{ workouts, healthMetrics }` upload payload (Workout-Output shape).
- `mobile/lib/apple-health-sync.js` — cursor (SecureStore) + read-since + POST to the CRM base.
- `mobile/lib/crm-api.js` — thin `crmApi(path, opts)` that calls `crm.un1tdublin.com` with the member token (un1t-crm hosts ingest/connect).
- `mobile/app/account/connect-apple-health.jsx` — rewritten onto the HealthKit module.
- `mobile/app.config.js`, `mobile/package.json` — swap the Expo plugin + dep.

**Phase 2 — deletions:** `un1t-crm/src/lib/openwearables.js`, `openwearables-map.js`, `src/app/api/webhooks/openwearables/`; `champ-app/src/lib/openwearables.js`, `src/app/api/wearables/connect/`, the `open-wearables` dep + plugin; `OPENWEARABLES_*` env; Fly app + Postgres.

---

## PHASE 1 — Build the direct path

### Task 1: Pure mapper `apple-health-map.js` (un1t-crm)

**Files:**
- Create: `src/lib/apple-health-map.js`
- Test: `src/lib/apple-health-map.test.js`

The device uploads each workout in the **Workout-Output shape** (`{ id, type, start_time, end_time, calories_kcal?, distance_meters?, avg_heart_rate_bpm?, max_heart_rate_bpm?, avg_pace_sec_per_km? }`) + `hrSamples: [{ timestamp, value, unit? }]`. This mapper is byte-equivalent to `openwearables-map.js#mapAppleWorkoutToSession` except the `raw_metadata` keys are `apple_*` (no OW naming) and the dedup key is `apple_workout_uuid`.

- [ ] **Step 1: Failing test** — copy `src/lib/openwearables-map.test.js` to `apple-health-map.test.js`, import `{ mapAppleHealthWorkoutToSession }` from `./apple-health-map.js`, and adjust assertions: `raw_metadata.apple_workout_uuid` (from `workout.id`), `raw_metadata.apple_workout_type`, no `ow_*` keys. Keep the HR-path + no-HR-path + sparse-workout cases.

```js
import { describe, it, expect } from 'vitest'
import { mapAppleHealthWorkoutToSession } from './apple-health-map.js'

const scoring = { zonePoints: { 1: 1, 2: 2, 3: 4, 4: 8, 5: 12 }, participationPoints: 10 }

describe('mapAppleHealthWorkoutToSession', () => {
  it('HR path: computes zones/points/avg/peak from samples; stamps apple_workout_uuid', () => {
    const workout = { id: 'HK-UUID-1', type: 'running', start_time: '2026-06-23T08:00:00Z', end_time: '2026-06-23T08:40:00Z', calories_kcal: 420 }
    const hrSamples = Array.from({ length: 40 }, (_, i) => ({ timestamp: new Date(Date.parse(workout.start_time) + i * 60000).toISOString(), value: 150 }))
    const out = mapAppleHealthWorkoutToSession({ workout, hrSamples, maxHr: 190, scoring })
    expect(out.source).toBe('apple_health')
    expect(out.raw_metadata.apple_workout_uuid).toBe('HK-UUID-1')
    expect(out.raw_metadata).not.toHaveProperty('ow_workout_id')
    expect(out.effort_points).toBeGreaterThan(0)
    expect(out.avg_hr_bpm).toBe(150)
  })
  it('no-HR path: flat participation points, empty zones, avg/peak from aggregates', () => {
    const workout = { id: 'HK-2', type: 'walking', start_time: '2026-06-23T08:00:00Z', end_time: '2026-06-23T08:30:00Z', avg_heart_rate_bpm: 110, max_heart_rate_bpm: 130 }
    const out = mapAppleHealthWorkoutToSession({ workout, hrSamples: [], maxHr: 190, scoring })
    expect(out.effort_points).toBe(10)
    expect(out.zones_seconds).toEqual({})
    expect(out.avg_hr_bpm).toBe(110)
    expect(out.peak_hr_bpm).toBe(130)
  })
})
```

- [ ] **Step 2: Run → fail** — `npx vitest run src/lib/apple-health-map.test.js` → fail (module missing).
- [ ] **Step 3: Implement** — copy `openwearables-map.js`, rename export to `mapAppleHealthWorkoutToSession`, drop the `provider` arg, change `raw_metadata` to `{ apple_workout_uuid: w.id ?? null, apple_workout_type: w.type ?? null }`. Keep the `summariseSession` import + HR / no-HR branches verbatim.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(apple-health): pure HealthKit workout→session mapper`.

### Task 2: `resolveCustomerContact` helper (un1t-crm)

**Files:**
- Create: `src/lib/customer-auth.js`
- Test: `src/lib/customer-auth.test.js`

un1t-crm's `getCurrentUser()` resolves STAFF. Members auth via their Supabase JWT → `contacts.user_id`. This helper validates the Bearer token (via the anon Supabase client `getUser(token)`) and resolves the contact.

- [ ] **Step 1: Failing test** — mock a supabase-like client; assert: no token → `{ error: 'unauthorised' }`; valid token but no contact → `{ error: 'no_contact' }`; valid token + contact → `{ contact }`.

```js
import { describe, it, expect, vi } from 'vitest'
import { resolveCustomerContact } from './customer-auth.js'

function req(token) { return { headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) } } }
function authClient(user) { return { auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } } }
function db(contact) { return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: contact }) }) }) }) } }

describe('resolveCustomerContact', () => {
  it('401 when no bearer token', async () => {
    const out = await resolveCustomerContact(req(null), { authClient: authClient(null), db: db(null) })
    expect(out.error).toBe('unauthorised')
  })
  it('409 when token valid but no contact', async () => {
    const out = await resolveCustomerContact(req('t'), { authClient: authClient({ id: 'u1' }), db: db(null) })
    expect(out.error).toBe('no_contact')
  })
  it('resolves the contact for a valid member token', async () => {
    const out = await resolveCustomerContact(req('t'), { authClient: authClient({ id: 'u1' }), db: db({ id: 'c1', location_id: 'loc1' }) })
    expect(out.contact).toEqual({ id: 'c1', location_id: 'loc1' })
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — signature `resolveCustomerContact(request, { authClient, db } = {})`. Default `authClient` = a fresh anon `@supabase/supabase-js` client (NEXT_PUBLIC_SUPABASE_URL + ANON_KEY); default `db` = `createServerClient()` (service role). Read Bearer token → `authClient.auth.getUser(token)` → if no user, `{ error: 'unauthorised' }`. Else `db.from('contacts').select('id, location_id, max_hr_override, dob').eq('user_id', user.id).maybeSingle()` → `{ contact }` or `{ error: 'no_contact' }`. (Injectable deps for the test.)
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(auth): resolveCustomerContact (member JWT → contact) for un1t-crm`.

### Task 3: Ingest endpoint (un1t-crm)

**Files:**
- Create: `src/app/api/wearables/apple-health/ingest/route.js`
- Test: `src/app/api/wearables/apple-health/ingest/route.test.js`

Mirror the OW webhook's POST body (map → class-correlate → dedup → insert → finalise) but: auth via `resolveCustomerContact`; input = `{ workouts: [{ workout, hrSamples }], healthMetrics: [{ metric, recorded_at, value, unit }] }` (a batch the device already read); loop. Reuse `mapAppleHealthWorkoutToSession`, `resolveMaxHr`/`resolveScoringConfig`, `resolveCurrentOccurrence`, `lookupBookedMember`, `finalizeSessionRewards`. Dedup on `raw_metadata->>apple_workout_uuid`. Upsert metrics into `member_health_metrics` (dedup `(contact_id, metric, recorded_at)`).

- [ ] **Step 1: Failing test** — mock `@/lib/supabase`, `@/lib/customer-auth`, `@/lib/live-class` (finalizeSessionRewards), `@/lib/class-occurrences`, `@/lib/class-bookings`. Assert: unauth → 401; a 1-workout batch → inserts a session + calls finalise + returns `{ ingested: 1 }`; a re-uploaded (already-present) workout → `deduped`. (Follow the shape of the existing OW webhook test if present, else a minimal mock-db chain.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — `export const runtime='nodejs'`. `POST`: `const { contact, error } = await resolveCustomerContact(request)`; if error → 401/409. Parse body; for each `{ workout, hrSamples }`: build `session = mapAppleHealthWorkoutToSession({ workout, hrSamples, maxHr: resolveMaxHr(contact), scoring: resolveScoringConfig(location) })`; set `contact_id`/`location_id`; class-correlate (copy lines from the OW webhook §5); dedup on `raw_metadata->>apple_workout_uuid` + the strap-wins guard (§6); insert; `finalizeSessionRewards`. Upsert `healthMetrics`. Return `{ success, ingested, deduped, finalised }`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: route-guard exemption** — add this route to `scripts/check-route-guards.mjs` `SESSION_GUARDS`/exempt with reason "customer-authed via resolveCustomerContact (member Supabase JWT)". Run `npm run check:route-guards` → pass.
- [ ] **Step 6: Commit** — `feat(apple-health): direct HealthKit ingest endpoint (customer-authed batch)`.

### Task 4: Connect/disconnect endpoint (un1t-crm)

**Files:**
- Create: `src/app/api/wearables/apple-health/connect/route.js`
- Test: `src/app/api/wearables/apple-health/connect/route.test.js`

- [ ] **Step 1: Failing test** — POST upserts `hr_provider_connections` `{ provider:'apple_health', provider_user_id: contact.id, status:'active' }`; DELETE sets `status:'revoked'`; unauth → 401.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — `resolveCustomerContact` then service-role upsert/update on `hr_provider_connections` (`onConflict: 'contact_id,provider'`). `provider_user_id = contact.id` (presence marker — no OW server).
- [ ] **Step 4: Run → pass.** **Step 5: route-guards exempt + commit** — `feat(apple-health): connect/disconnect endpoint`.

### Task 5: Pure payload shaper `apple-health-payload.js` (champ-app)

**Files:**
- Create: `champ-app/shared/apple-health-payload.js`
- Test: `champ-app/shared/apple-health-payload.test.js`

Pure: HealthKit query results (workouts with `uuid`, `workoutActivityType`, `startDate`, `endDate`, `totalEnergyBurned`, `totalDistance`; HR quantity samples; metric samples) → `{ workouts: [Workout-Output], healthMetrics: [...] }`. Maps the HealthKit activity-type enum → our `workout_type` strings (running/walking/cycling/...); ISO-stringifies dates; bundles per-workout HR samples that fall in `[startDate, endDate]`.

- [ ] **Step 1: Failing test** — given one HK workout + 3 HR samples (2 inside the window, 1 outside) + 1 resting-HR metric, assert the payload: one workout with `id===uuid`, `start_time`/`end_time` ISO, `hrSamples` length 2; `healthMetrics` has the resting-HR entry. Cover the activity-type mapping for `HKWorkoutActivityTypeRunning → 'running'`.
- [ ] **Step 2: Run → fail.** **Step 3: Implement** the pure mapping. **Step 4: Run → pass.** **Step 5: Commit** — `feat(apple-health): pure HealthKit→upload payload shaper`.

### Task 6: HealthKit module + Expo plugin (champ-app mobile) — NATIVE

**Files:** `champ-app/mobile/package.json`, `champ-app/mobile/app.config.js`, `champ-app/mobile/package-lock.json`

- [ ] Add dep `@kingstinct/react-native-healthkit` (latest). `cd champ-app/mobile && npm install` then `npm install --package-lock-only` to sync the lock (EAS `npm ci` requires it).
- [ ] In `app.config.js` plugins: **remove** the `open-wearables` plugin entry; **add** `["@kingstinct/react-native-healthkit", { background: true, NSHealthShareUsageDescription: "UN1T reads your workouts and heart rate to score your sessions, track progress, and include you in gym challenges." }]`.
- [ ] **Verify:** `cd champ-app/mobile && npx expo config --type prefab >/dev/null` (or `npx expo-doctor`) parses without error. (Full native build is EAS — Richard runs it.)
- [ ] **Commit** — `chore(mobile): add @kingstinct/react-native-healthkit (background), drop open-wearables plugin`.

### Task 7: CRM api helper + sync lib (champ-app mobile)

**Files:** `champ-app/mobile/lib/crm-api.js`, `champ-app/mobile/lib/apple-health-sync.js`

- [ ] `crm-api.js` — `crmApi(path, { method, body })`: fetch `${CRM_BASE}${path}` with `Authorization: Bearer <member access_token>` (read the session token the same way `mobile/lib/api.js` does). `CRM_BASE` = `process.env.EXPO_PUBLIC_CRM_API_BASE_URL` (add to `.env.example`, default `https://crm.un1tdublin.com`).
- [ ] `apple-health-sync.js` — `syncAppleHealth({ sinceCursor })`: query HealthKit workouts with end-date `> sinceCursor` (default: 30 days ago on first run), gather HR + metric samples, `buildAppleHealthPayload(...)` (Task 5), `crmApi('/api/wearables/apple-health/ingest', { method:'POST', body })`, return the new cursor (max uploaded end-date). Cursor persisted in SecureStore by the caller.
- [ ] **No unit test** (native HealthKit IO); the pure shaping is tested in Task 5. **Commit** — `feat(mobile): apple-health-sync + crm-api`.

### Task 8: Rewrite connect screen (champ-app mobile) — NATIVE

**Files:** `champ-app/mobile/app/account/connect-apple-health.jsx`

- [ ] Replace `open-wearables` imports with `@kingstinct/react-native-healthkit`. Connect: `requestAuthorization([Workout, HeartRate, RestingHeartRate, ActiveEnergy, HeartRateVariabilitySDNN, Vo2Max])` → on grant, `configureBackgroundTypes(['HKWorkoutTypeIdentifier'], 'immediate')` → `crmApi('/api/wearables/apple-health/connect', { method:'POST' })` → initial `syncAppleHealth({ sinceCursor: 30-days-ago })` + store cursor. Disconnect: clear background types + `crmApi('/api/wearables/apple-health/connect', { method:'DELETE' })`. Keep the iOS-only guard + the existing UI states.
- [ ] **Device-verify (Richard, after EAS build).** **Commit** — `feat(mobile): connect Apple Health directly via HealthKit (drop OW SDK)`.

### Task 9: Background-delivery sync wiring (champ-app mobile) — NATIVE

**Files:** `champ-app/mobile/app/_layout.jsx` (or a dedicated `mobile/lib/apple-health-background.js`)

- [ ] Register the HealthKit background observer at app start (when a connection exists): on a background-delivery callback, run `syncAppleHealth({ sinceCursor })` + advance the stored cursor. Also run `syncAppleHealth` on app foreground (useFocusEffect on the relevant screen) as a belt-and-braces catch-up. Use the module's background-delivery API (`configureBackgroundTypes` persists; subscribe per its docs).
- [ ] **Device-verify (Richard).** **Commit** — `feat(mobile): background HealthKit delivery → auto-sync to UN1T`.

### Task 10: Phase 1 ship + verify gate

- [ ] un1t-crm: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build` → all green. Branch `apple-health-direct` → PR → merge.
- [ ] champ-app: `npm test && npm run lint && npm run build` → green. Branch → PR → merge (OTA won't carry the native module — needs an EAS build).
- [ ] **Hand-off to Richard:** trigger an EAS build (`eas build --profile preview --platform ios` or the Release workflow), install, connect Apple Health, do an Apple Watch workout, confirm it ingests + scores + shows on Progress/Sessions. **Do NOT start Phase 2 until this passes.**

---

## PHASE 2 — Decommission OW (after Phase 1 verified)

### Task 11: Remove OW from un1t-crm
- [ ] Delete `src/lib/openwearables.js`, `src/lib/openwearables-map.js` (+ tests), `src/app/api/webhooks/openwearables/` (+ test). Remove its route-guard exempt entry. Remove `OPENWEARABLES_*` from the env doc in `CLAUDE.md` + any references. `grep -rn "openwearables\|OPENWEARABLES\|open-wearables" src shared` → only intentional history remains.
- [ ] `npm test && lint && check:route-guards && build` green. Commit — `chore: remove OpenWearables (un1t-crm) — Apple Health is direct now`.

### Task 12: Remove OW from champ-app
- [ ] Delete `src/lib/openwearables.js`, `src/app/api/wearables/connect/` (+ test). Remove the `open-wearables` dep from `mobile/package.json` + sync lockfile. `grep -rn "openwearables\|open-wearables" src mobile shared` → clean.
- [ ] `npm test && lint && build` green. Commit — `chore: remove OpenWearables (champ-app)`.

### Task 13: Tear down Fly (operator step — Richard)
- [ ] Provide commands: `fly apps list` → identify the OW app + its Postgres → `fly apps destroy <ow-app>` + `fly apps destroy <ow-postgres>` (or `fly mpg destroy`). Remove `OPENWEARABLES_*` from Vercel (un1t-crm + champ-app) envs. Claude cannot access the Fly account — Richard runs these.

---

## Self-review

- **Spec coverage:** mapper (T1), ingest (T3), connect (T4), device payload (T5), native module/plugin (T6), sync+crm-api (T7), connect screen (T8), background (T9), full-parity data types (T8 auth list + T5 metrics), iOS-only (T8 guard kept), OW removal both repos (T11/T12), Fly teardown (T13), verify-before-teardown (T10 gate). ✓
- **Placeholders:** none — pure-lib tasks carry full test code; native tasks carry the exact module APIs (can't be unit-tested, so specified + device-verified, called out explicitly).
- **Type consistency:** `mapAppleHealthWorkoutToSession({ workout, hrSamples, maxHr, scoring })` and `raw_metadata.apple_workout_uuid` used consistently in T1/T3; `buildAppleHealthPayload` → `{ workouts:[{workout,hrSamples}], healthMetrics }` consistent T5/T3/T7; `resolveCustomerContact` consistent T2/T3/T4.
