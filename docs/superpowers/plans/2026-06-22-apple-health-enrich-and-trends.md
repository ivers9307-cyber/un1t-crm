# Apple Health — Session Enrichment + Recovery/Fitness Trends — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Apple-Health workout detail (type/calories/distance/pace) on each session, and ingest + display resting-HR / HRV / VO₂-max trends on the champ-app Progress screen.

**Architecture:** un1t-crm owns ingestion (migrations, the IB2 mapper enrichment, a generic OW `getTimeseries` client method, and a daily `sync-wearable-trends` cron writing to a new `member_health_metrics` table). champ-app owns display (session chips + a "Recovery & fitness" Progress section), reading the shared Supabase tables under customer RLS. All logic is `apple_health`-scoped.

**Tech Stack:** Next.js 16 + Supabase (un1t-crm), Expo/React Native + Next.js (champ-app), Vitest, the OW REST client (`src/lib/openwearables.js`), shared pure libs in `shared/`.

**Spec:** `docs/superpowers/specs/2026-06-22-apple-health-enrich-and-trends-design.md`

**Refinement of spec:** the single "mig 306" is split into **mig 306** (Feature-1 columns) + **mig 307** (Feature-2 table) so Feature 1 ships fully independently with no unused table.

**Repos / branches:** un1t-crm work on `apple-health-enrich-trends` (already created off main; the spec doc lives there). champ-app work on a sibling `apple-health-enrich-trends` branch off its `main`. Ship Feature 1 (Tasks 1–7) before starting Feature 2 (Tasks 8–16).

**Pre-push CI mirror (un1t-crm):** `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`. champ-app: `npm test && npm run lint`.

---

## FEATURE 1 — Session enrichment (land + ship first)

### Task 1: Migration 306 — enrichment columns on `heart_rate_sessions`

**Files:**
- Create: `un1t-crm/supabase/migrations/306_hr_session_workout_detail.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 306: Apple-Health workout detail on heart_rate_sessions.
-- Nullable; populated only for source='apple_health' rows by the IB2 mapper.
-- BLE / participation sessions leave these null.
ALTER TABLE heart_rate_sessions
  ADD COLUMN IF NOT EXISTS workout_type        text,
  ADD COLUMN IF NOT EXISTS calories_kcal       numeric,
  ADD COLUMN IF NOT EXISTS distance_meters     numeric,
  ADD COLUMN IF NOT EXISTS avg_pace_sec_per_km numeric;

COMMENT ON COLUMN heart_rate_sessions.workout_type IS
  'OW/Apple workout type (e.g. running, cycling, functional_strength_training); apple_health sessions only (mig 306)';
```

- [ ] **Step 2: Apply via Supabase MCP** (`apply_migration`, name `306_hr_session_workout_detail`). Expected: success.

- [ ] **Step 3: Verify** — `execute_sql`:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='heart_rate_sessions'
  AND column_name IN ('workout_type','calories_kcal','distance_meters','avg_pace_sec_per_km');
```
Expected: 4 rows.

- [ ] **Step 4: Run the security advisor** (`get_advisors` type=security). Expected: no new findings on `heart_rate_sessions`.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/306_hr_session_workout_detail.sql
git commit -m "mig 306 — apple workout detail columns on heart_rate_sessions"
```

---

### Task 2: IB2 mapper — emit workout detail

**Files:**
- Modify: `un1t-crm/src/lib/openwearables-map.js` (`mapAppleWorkoutToSession`, the `base` object)
- Test: `un1t-crm/src/lib/openwearables-map.test.js`

- [ ] **Step 1: Write the failing test** — append to the describe block:

```js
it('maps workout detail (type/calories/distance/pace) from the payload', () => {
  const row = mapAppleWorkoutToSession({
    workout: {
      id: 'w1', type: 'running', start_time: '2026-06-20T10:00:00Z', end_time: '2026-06-20T10:30:00Z',
      calories_kcal: 320, distance_meters: 5200, avg_pace_sec_per_km: 346,
    },
    hrSamples: [], maxHr: 190, scoring: { participationPoints: 50 },
  })
  expect(row.workout_type).toBe('running')
  expect(row.calories_kcal).toBe(320)
  expect(row.distance_meters).toBe(5200)
  expect(row.avg_pace_sec_per_km).toBe(346)
})

it('leaves workout detail null when absent', () => {
  const row = mapAppleWorkoutToSession({ workout: { id: 'w2' }, hrSamples: [], maxHr: 190, scoring: {} })
  expect(row.workout_type).toBeNull()
  expect(row.calories_kcal).toBeNull()
  expect(row.distance_meters).toBeNull()
  expect(row.avg_pace_sec_per_km).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/openwearables-map.test.js`. Expected: FAIL (fields undefined).

- [ ] **Step 3: Implement** — in `mapAppleWorkoutToSession`, add a numeric coercer and extend the `base` object:

```js
// near the top of the function, after `const w = workout || {}`
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
```
Add to the `base` object (alongside `source`, `started_at`, …):
```js
    workout_type: w.type ?? null,
    calories_kcal: num(w.calories_kcal),
    distance_meters: num(w.distance_meters),
    avg_pace_sec_per_km: num(w.avg_pace_sec_per_km),
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/lib/openwearables-map.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/openwearables-map.js src/lib/openwearables-map.test.js
git commit -m "IB2 — map apple workout type/calories/distance/pace onto the session"
```

---

### Task 3: Webhook route test — assert detail flows through to the insert

**Files:**
- Modify: `un1t-crm/src/app/api/webhooks/openwearables/route.test.js`

No route code change — IB5 inserts the mapper's full output. This pins the wiring.

- [ ] **Step 1: Add the assertion** — in the existing `WORKOUT` fixture, ensure detail fields are present (`type: 'functional_strength_training'`, `calories_kcal: 320`, plus add `distance_meters: 1200`, `avg_pace_sec_per_km: 300`). In the "fresh workout → inserts" test, after the existing `row` assertions add:

```js
expect(row.workout_type).toBe('functional_strength_training')
expect(row.calories_kcal).toBe(320)
expect(row.distance_meters).toBe(1200)
expect(row.avg_pace_sec_per_km).toBe(300)
```

- [ ] **Step 2: Run** — `npx vitest run src/app/api/webhooks/openwearables/route.test.js`. Expected: PASS (22+ tests).

- [ ] **Step 3: Commit**
```bash
git add src/app/api/webhooks/openwearables/route.test.js
git commit -m "test: assert apple workout detail lands on the inserted session"
```

---

### Task 4: champ-app — pure workout-detail formatters (shared)

**Files:**
- Create: `champ-app/shared/workout-detail.js`
- Test: `champ-app/shared/workout-detail.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { workoutLabel, workoutIcon, formatPace, formatDistance, sessionDetailChips } from './workout-detail.js'

describe('workout-detail', () => {
  it('labels known workout types and title-cases unknown', () => {
    expect(workoutLabel('functional_strength_training')).toBe('Strength')
    expect(workoutLabel('running')).toBe('Run')
    expect(workoutLabel('open_water_swim')).toBe('Open Water Swim')
    expect(workoutLabel(null)).toBe('Workout')
  })
  it('maps types to an icon key (default for unknown)', () => {
    expect(workoutIcon('running')).toBe('run')
    expect(workoutIcon('cycling')).toBe('bike')
    expect(workoutIcon('mystery')).toBe('activity')
  })
  it('formats pace as m:ss /km and distance as km', () => {
    expect(formatPace(346)).toBe('5:46 /km')
    expect(formatPace(null)).toBeNull()
    expect(formatDistance(5200)).toBe('5.2 km')
    expect(formatDistance(null)).toBeNull()
  })
  it('builds only the chips that have data', () => {
    expect(sessionDetailChips({ calories_kcal: 320, distance_meters: 5200, avg_pace_sec_per_km: 346 }))
      .toEqual([{ key: 'calories', label: '320 kcal' }, { key: 'distance', label: '5.2 km' }, { key: 'pace', label: '5:46 /km' }])
    expect(sessionDetailChips({ calories_kcal: null, distance_meters: null, avg_pace_sec_per_km: null })).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd champ-app && npx vitest run shared/workout-detail.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// Pure presentation helpers for Apple-Health workout detail on a session.
const LABELS = {
  running: 'Run', walking: 'Walk', cycling: 'Ride', indoor_cycling: 'Ride',
  functional_strength_training: 'Strength', traditional_strength_training: 'Strength',
  high_intensity_interval_training: 'HIIT', swimming: 'Swim', rowing: 'Row',
  elliptical: 'Elliptical', yoga: 'Yoga', core_training: 'Core',
}
const ICONS = {
  running: 'run', walking: 'run', cycling: 'bike', indoor_cycling: 'bike',
  functional_strength_training: 'dumbbell', traditional_strength_training: 'dumbbell',
  high_intensity_interval_training: 'flame', swimming: 'swim', rowing: 'row',
}
function titleCase(s) {
  return String(s).split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}
export function workoutLabel(type) {
  if (!type) return 'Workout'
  return LABELS[type] || titleCase(type)
}
export function workoutIcon(type) {
  return (type && ICONS[type]) || 'activity'
}
export function formatPace(secPerKm) {
  if (secPerKm === null || secPerKm === undefined || !Number.isFinite(Number(secPerKm))) return null
  const s = Math.round(Number(secPerKm))
  const m = Math.floor(s / 60)
  const r = String(s % 60).padStart(2, '0')
  return `${m}:${r} /km`
}
export function formatDistance(meters) {
  if (meters === null || meters === undefined || !Number.isFinite(Number(meters))) return null
  return `${(Number(meters) / 1000).toFixed(1)} km`
}
export function sessionDetailChips(session) {
  const chips = []
  const kcal = session?.calories_kcal
  if (kcal !== null && kcal !== undefined && Number.isFinite(Number(kcal))) {
    chips.push({ key: 'calories', label: `${Math.round(Number(kcal))} kcal` })
  }
  const dist = formatDistance(session?.distance_meters)
  if (dist) chips.push({ key: 'distance', label: dist })
  const pace = formatPace(session?.avg_pace_sec_per_km)
  if (pace) chips.push({ key: 'pace', label: pace })
  return chips
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run shared/workout-detail.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** (in champ-app)
```bash
git add shared/workout-detail.js shared/workout-detail.test.js
git commit -m "champ-app: pure workout-detail formatters (type/pace/distance/chips)"
```

---

### Task 5: champ-app web — show detail on the session view

**Files:**
- Modify: `champ-app/src/app/progress/ProgressView.jsx` (and/or the session-report component it renders — read first to find where a single session renders)

- [ ] **Step 1: Read** `ProgressView.jsx` + any `SessionReport`/`SessionCard` it imports to locate where one session's header/metrics render. Confirm the session query selects the new columns (`workout_type, calories_kcal, distance_meters, avg_pace_sec_per_km`) — add them to the `.select(...)` if a column list is used (a `*` select needs no change).

- [ ] **Step 2: Implement** — import `{ workoutLabel, workoutIcon, sessionDetailChips } from '@/shared/workout-detail'` (match the repo's existing shared import alias). For an `apple_health` session, render the **type label** in the session title/subtitle and a chip row from `sessionDetailChips(session)` next to the existing HR stats. Render nothing extra when `sessionDetailChips` returns `[]` (class/strap sessions unchanged).

- [ ] **Step 3: Verify build/lint** — `cd champ-app && npm run lint`. Expected: clean. (No unit test for JSX; the formatter is covered by Task 4.)

- [ ] **Step 4: Commit**
```bash
git add src/app/progress/ProgressView.jsx
git commit -m "champ-app web: show workout type + calories/distance/pace on apple sessions"
```

---

### Task 6: champ-app native — show detail on the session view

**Files:**
- Modify: `champ-app/mobile/app/(tabs)/progress.jsx` (+ any session detail screen it pushes to)

- [ ] **Step 1: Read** `mobile/app/(tabs)/progress.jsx` to find the session row/detail render. Mobile cannot import `src/lib` but **can** import `shared/` (the seam) — import the formatters from the shared path the mobile app already uses for shared libs (mirror an existing `shared/` import in `mobile/`).

- [ ] **Step 2: Implement** — render `workoutLabel(session.workout_type)` + the `sessionDetailChips(session)` row using the existing NativeWind chip/`Text` styling in that screen. Render nothing when chips is empty.

- [ ] **Step 3: Verify** — `cd champ-app && npm run check:mobile-imports` if present, else `npm run lint`. Expected: clean.

- [ ] **Step 4: Commit**
```bash
git add mobile/app/(tabs)/progress.jsx
git commit -m "champ-app native: show workout type + calories/distance/pace on apple sessions"
```

---

### Task 7: Ship Feature 1

- [ ] **Step 1: un1t-crm CI mirror** — `cd un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`. Expected: all green.
- [ ] **Step 2: Push + PR (un1t-crm)** — `git push -u origin apple-health-enrich-trends`; open PR base `main` (mig 306 + mapper + route test). Merge after Vercel + Test&lint green.
- [ ] **Step 3: champ-app CI** — `cd champ-app && npm test && npm run lint`. Expected: green.
- [ ] **Step 4: Push + PR (champ-app)** — branch `apple-health-enrich-trends`; PR base `main` (formatters + web/native display). Merge after checks green. Web deploys; native display OTAs.
- [ ] **Step 5: Verify on prod** — re-resend the stored `workout.created` (Svix) and confirm the session now carries `workout_type`/`calories_kcal`/`distance_meters`/`avg_pace_sec_per_km`:
```sql
SELECT workout_type, calories_kcal, distance_meters, avg_pace_sec_per_km
FROM heart_rate_sessions WHERE source='apple_health' ORDER BY created_at DESC LIMIT 3;
```

---

## FEATURE 2 — Recovery/fitness trends

### Task 8: Migration 307 — `member_health_metrics`

**Files:**
- Create: `un1t-crm/supabase/migrations/307_member_health_metrics.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 307: sparse daily-ish recovery/fitness metrics ingested from OW (Apple).
CREATE TABLE IF NOT EXISTS member_health_metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  location_id  uuid REFERENCES locations(id),
  metric       text NOT NULL,
  recorded_at  timestamptz NOT NULL,
  value        numeric NOT NULL,
  unit         text,
  source       text NOT NULL DEFAULT 'apple_health',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, metric, recorded_at)
);
CREATE INDEX IF NOT EXISTS idx_member_health_metrics_contact_metric
  ON member_health_metrics (contact_id, metric, recorded_at DESC);

ALTER TABLE member_health_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers view own health metrics" ON member_health_metrics
  FOR SELECT TO public USING (contact_id = (SELECT private.auth_contact_id()));
CREATE POLICY "Staff view location health metrics" ON member_health_metrics
  FOR SELECT TO public USING (private.auth_is_in_location(location_id));
-- writes: service-role only (no anon/authenticated write policy)

INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds)
VALUES ('sync-wearable-trends', 86400, 21600)
ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 2: Apply via MCP** (`apply_migration`, `307_member_health_metrics`). Expected: success.
- [ ] **Step 3: Run the security advisor** (`get_advisors` type=security). Expected: no ERROR on `member_health_metrics` (RLS enabled, policies present, `auth_contact_id` wrapped in SELECT).
- [ ] **Step 4: Commit**
```bash
git add supabase/migrations/307_member_health_metrics.sql
git commit -m "mig 307 — member_health_metrics table + RLS + cron heartbeat"
```

---

### Task 9: OW client — `getTimeseries`

**Files:**
- Modify: `un1t-crm/src/lib/openwearables.js` (add a method beside `getHeartRateTimeseries`)
- Test: `un1t-crm/src/lib/openwearables.test.js` (create if absent; mock `global.fetch`)

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOpenWearablesClient } from './openwearables.js'

const ENV = { OPENWEARABLES_BASE_URL: 'https://ow.test', OPENWEARABLES_API_KEY: 'sk-x', OPENWEARABLES_APP_ID: 'a', OPENWEARABLES_APP_SECRET: 's' }
beforeEach(() => { Object.assign(process.env, ENV) })
afterEach(() => { vi.restoreAllMocks() })

it('getTimeseries pages and returns typed samples', async () => {
  const pages = [
    { data: [{ type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' }], pagination: { has_more: true, next_cursor: 'c1' } },
    { data: [{ type: 'vo2_max', timestamp: '2026-06-21T00:00:00Z', value: 48.2, unit: 'mL/min·kg' }], pagination: { has_more: false } },
  ]
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(pages.shift()) }))
  const client = createOpenWearablesClient()
  const out = await client.getTimeseries({ userId: 'u1', types: ['resting_heart_rate', 'vo2_max'], startIso: '2026-06-01T00:00:00Z', endIso: '2026-06-30T00:00:00Z' })
  expect(out).toHaveLength(2)
  expect(out[0].type).toBe('resting_heart_rate')
  expect(global.fetch).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/openwearables.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement** — add inside the returned client object, mirroring `getHeartRateTimeseries`:

```js
    /**
     * Generic time-series pull. `types` is an array of OW SeriesType keys
     * (e.g. 'resting_heart_rate','heart_rate_variability_sdnn','vo2_max').
     * Returns flat samples [{ type, timestamp, value, unit }] across all types.
     */
    async getTimeseries({ userId, types, startIso, endIso } = {}) {
      if (!userId || !Array.isArray(types) || types.length === 0 || !startIso || !endIso) {
        throw new Error('getTimeseries requires userId, non-empty types[], startIso, endIso')
      }
      const HARD_PAGE_LIMIT = 1000
      const samples = []
      let cursor
      let more = true
      let pages = 0
      while (more && pages < HARD_PAGE_LIMIT) {
        const res = await request(`/api/v1/users/${encodeURIComponent(userId)}/timeseries`, {
          query: { start_time: startIso, end_time: endIso, types, cursor },
        })
        const page = Array.isArray(res?.data) ? res.data : []
        samples.push(...page)
        pages += 1
        const pagination = res?.pagination || {}
        cursor = pagination.next_cursor
        more = Boolean(pagination.has_more && cursor)
      }
      return samples
    },
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/lib/openwearables.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/openwearables.js src/lib/openwearables.test.js
git commit -m "IB1 — add generic getTimeseries to the OW client"
```

---

### Task 10: Pure trends-shaping lib

**Files:**
- Create: `un1t-crm/src/lib/wearable-trends.js`
- Test: `un1t-crm/src/lib/wearable-trends.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { TREND_METRICS, samplesToMetricRows } from './wearable-trends.js'

describe('wearable-trends', () => {
  it('exposes the three OW series types we ingest', () => {
    expect(TREND_METRICS).toEqual(['resting_heart_rate', 'heart_rate_variability_sdnn', 'vo2_max'])
  })
  it('maps OW samples → member_health_metrics rows, dropping junk + deduping', () => {
    const rows = samplesToMetricRows({
      contactId: 'c1', locationId: 'loc1',
      samples: [
        { type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' },
        { type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' }, // dup
        { type: 'vo2_max', timestamp: '2026-06-21T00:00:00Z', value: '48.2', unit: 'mL/min·kg' },
        { type: 'resting_heart_rate', timestamp: 'bad', value: 50 },     // bad ts
        { type: 'steps', timestamp: '2026-06-20T00:00:00Z', value: 9000 }, // not a trend metric
        { type: 'vo2_max', timestamp: '2026-06-22T00:00:00Z', value: null }, // non-finite
      ],
    })
    expect(rows).toEqual([
      { contact_id: 'c1', location_id: 'loc1', metric: 'resting_heart_rate', recorded_at: '2026-06-20T00:00:00.000Z', value: 52, unit: 'count/min', source: 'apple_health' },
      { contact_id: 'c1', location_id: 'loc1', metric: 'vo2_max', recorded_at: '2026-06-21T00:00:00.000Z', value: 48.2, unit: 'mL/min·kg', source: 'apple_health' },
    ])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/wearable-trends.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// Pure: OW timeseries samples → member_health_metrics insert rows.
export const TREND_METRICS = ['resting_heart_rate', 'heart_rate_variability_sdnn', 'vo2_max']
const ALLOWED = new Set(TREND_METRICS)

export function samplesToMetricRows({ contactId, locationId = null, samples } = {}) {
  const seen = new Set()
  const rows = []
  for (const s of Array.isArray(samples) ? samples : []) {
    const metric = s?.type
    if (!ALLOWED.has(metric)) continue
    const t = Date.parse(s?.timestamp)
    if (!Number.isFinite(t)) continue
    const value = Number(s?.value)
    if (s?.value === null || s?.value === undefined || s?.value === '' || !Number.isFinite(value)) continue
    const recorded_at = new Date(t).toISOString()
    const key = `${metric}|${recorded_at}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      contact_id: contactId, location_id: locationId, metric, recorded_at,
      value, unit: s?.unit ?? null, source: 'apple_health',
    })
  }
  return rows
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/lib/wearable-trends.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/wearable-trends.js src/lib/wearable-trends.test.js
git commit -m "trends: pure OW-samples → member_health_metrics row mapper"
```

---

### Task 11: `sync-wearable-trends` cron

**Files:**
- Create: `un1t-crm/src/app/api/cron/sync-wearable-trends/route.js`
- Modify: `un1t-crm/vercel.json` (add the cron)
- Test: `un1t-crm/src/app/api/cron/sync-wearable-trends/route.test.js`

Read `src/app/api/cron/credit-attendance/route.js` first for the exact auth-gate + `stampHeartbeat` + `maxDuration` + paginated-read conventions, and mirror them.

- [ ] **Step 1: Write the failing test** (mock `@/lib/supabase`, `@/lib/openwearables`, `@/lib/cron-heartbeat`):

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/openwearables', () => ({ createOpenWearablesClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn() }))
import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { createOpenWearablesClient } from '@/lib/openwearables'

function req(secret) { return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? `Bearer ${secret}` : null) } } }

beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = 'sek' })

it('401s without the cron secret', async () => {
  const res = await GET(req('nope'))
  expect(res.status).toBe(401)
})

it('pulls per active apple connection and upserts mapped rows', async () => {
  const upsert = vi.fn(() => ({ then: (r) => r({ error: null }) }))
  // connections page, then the per-metric latest lookups, then upsert
  const db = {
    from: vi.fn((t) => {
      if (t === 'hr_provider_connections') return { select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: [{ contact_id: 'c1', provider_user_id: 'u1' }], error: null }) }) }) }) }) }
      if (t === 'contacts') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'c1', location_id: 'loc1' } }) }) }) }
      if (t === 'member_health_metrics') return {
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) }),
        upsert,
      }
      return {}
    }),
  }
  createServerClient.mockReturnValue(db)
  createOpenWearablesClient.mockReturnValue({
    getTimeseries: vi.fn(async () => [{ type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' }]),
  })
  const res = await GET(req('sek'))
  const json = await res.json()
  expect(res.status).toBe(200)
  expect(json.success).toBe(true)
  expect(upsert).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/app/api/cron/sync-wearable-trends/route.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement** the route — auth-gate on `CRON_SECRET`; `export const runtime='nodejs'`, `export const maxDuration=300`. Paginate `hr_provider_connections` where `provider='apple_health'` and `status='active'` (use the `.range()` pagination pattern from CLAUDE.md). For each: load the contact (`id, location_id`); compute `startIso = max(latest recorded_at across TREND_METRICS, now-90d)`; `client.getTimeseries({ userId: provider_user_id, types: TREND_METRICS, startIso, endIso: now })`; `rows = samplesToMetricRows({ contactId, locationId, samples })`; `db.from('member_health_metrics').upsert(rows, { onConflict: 'contact_id,metric,recorded_at' })` when non-empty. Wrap each connection in try/catch (one member's OW failure must not abort the batch). On success: `stampHeartbeat('sync-wearable-trends')`, return `{ success:true, connections, inserted }`. Import `{ TREND_METRICS, samplesToMetricRows } from '@/lib/wearable-trends'`.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/app/api/cron/sync-wearable-trends/route.test.js`. Expected: PASS.

- [ ] **Step 5: Add to `vercel.json`** `crons`:
```json
{ "path": "/api/cron/sync-wearable-trends", "schedule": "0 5 * * *" }
```

- [ ] **Step 6: route-guards** — `npm run check:route-guards`. Expected: the new cron recognised (CRON_SECRET guard).

- [ ] **Step 7: Commit**
```bash
git add src/app/api/cron/sync-wearable-trends/route.js src/app/api/cron/sync-wearable-trends/route.test.js vercel.json
git commit -m "cron: sync-wearable-trends — pull RHR/HRV/VO2max from OW into member_health_metrics"
```

---

### Task 12: champ-app — pure trend-view lib (shared)

**Files:**
- Create: `champ-app/shared/wearable-trends-view.js`
- Test: `champ-app/shared/wearable-trends-view.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { buildTrendViews, TREND_META } from './wearable-trends-view.js'

describe('wearable-trends-view', () => {
  it('groups rows by metric → display model with latest + direction + points', () => {
    const rows = [
      { metric: 'resting_heart_rate', recorded_at: '2026-06-01T00:00:00Z', value: 56, unit: 'count/min' },
      { metric: 'resting_heart_rate', recorded_at: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' },
      { metric: 'vo2_max', recorded_at: '2026-06-10T00:00:00Z', value: 47, unit: 'mL/min·kg' },
    ]
    const views = buildTrendViews(rows)
    const rhr = views.find((v) => v.metric === 'resting_heart_rate')
    expect(rhr.label).toBe('Resting heart rate')
    expect(rhr.latest).toBe(52)
    expect(rhr.direction).toBe('down')        // 56 → 52
    expect(rhr.improving).toBe(true)          // lower RHR is better
    expect(rhr.points.map((p) => p.value)).toEqual([56, 52])
    expect(views.find((v) => v.metric === 'heart_rate_variability_sdnn')).toBeUndefined() // no data → omitted
  })
  it('returns [] for no rows', () => { expect(buildTrendViews([])).toEqual([]) })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd champ-app && npx vitest run shared/wearable-trends-view.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// Pure: member_health_metrics rows → per-metric display models for the
// "Recovery & fitness" Progress section. Metrics with no rows are omitted.
export const TREND_META = {
  resting_heart_rate:          { label: 'Resting heart rate', unit: 'bpm', lowerIsBetter: true },
  heart_rate_variability_sdnn: { label: 'HRV', unit: 'ms', lowerIsBetter: false },
  vo2_max:                     { label: 'VO₂ max', unit: 'mL/kg/min', lowerIsBetter: false },
}
const ORDER = ['resting_heart_rate', 'heart_rate_variability_sdnn', 'vo2_max']

export function buildTrendViews(rows) {
  const byMetric = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!TREND_META[r?.metric]) continue
    const t = Date.parse(r?.recorded_at)
    const v = Number(r?.value)
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, [])
    byMetric.get(r.metric).push({ t, recorded_at: r.recorded_at, value: v })
  }
  const views = []
  for (const metric of ORDER) {
    const pts = byMetric.get(metric)
    if (!pts || pts.length === 0) continue
    pts.sort((a, b) => a.t - b.t)
    const meta = TREND_META[metric]
    const first = pts[0].value
    const latest = pts[pts.length - 1].value
    const delta = latest - first
    const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
    const improving = delta === 0 ? null : meta.lowerIsBetter ? delta < 0 : delta > 0
    views.push({
      metric, label: meta.label, unit: meta.unit,
      latest, direction, improving,
      points: pts.map((p) => ({ recorded_at: p.recorded_at, value: p.value })),
    })
  }
  return views
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run shared/wearable-trends-view.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add shared/wearable-trends-view.js shared/wearable-trends-view.test.js
git commit -m "champ-app: pure trend-view lib (rows → per-metric display model)"
```

---

### Task 13: champ-app web — "Recovery & fitness" section

**Files:**
- Modify: `champ-app/src/app/progress/ProgressView.jsx` (or its server `page.jsx` for the data load)

- [ ] **Step 1: Read** `src/app/progress/page.jsx` + `ProgressView.jsx` to find how session data is loaded (server component query vs client fetch) and mirror it for the metrics query.

- [ ] **Step 2: Load metrics** — query `member_health_metrics` for the current contact over the last 180 days (`select('metric, recorded_at, value, unit').gte('recorded_at', cutoff).order('recorded_at')`), RLS scopes to the member. Pass to `buildTrendViews(rows)`.

- [ ] **Step 3: Render** — a "Recovery & fitness" card listing each view: label, `latest` + `unit`, a direction indicator (▲/▼/→) coloured by `improving` (green when true, neutral when null), and a small sparkline from `points` (reuse the existing chart/sparkline component the Progress screen already uses; if none, a minimal inline SVG polyline). Render the whole card only when `views.length > 0`.

- [ ] **Step 4: Lint** — `npm run lint`. Expected: clean.

- [ ] **Step 5: Commit**
```bash
git add src/app/progress/
git commit -m "champ-app web: Recovery & fitness trends section on Progress"
```

---

### Task 14: champ-app native — "Recovery & fitness" section

**Files:**
- Modify: `champ-app/mobile/app/(tabs)/progress.jsx`

- [ ] **Step 1: Read** the screen to find its data-load pattern (Supabase client query) + existing card styling.
- [ ] **Step 2: Load + build** — query `member_health_metrics` (last 180d, ordered), `buildTrendViews(rows)` from the shared lib.
- [ ] **Step 3: Render** — a "Recovery & fitness" section mirroring the web card: per-metric label, latest+unit, direction arrow coloured by `improving`, simple sparkline (`react-native-svg` is already a dep). Hide when empty.
- [ ] **Step 4: Verify** — `npm run check:mobile-imports` (if present) / `npm run lint`. Expected: clean.
- [ ] **Step 5: Commit**
```bash
git add mobile/app/(tabs)/progress.jsx
git commit -m "champ-app native: Recovery & fitness trends section on Progress"
```

---

### Task 15: champ-app native — expand HealthKit scopes + bump runtimeVersion

**Files:**
- Modify: `champ-app/mobile/app/account/connect-apple-health.jsx` (`SHARE_TYPES`)
- Modify: `champ-app/mobile/app.config.js` (`runtimeVersion`)

- [ ] **Step 1: Add scopes** — in `SHARE_TYPES`, add `HealthDataType.HeartRateVariabilitySDNN` and `HealthDataType.Vo2Max` (RestingHeartRate already present). Update the file-header comment list to match.
- [ ] **Step 2: Bump runtimeVersion** — increment `runtimeVersion` in `app.config.js` (native change → new EAS build; not OTA). Match the repo's existing version scheme.
- [ ] **Step 3: Verify config** — `cd mobile && npx expo config --type introspect >/dev/null` (no error) and confirm lockfile in sync if `package.json` changed (it doesn't here).
- [ ] **Step 4: Commit**
```bash
git add mobile/app/account/connect-apple-health.jsx mobile/app.config.js
git commit -m "champ-app native: request HRV + VO2max HealthKit scopes; bump runtimeVersion"
```

---

### Task 16: Ship Feature 2 + operator rebuild

- [ ] **Step 1: un1t-crm CI mirror** (as Task 7 Step 1). Push the Feature-2 commits on `apple-health-enrich-trends`; PR base `main`; merge after green. RHR trends begin populating on the next daily cron (RHR already permitted).
- [ ] **Step 2: champ-app CI** — `npm test && npm run lint`. Push; PR base `main`; merge. Web + native display land (native via OTA for the display; the new scopes need the rebuild).
- [ ] **Step 3: Operator action (manual)** — run the **EAS native build** for champ-app (runtimeVersion bumped); distribute; members re-open Connect Apple Health and re-grant → HRV + VO₂ max begin syncing → appear on next cron.
- [ ] **Step 4: Verify** — after the cron runs (or trigger it: `curl -H "Authorization: Bearer $CRON_SECRET" https://crm.un1tdublin.com/api/cron/sync-wearable-trends`), check:
```sql
SELECT metric, count(*), max(recorded_at) FROM member_health_metrics GROUP BY metric;
```
Expected: `resting_heart_rate` rows (immediately); HRV + VO₂ max after the rebuild + re-grant.

---

## Notes for the implementer
- **champ-app shared imports:** mobile imports from `shared/` (the seam), never `src/lib`. Match the exact import style already used in `mobile/` for shared modules.
- **No new web→mobile permission keys** are added, so `check:mobile-parity` is unaffected.
- **Vercel build is the real gate** — green Test&lint ≠ safe to merge. New imports added: `getTimeseries`, `samplesToMetricRows`/`TREND_METRICS` (un1t-crm), the two shared champ-app libs. Confirm the Vercel PR check is green before merging.
- **RLS:** `member_health_metrics` is service-role-write; the cron uses `createServerClient()`. Never claim "RLS scopes the cron" — it doesn't (service role bypasses RLS); the cron is explicitly per-connection.
