# Apple Health — Direct HealthKit ingestion + OpenWearables decommission

**Date:** 2026-06-23
**Status:** Design approved (brainstorming) → ready for implementation plan
**Repos:** `champ-app` (native + connect endpoint), `un1t-crm` (ingestion + mapper + OW removal)

## Goal

Read a member's Apple Health workouts + heart rate **directly on-device** (HealthKit) and upload straight to UN1T, removing the OpenWearables (OW) relay and its Fly.io infrastructure entirely. Background auto-sync so Apple Watch workouts land within minutes without opening the app. iOS-only.

## Why now / context

- Apple Health via OW has carried **one** session + **one** connection ever (a test) — no real member base. The champ-app native app is **not yet on the App Store** (P4 packaging pending), so the required native-module swap is free (no shipped app to migrate, native rebuild expected).
- OW is a self-hosted Fly relay + RN SDK. The SDK (`open-wearables`) reads HealthKit on-device but syncs to the OW server, which relays to us via a Svix webhook. Strava already moved off OW (direct). Apple Health is the last OW consumer.
- Apple Health is **NOT** §5.4-restricted (that's Strava). Apple Health sessions keep earning UN1T points and feeding community/leaderboards — same as today.

## Architecture

Device reads HealthKit → uploads a batch to a customer-authed un1t-crm endpoint → mapped to `heart_rate_sessions` (+ `member_health_metrics`) → finalised (points). No server in the middle.

```
iPhone (champ-app native, iOS)
  @kingstinct/react-native-healthkit
   ├─ requestAuthorization (Workout, HeartRate, RestingHeartRate,
   │   ActiveEnergy, HeartRateVariabilitySDNN, Vo2Max)   ← same 6 types as OW
   ├─ configureBackgroundTypes([Workout], 'immediate')   ← background delivery
   └─ on connect + on background-wake + on app-open:
        read new workouts since cursor → POST batch ──────────────┐
                                                                   ▼
un1t-crm  POST /api/wearables/apple-health/ingest  (Bearer JWT = member)
   ├─ auth_contact_id() → contact
   ├─ per workout: mapAppleHealthWorkoutToSession(...) → heart_rate_sessions
   │     source='apple_health', dedup on the Apple workout UUID
   ├─ health-metric samples → member_health_metrics
   ├─ class-correlate (resolveCurrentOccurrence + lookupBookedMember) [reuse]
   └─ insert + finalizeSessionRewards [reuse, IB3 import-safe]
```

## Module choice (verified against current docs)

**`@kingstinct/react-native-healthkit`** — Expo config plugin with `background: true` (adds HealthKit entitlement + Background Modes + `NSHealthShareUsageDescription`), `configureBackgroundTypes(types, frequency)` for persistent background delivery (survives app termination), and `queryQuantitySamples` / workout queries. TypeScript-first, High reputation, actively maintained. Alternatives rejected: `react-native-health` (older, weaker Expo support), custom Swift Expo module (most work, unnecessary).

## Components

### un1t-crm

1. **`src/lib/apple-health-map.js`** (NEW, pure, TDD) — `mapAppleHealthWorkoutToSession({ workout, hrSamples, maxHr, scoring })` → a `heart_rate_sessions` row. Input is the **HealthKit-shaped** payload from the device (workout type, start/end, energy, avg/max HR, optional HR samples). Mirrors the field set the existing `openwearables-map.js#mapAppleWorkoutToSession` produces (so the finalise/zone math is unchanged), but takes our own upload shape rather than OW's Workout-Output. The existing mapper stays until OW removal, then is deleted.
2. **`POST /api/wearables/apple-health/ingest`** (NEW, customer-authed) — Bearer JWT → `auth_contact_id()`; body = `{ workouts: [...], healthMetrics: [...] }` (a batch). For each workout: map → class-correlate (reuse `resolveCurrentOccurrence` + `lookupBookedMember`) → dedup on the Apple workout UUID (`raw_metadata->>apple_workout_uuid`) + the strap-wins guard → insert → `finalizeSessionRewards` (reuse). Health-metric samples upsert into `member_health_metrics` (dedup on `(contact_id, metric, recorded_at)`). Idempotent: re-uploading the same workouts is a no-op. Returns counts.
3. **`POST` / `DELETE /api/wearables/apple-health/connect`** (NEW, customer-authed) — records / clears the `hr_provider_connections` row (`provider='apple_health'`, `status active|revoked`) so the connection state + consent are tracked. No server sign-in (there's no server). `provider_user_id` = the contact id (or a stable device-scoped id) — purely a presence marker now.

   > Auth: both endpoints derive the member from the Supabase Bearer JWT via the customer-auth path (same as the Progress/Sessions reads). **Not** RLS-trusting on a service-role route — the contact is resolved from the verified token, and writes are scoped to that contact.

### champ-app

4. **`mobile/app.config.js`** — remove the `open-wearables` plugin; add `["@kingstinct/react-native-healthkit", { background: true, NSHealthShareUsageDescription: "…" }]`. Add the dep to `mobile/package.json` + sync the lockfile (`npm install --package-lock-only`).
5. **`shared/apple-health-payload.js`** (NEW, pure, TDD) — turn HealthKit query results (workouts + HR + metric samples) into the `{ workouts, healthMetrics }` upload payload. Pure so it's unit-testable without HealthKit.
6. **`mobile/lib/apple-health-sync.js`** (NEW) — orchestration: read-since-cursor (cursor in SecureStore), build payload via the shared lib, POST via `api()`, advance cursor. Called on connect (initial 30-day backfill), on app-open (focus), and from the background-delivery handler.
7. **`mobile/app/account/connect-apple-health.jsx`** (REWRITE) — request HealthKit auth → `configureBackgroundTypes` → record connection (`/connect`) → initial sync. Disconnect: clear background types + `DELETE /connect`. Drop all `open-wearables` imports. iOS-only guard stays.
8. **`src/app/api/wearables/connect/route.js`** (champ-app, the OW connect endpoint) — removed in Phase 2.

## Data flow details

- **Dedup key:** the HealthKit workout `UUID` (stable per workout). Stored at `raw_metadata.apple_workout_uuid`. Re-uploads + overlapping backfills are idempotent.
- **Backfill:** on first connect, read workouts from the last **30 days** (matches the Strava backfill window). Cursor = the max workout end-date successfully uploaded; subsequent syncs read `> cursor`.
- **HR samples:** if the device includes per-sample HR for a workout, the mapper computes real zone seconds; otherwise it falls back to the workout's avg/max aggregates (the existing no-HR participation path in the mapper).
- **Health metrics:** resting HR, HRV (SDNN), VO2max, active energy → `member_health_metrics` (feeds the Progress "Recovery & fitness" trends — no regression vs OW).

## Decommission OW (Phase 2 — only after Phase 1 device-verified)

- **champ-app:** remove `open-wearables` dep + plugin, `src/lib/openwearables.js`, `src/app/api/wearables/connect/route.js` (+ test), any OW path left in the connect screen.
- **un1t-crm:** remove `src/lib/openwearables.js`, `src/lib/openwearables-map.js` (after the direct mapper is live), `src/app/api/webhooks/openwearables/route.js` (+ test), the `OPENWEARABLES_*` env vars (doc + Vercel), and any OW references in `CLAUDE.md`.
- **Fly:** destroy the OW app + its Postgres. **Operator step (Richard's Fly account):** `fly apps list` → `fly postgres ... destroy` / `fly apps destroy <ow-app>`. Exact commands provided at hand-off; Claude cannot access the Fly account.
- Keep `heart_rate_sessions` + `hr_provider_connections` + the 1 existing apple_health row (real, harmless).

## Sequencing

- **Phase 1 (build the direct path):** un1t-crm ingestion endpoint + mapper + connect endpoint (TDD) → champ-app native module swap + connect screen + sync lib → merge → **EAS native build** → Richard device-verifies (connect, do an Apple Watch workout, confirm it ingests + scores + shows on Progress).
- **Phase 2 (teardown):** after Phase 1 verified, remove all OW code + env across both repos → merge → Richard destroys the Fly app + Postgres.

## Testing

- **Unit (TDD):** `apple-health-map.js` (un1t-crm) + `apple-health-payload.js` (shared) — the pure mapping/shaping logic. Ingest-endpoint dedup/idempotency where mockable.
- **Device-verified (cannot unit-test HealthKit):** the connect flow, authorization prompt, background delivery, and end-to-end ingest. Richard verifies on his iPhone after the EAS build.

## Constraints

- **iOS-only** (HealthKit). Android stays guarded (Health Connect is a separate future effort).
- **Native rebuild, not an OTA** — the module swap changes native code; requires an EAS build + (eventually) store submission. Acceptable: the native app isn't shipped yet.
- **Verify before teardown** — do not remove the OW webhook / tear down Fly until the direct path is confirmed working on a real device. (Low stakes regardless: OW carries only 1 test record.)
- The Fly teardown is a manual ops step on Richard's account.
