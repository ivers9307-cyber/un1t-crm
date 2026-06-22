# Apple Health — session enrichment + recovery/fitness trends

**Date:** 2026-06-22
**Repos:** un1t-crm (ingestion) + champ-app (display), shared Supabase project `iyvtbjjxdggiadzwwvdj`.

**Goal:** Surface more of the Apple Health data that already flows (or can be pulled) through the Open Wearables (OW) integration:
1. **Session enrichment** — show each ingested workout's *type, calories, distance, pace* (already present in the `workout.created` payload; currently dropped).
2. **Recovery/fitness trends** — *resting heart rate, HRV (SDNN), VO₂ max* as trends on the champ-app Progress screen, ingested into our own DB.

**Locked decisions (Richard, 2026-06-22):**
- #2 ships the **full metric set** (RHR + HRV + VO₂ max), accepting a **native EAS rebuild** (new HealthKit read scopes) + members re-granting on next Connect open.
- Trends are **ingested & stored** in our DB (not pulled live), so we get history and can later feed challenges/leaderboards.
- **Heart-rate recovery is dropped** — the OW React Native SDK's `HealthDataType` enum doesn't expose it (only an OW server-side timeseries type), so Apple can't sync it.

**Out of scope (explicitly):** daily activity rings (steps/active-energy/exercise-min), body composition, sleep, and any clinical/special-category metric (blood glucose, blood pressure, AFib, menstrual cycles, etc.).

---

## Architecture & ownership

- **un1t-crm owns ingestion** — it has the OW REST client (IB1), the service-role Supabase client, the Vercel cron infra, and the IB5 webhook receiver.
- **champ-app owns display** — it reads the shared Supabase tables under customer RLS (`private.auth_contact_id()`), as it already does for `heart_rate_sessions`.
- **One migration** on the shared project: **mig 306** (next after 305).

Provider scoping: all logic is gated to `apple_health` connections. The session-enrichment mapper change is Apple-path only (the push-only branch added in #629). The trends cron iterates `hr_provider_connections WHERE provider='apple_health' AND status='active'`.

---

## Feature 1 — Session enrichment

### Data model (mig 306, part A)
Add four **nullable** columns to `heart_rate_sessions` (null for BLE / participation sessions — they have no such data):

```sql
ALTER TABLE heart_rate_sessions
  ADD COLUMN workout_type        text,
  ADD COLUMN calories_kcal       numeric,
  ADD COLUMN distance_meters     numeric,
  ADD COLUMN avg_pace_sec_per_km numeric;
COMMENT ON COLUMN heart_rate_sessions.workout_type IS 'OW/Apple workout type (e.g. running, cycling, functional_strength_training); apple_health sessions only';
```

### un1t-crm
- **`src/lib/openwearables-map.js`** (`mapAppleWorkoutToSession`): map the already-present payload fields onto the returned row — `workout_type` ← `w.type`, `calories_kcal` ← `w.calories_kcal`, `distance_meters` ← `w.distance_meters`, `avg_pace_sec_per_km` ← `w.avg_pace_sec_per_km`. Pure, defensive (coerce to number / null). Keep `raw_metadata.ow_type` as-is.
- No route change needed — IB5 already inserts the mapper's full output. Re-delivering the existing stored workout backfills its fields.

### champ-app (display, OTA-able — no native dep)
- Session card / report surfaces (`src/app/progress/ProgressView.jsx`, `mobile/app/(tabs)/progress.jsx`, `src/lib/hr-session-report.js` / `load-session-report.js` as relevant): render **workout type** (icon + human label), **calories**, and **distance + pace** when present. Hide each chip when null (class/strap sessions stay unchanged).
- A small pure formatter (workout-type → label/icon; pace seconds → `m:ss /km`; distance m → km) in `shared/` so web + native share it. Unit-tested.

---

## Feature 2 — Recovery/fitness trends

### Data model (mig 306, part B)
New table `member_health_metrics` — append-only time-series of sparse daily-ish metrics:

```sql
CREATE TABLE member_health_metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  location_id  uuid REFERENCES locations(id),
  metric       text NOT NULL,           -- 'resting_heart_rate' | 'heart_rate_variability_sdnn' | 'vo2_max'
  recorded_at  timestamptz NOT NULL,
  value        numeric NOT NULL,
  unit         text,
  source       text NOT NULL DEFAULT 'apple_health',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, metric, recorded_at)
);
CREATE INDEX idx_member_health_metrics_contact_metric
  ON member_health_metrics (contact_id, metric, recorded_at DESC);
ALTER TABLE member_health_metrics ENABLE ROW LEVEL SECURITY;
-- customer reads own
CREATE POLICY "Customers view own metrics" ON member_health_metrics
  FOR SELECT TO public USING (contact_id = (SELECT private.auth_contact_id()));
-- staff read at location (mirror heart_rate_sessions policy)
CREATE POLICY "Staff view location metrics" ON member_health_metrics
  FOR SELECT TO public USING (private.auth_is_in_location(location_id));
-- writes are service-role only (no authenticated/anon write policy)
```
`auth.uid()`/helpers wrapped in `(SELECT …)` per the RLS init-plan convention. Run the security advisor after applying.

Cron heartbeat row seeded in the same migration (`sync-wearable-trends`, daily interval + grace).

### un1t-crm — OW client (IB1)
- **`src/lib/openwearables.js`**: add `getTimeseries({ userId, types, startIso, endIso, resolution })` → `GET /api/v1/users/{userId}/timeseries?types=…&start_time=…&end_time=…&resolution=raw`, returning `[{ type, timestamp, value, unit }]` (paginate the `cursor` if present). Pure-ish wrapper, same error handling as the existing methods.

### un1t-crm — ingestion cron
- **`src/app/api/cron/sync-wearable-trends/route.js`** (daily, `CRON_SECRET`, `maxDuration=300`, `stampHeartbeat`): paginate active `apple_health` connections; for each, find the latest `recorded_at` per metric in `member_health_metrics`, pull from OW since `max(latest, now-90d)` for `[resting_heart_rate, heart_rate_variability_sdnn, vo2_max]`, upsert (`onConflict contact_id,metric,recorded_at`). First run backfills ~90 days.
- **`src/lib/wearable-trends.js`** (pure): OW timeseries samples → `member_health_metrics` rows (metric normalisation, value/unit coercion, drop non-finite, dedup). Unit-tested.
- `vercel.json`: add the cron entry.

### champ-app — native (requires EAS rebuild)
- **`mobile/app/account/connect-apple-health.jsx`**: add `HealthDataType.HeartRateVariabilitySDNN` + `HealthDataType.Vo2Max` to `SHARE_TYPES` (RestingHeartRate already present).
- **`mobile/app.config.js`**: bump `runtimeVersion` (native change → EAS build, NOT OTA). Operator runs the EAS build; members re-grant Health access next time they open Connect. RHR keeps flowing meanwhile (already permitted), so the trends section isn't blank pre-rebuild.

### champ-app — display
- New **"Recovery & fitness"** section on the Progress screen (`src/app/progress/ProgressView.jsx` + `mobile/app/(tabs)/progress.jsx`): RHR / HRV / VO₂ max, each a sparkline + latest value + trend direction (▲/▼/→ vs the window start), read from `member_health_metrics` under RLS.
- **`shared/wearable-trends-view.js`** (pure): rows → per-metric display model (`{ metric, label, unit, latest, direction, points[] }`), with sensible windows (RHR/HRV ~30–60d, VO₂ max ~180d). Section **hides any metric with no data**, so it degrades gracefully before the rebuild + re-grant. Unit-tested.

---

## Sequencing & ops

1. **Migration 306** applied to prod (Supabase MCP).
2. **un1t-crm PR A (Feature 1):** mapper enrichment + the session-enrichment columns usage. Auto-deploys; future + re-delivered workouts carry type/calories/distance/pace.
3. **un1t-crm PR B (Feature 2 ingestion):** OW `getTimeseries` + `wearable-trends.js` + the cron + vercel.json. RHR trends start populating immediately (RHR already permitted).
4. **champ-app PR (display):** session-enrichment chips + the Recovery & fitness section + the shared formatters. Web live; native via OTA for the display.
5. **Operator (native):** `runtimeVersion` bump is in the champ-app PR; operator runs the **EAS build** so HRV + VO₂ max permissions ship; members re-grant on next Connect open → those two metrics begin populating.

Land **Feature 1 first** (small, no rebuild, immediate win), then Feature 2.

---

## Consent / privacy
RHR, HRV, and VO₂ max are fitness metrics, consistent with the HR data we already store; the member explicitly connects Apple Health and grants each read scope (visible per-type in the iOS sheet). Clinical/special-category types are deliberately excluded from `SHARE_TYPES` and from ingestion. `member_health_metrics` is customer-own + staff-at-location RLS, service-role writes — same posture as `heart_rate_sessions`.

## Testing
- **Pure, no DB:** `openwearables-map` enrichment fields; `wearable-trends.js` (OW samples → rows); `shared/wearable-trends-view.js` (rows → display model); the session/pace/distance formatters.
- **Route:** `sync-wearable-trends` cron (auth gate, per-connection pull + upsert shape, since-last-point logic) with the OW client + Supabase mocked.
- Extend the existing `openwearables/route.test.js` to assert the new mapped fields on the inserted session.

## Open questions
None — all design decisions resolved. (Migration number 306 to be re-verified against `supabase/migrations/` at implementation time.)
