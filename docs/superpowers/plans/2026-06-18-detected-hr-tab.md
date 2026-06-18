# Detected HR — durable detections log + linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Detected" tab to the coach live-HR page (`/live/[locationId]`) that durably records and lists every HR strap the bridge detects — linked to a member or not — with per-strap appearance history and one-tap linking (pair-for-today or permanent registration).

**Architecture:** Two new tables (`hr_detections` registry + `hr_detection_visits` history) written best-effort from the always-on `/api/bridge/samples` stream (anchor) and enriched from `/api/bridge/scan`. A pure planner (`planDetectionWrites`) computes batched set-based upserts so the bridge's `200` stays fast; a denormalised `current_visit_id` lets the hot path decide extend-vs-new without a per-strap visit lookup. A new `GET …/detections` route feeds the tab; linking reuses the existing `/pair` route and adds a new permanent-register route.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres), Vitest, Tailwind (`un1t-*` tokens), lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-18-detected-hr-tab-design.md`

---

## File structure

**Create:**
- `supabase/migrations/292_hr_detections.sql` — the two tables + RLS + indexes.
- `src/lib/hr-detections.js` — pure planner (`aggregateSamplesByDevice`, `planDetectionWrites`, `DETECTION_VISIT_GAP_MS`) + best-effort IO (`recordDetections`, `recordScanMetadata`, `resolveDetectionLinks`).
- `src/lib/hr-detections.test.js` — unit tests for the pure core + IO.
- `src/app/api/live/[locationId]/detections/route.js` — `GET` list of detections (registry + link status + live-now).
- `src/app/api/live/[locationId]/detection-visits/route.js` — `GET` one detection's visit history.
- `src/app/api/live/[locationId]/register-device/route.js` — `POST` permanent registration / `DELETE` unregister.
- `src/app/live/[locationId]/DetectedTab.jsx` — the new tab UI (list + filters + link modal).

**Modify:**
- `src/app/api/bridge/samples/route.js` — add the best-effort `recordDetections` hook.
- `src/app/api/bridge/scan/route.js` — add the best-effort `recordScanMetadata` hook.
- `src/app/live/[locationId]/LiveClassClient.jsx` — add the "Live board" / "Detected" tab switch.

**No mobile change. No new permission key.** The `/live` page + `GET /api/live` gate on location membership; the new read route follows the same; the write routes follow the `/pair` coach-role gate.

---

### Task 1: Migration — `hr_detections` + `hr_detection_visits`

**Files:**
- Create: `supabase/migrations/292_hr_detections.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 292: HR-DETECT.1 — durable "detected HR" log. Every strap the bridge sees
-- (linked to a member or not) is recorded here, so the coach "Detected" tab can
-- list all HR activity + let staff link an unknown strap to a member.
--   hr_detections        = rolling registry, one row per (location_id, device_key)
--   hr_detection_visits  = appearance history, one row per contiguous visit
-- Recording is best-effort off /api/bridge/samples (anchor) + /api/bridge/scan (enrich).
-- RLS mirrors class_bookings (mig 288): staff-at-location read, service-role write.

CREATE TABLE IF NOT EXISTS public.hr_detections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  device_key        text NOT NULL,
  protocol          text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  visit_count       integer NOT NULL DEFAULT 0,
  last_bpm          smallint,
  last_name         text,
  last_rssi         smallint,
  last_bridge_id    uuid REFERENCES public.ble_bridges(id) ON DELETE SET NULL,
  current_visit_id  uuid,   -- denormalised pointer (no FK) to the open visit
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, device_key)
);

CREATE INDEX IF NOT EXISTS idx_hr_detections_location_last_seen
  ON public.hr_detections (location_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.hr_detection_visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detection_id      uuid NOT NULL REFERENCES public.hr_detections(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  device_key        text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_sample_at    timestamptz NOT NULL DEFAULT now(),
  peak_bpm          smallint,
  last_bpm          smallint,
  sample_count      integer NOT NULL DEFAULT 0,
  glofox_event_id   text,
  class_name        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_detection_visits_detection
  ON public.hr_detection_visits (detection_id, started_at DESC);

ALTER TABLE public.hr_detections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_detection_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hr_detections_location_read" ON public.hr_detections
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

CREATE POLICY "hr_detection_visits_location_read" ON public.hr_detection_visits
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.hr_detections IS
  'HR-DETECT.1 (mig 292): rolling registry of every HR strap the bridge detects at a location, linked or not. Best-effort upsert from /api/bridge/samples + /scan.';
COMMENT ON TABLE public.hr_detection_visits IS
  'HR-DETECT.1 (mig 292): per-visit appearance history for a detected strap. A visit = contiguous detections with gaps < 5min; closed implicitly when last_sample_at goes stale.';
COMMENT ON COLUMN public.hr_detections.current_visit_id IS
  'Denormalised pointer (no FK) to the open hr_detection_visits row, so the recording hot path decides extend-vs-new without a per-strap visit lookup.';
```

- [ ] **Step 2: Verify it parses locally (no apply yet)**

The migration is applied to prod in Task 8 (via Supabase MCP `apply_migration`), gated before the code merge. For now just confirm the file is syntactically sane by eye — there is no local Postgres in this workflow.

- [ ] **Step 3: Commit**

```bash
git add 'supabase/migrations/292_hr_detections.sql'
git commit -m "HR-DETECT.1 — mig 292: hr_detections + hr_detection_visits tables + RLS"
```

---

### Task 2: Pure planning core — `hr-detections.js` (no IO)

**Files:**
- Create: `src/lib/hr-detections.js`
- Test: `src/lib/hr-detections.test.js`

- [ ] **Step 1: Write the failing tests (pure core)**

```js
// src/lib/hr-detections.test.js
import { describe, it, expect } from 'vitest'
import {
  DETECTION_VISIT_GAP_MS,
  aggregateSamplesByDevice,
  planDetectionWrites,
} from './hr-detections'

const NOW_MS = 1781784000000          // fixed clock
const NOW_ISO = new Date(NOW_MS).toISOString()

// Deterministic id generator for tests.
function counterId() {
  let n = 0
  return () => `id-${++n}`
}

describe('aggregateSamplesByDevice', () => {
  it('groups by canonical device_key with peak + latest bpm + count', () => {
    const out = aggregateSamplesByDevice([
      { device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:00Z', bpm: 120 },
      { device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:05Z', bpm: 150 },
      { device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:02Z', bpm: 90 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ deviceKey: 'ant:45075', latestBpm: 150, peakBpm: 150, count: 3 })
    expect(out[0].latestAt).toBe('2026-06-18T10:00:05Z')
  })

  it('drops samples with an unparseable device_key', () => {
    const out = aggregateSamplesByDevice([
      { device_key: 'garbage', bpm: 100 },
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-06-18T10:00:00Z', bpm: 110 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].deviceKey).toBe('ble:AA:BB:CC:DD:EE:FF')
  })

  it('counts a null-bpm sample as a detection without setting bpm', () => {
    const out = aggregateSamplesByDevice([{ device_key: 'ant:1', recorded_at: '2026-06-18T10:00:00Z' }])
    expect(out[0]).toMatchObject({ deviceKey: 'ant:1', latestBpm: null, peakBpm: null, count: 1 })
  })
})

describe('planDetectionWrites — new device (samples)', () => {
  it('inserts a registry row + opens visit #1', () => {
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections: [], existingVisits: [],
      entries: [{ deviceKey: 'ant:45075', latestBpm: 150, peakBpm: 150, count: 4, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO,
      liveClass: { glofox_event_id: 'ev1', class_name: 'RIDE' }, bridgeId: 'br1',
      touchVisits: true, newId: counterId(),
    })
    expect(registryRows).toHaveLength(1)
    expect(registryRows[0]).toMatchObject({
      location_id: 'loc1', device_key: 'ant:45075', protocol: 'ant',
      first_seen_at: NOW_ISO, last_seen_at: NOW_ISO, last_bpm: 150, last_bridge_id: 'br1',
      visit_count: 1,
    })
    expect(registryRows[0].current_visit_id).toBe(visitRows[0].id)
    expect(visitRows).toHaveLength(1)
    expect(visitRows[0]).toMatchObject({
      detection_id: registryRows[0].id, location_id: 'loc1', device_key: 'ant:45075',
      started_at: NOW_ISO, last_sample_at: NOW_ISO, peak_bpm: 150, last_bpm: 150,
      sample_count: 4, glofox_event_id: 'ev1', class_name: 'RIDE',
    })
  })
})

describe('planDetectionWrites — existing device, visit boundary', () => {
  const existingDetections = [{
    id: 'det1', device_key: 'ant:1', first_seen_at: '2026-06-01T00:00:00Z',
    last_seen_at: NOW_ISO, last_bpm: 100, last_name: 'Polar', last_rssi: -50,
    visit_count: 2, current_visit_id: 'v9',
  }]

  it('extends the open visit when within the gap', () => {
    const existingVisits = [{
      id: 'v9', detection_id: 'det1',
      started_at: '2026-06-18T09:00:00Z',
      last_sample_at: new Date(NOW_MS - 60_000).toISOString(),  // 1 min ago
      peak_bpm: 140, last_bpm: 120, sample_count: 30, glofox_event_id: 'ev1', class_name: 'RIDE',
    }]
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections, existingVisits,
      entries: [{ deviceKey: 'ant:1', latestBpm: 160, peakBpm: 160, count: 5, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: true, newId: counterId(),
    })
    expect(registryRows[0].visit_count).toBe(2)                 // unchanged
    expect(registryRows[0].current_visit_id).toBe('v9')
    expect(visitRows[0]).toMatchObject({
      id: 'v9', started_at: '2026-06-18T09:00:00Z',            // preserved
      last_sample_at: NOW_ISO, peak_bpm: 160, last_bpm: 160, sample_count: 35,
      glofox_event_id: 'ev1', class_name: 'RIDE',
    })
  })

  it('opens a new visit when the gap is exceeded', () => {
    const existingVisits = [{
      id: 'v9', detection_id: 'det1',
      started_at: '2026-06-18T08:00:00Z',
      last_sample_at: new Date(NOW_MS - (DETECTION_VISIT_GAP_MS + 60_000)).toISOString(),
      peak_bpm: 140, last_bpm: 120, sample_count: 30,
    }]
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections, existingVisits,
      entries: [{ deviceKey: 'ant:1', latestBpm: 130, peakBpm: 130, count: 2, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: true, newId: counterId(),
    })
    expect(registryRows[0].visit_count).toBe(3)                 // incremented
    expect(visitRows[0].id).toBe('id-1')                        // fresh id
    expect(registryRows[0].current_visit_id).toBe('id-1')
    expect(visitRows[0]).toMatchObject({ started_at: NOW_ISO, last_sample_at: NOW_ISO, sample_count: 2 })
  })

  it('does not clobber last_bpm / first_seen_at with nulls', () => {
    const { registryRows } = planDetectionWrites({
      existingDetections, existingVisits: [{ id: 'v9', last_sample_at: NOW_ISO, started_at: NOW_ISO }],
      entries: [{ deviceKey: 'ant:1', latestBpm: null, peakBpm: null, count: 1, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: true, newId: counterId(),
    })
    expect(registryRows[0].last_bpm).toBe(100)                  // kept
    expect(registryRows[0].first_seen_at).toBe('2026-06-01T00:00:00Z')
  })
})

describe('planDetectionWrites — scan enrich (touchVisits=false)', () => {
  it('updates registry metadata without producing visit rows', () => {
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections: [{ id: 'det1', device_key: 'ble:AA:BB:CC:DD:EE:FF', first_seen_at: '2026-06-01T00:00:00Z', visit_count: 1, current_visit_id: 'v1', last_bpm: 100 }],
      existingVisits: [],
      entries: [{ deviceKey: 'ble:AA:BB:CC:DD:EE:FF', latestBpm: null, peakBpm: null, count: 0, name: 'Polar H10', rssi: -42 }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: false, newId: counterId(),
    })
    expect(visitRows).toHaveLength(0)
    expect(registryRows[0]).toMatchObject({ last_name: 'Polar H10', last_rssi: -42, last_seen_at: NOW_ISO, visit_count: 1 })
    expect(registryRows[0].last_bpm).toBe(100)                  // preserved
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/hr-detections.test.js`
Expected: FAIL — `Cannot find module './hr-detections'` (file not created yet).

- [ ] **Step 3: Write the pure core**

```js
// src/lib/hr-detections.js
//
// HR-DETECT.1 — durable "detected HR" log. Pure planning core + best-effort IO
// (IO functions added in a later task). Recording is anchored on
// /api/bridge/samples (the always-on stream that sees every broadcasting strap,
// paired or not) and enriched from /api/bridge/scan.
//
// Two tables (mig 292):
//   hr_detections        — rolling registry, one row per (location_id, device_key)
//   hr_detection_visits  — appearance history, one row per contiguous visit
//
// A "visit" is a run of detections with gaps < DETECTION_VISIT_GAP_MS. It closes
// implicitly (no cron) once last_sample_at goes stale; the next sample opens a new one.

import { randomUUID } from 'node:crypto'
import { canonicaliseDeviceKey } from './bridge-samples'

export const DETECTION_VISIT_GAP_MS = 5 * 60 * 1000

function protocolForKey(key) {
  return typeof key === 'string' && key.startsWith('ant:') ? 'ant' : 'ble'
}

/**
 * Collapse a raw samples batch into one entry per canonical device_key.
 * @param {Array<{device_key:string, recorded_at?:string, bpm?:number}>} samples
 * @returns {Array<{deviceKey:string, latestBpm:number|null, peakBpm:number|null,
 *   count:number, latestAt:string|null, name:null, rssi:null}>}
 */
export function aggregateSamplesByDevice(samples = []) {
  const byKey = new Map()
  for (const s of samples || []) {
    const key = canonicaliseDeviceKey(s?.device_key)
    if (!key) continue
    const bpm = Number.isFinite(s?.bpm) ? s.bpm : null
    const at = typeof s?.recorded_at === 'string' ? s.recorded_at : null
    const cur = byKey.get(key) || {
      deviceKey: key, latestBpm: null, peakBpm: null, count: 0, latestAt: null, name: null, rssi: null,
    }
    cur.count += 1
    if (bpm != null) {
      cur.peakBpm = cur.peakBpm == null ? bpm : Math.max(cur.peakBpm, bpm)
      if (cur.latestAt == null || (at && at >= cur.latestAt)) { cur.latestBpm = bpm; cur.latestAt = at }
    } else if (at && (cur.latestAt == null || at >= cur.latestAt)) {
      cur.latestAt = at
    }
    byKey.set(key, cur)
  }
  return [...byKey.values()]
}

/**
 * Pure planner: given the existing registry + current visits + this batch's
 * per-device aggregate, produce the rows to upsert. No IO. Deterministic when
 * `newId` is injected.
 *
 * @returns {{ registryRows: object[], visitRows: object[] }}
 */
export function planDetectionWrites({
  existingDetections = [],
  existingVisits = [],
  entries = [],
  locationId,
  nowMs,
  nowIso,
  gapMs = DETECTION_VISIT_GAP_MS,
  liveClass = null,
  bridgeId = null,
  touchVisits = true,
  newId = randomUUID,
} = {}) {
  const detByKey = new Map(existingDetections.map((d) => [d.device_key, d]))
  const visitById = new Map(existingVisits.map((v) => [v.id, v]))
  const registryRows = []
  const visitRows = []

  for (const e of entries) {
    const key = e?.deviceKey
    if (!key) continue
    const existing = detByKey.get(key)
    const detId = existing?.id ?? newId()
    const firstSeenAt = existing?.first_seen_at ?? nowIso
    const mergedBpm = e.latestBpm ?? existing?.last_bpm ?? null
    const mergedName = e.name ?? existing?.last_name ?? null
    const mergedRssi = e.rssi != null ? e.rssi : (existing?.last_rssi ?? null)
    let visitCount = existing?.visit_count ?? 0
    let currentVisitId = existing?.current_visit_id ?? null

    if (touchVisits) {
      const cur = currentVisitId ? visitById.get(currentVisitId) : null
      const lastSampleMs = cur?.last_sample_at ? Date.parse(cur.last_sample_at) : null
      const openNew = !cur || lastSampleMs == null || (nowMs - lastSampleMs > gapMs)
      if (openNew) {
        const vid = newId()
        visitCount += 1
        currentVisitId = vid
        visitRows.push({
          id: vid, detection_id: detId, location_id: locationId, device_key: key,
          started_at: nowIso, last_sample_at: nowIso,
          peak_bpm: e.peakBpm ?? null, last_bpm: e.latestBpm ?? null,
          sample_count: e.count ?? 0,
          glofox_event_id: liveClass?.glofox_event_id ?? null,
          class_name: liveClass?.class_name ?? null,
        })
      } else {
        visitRows.push({
          id: currentVisitId, detection_id: detId, location_id: locationId, device_key: key,
          started_at: cur.started_at,
          last_sample_at: nowIso,
          peak_bpm: Math.max(cur.peak_bpm ?? 0, e.peakBpm ?? 0) || null,
          last_bpm: e.latestBpm ?? cur.last_bpm ?? null,
          sample_count: (cur.sample_count ?? 0) + (e.count ?? 0),
          glofox_event_id: cur.glofox_event_id ?? null,
          class_name: cur.class_name ?? null,
        })
      }
    }

    registryRows.push({
      id: detId, location_id: locationId, device_key: key, protocol: protocolForKey(key),
      first_seen_at: firstSeenAt, last_seen_at: nowIso,
      last_bpm: mergedBpm, last_name: mergedName, last_rssi: mergedRssi,
      last_bridge_id: bridgeId,
      visit_count: visitCount, current_visit_id: currentVisitId,
      updated_at: nowIso,
    })
  }

  return { registryRows, visitRows }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/hr-detections.test.js`
Expected: PASS (all pure-core tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hr-detections.js src/lib/hr-detections.test.js
git commit -m "HR-DETECT.1 — pure detection planner (aggregate + plan writes)"
```

---

### Task 3: Best-effort IO — `recordDetections` / `recordScanMetadata` / `resolveDetectionLinks`

**Files:**
- Modify: `src/lib/hr-detections.js`
- Test: `src/lib/hr-detections.test.js`

- [ ] **Step 1: Append the failing IO tests**

Add to the bottom of `src/lib/hr-detections.test.js`:

```js
import { recordDetections, recordScanMetadata, resolveDetectionLinks } from './hr-detections'
import { vi } from 'vitest'

// Minimal supabase-js builder fake. Every chain method returns the builder; the
// builder is a thenable that resolves `handlers(ctx)`. Records upserts.
function makeDb(handlers) {
  return {
    from(table) {
      const ctx = { table, op: 'select', filters: {} }
      const b = {
        select(cols) { ctx.cols = cols; return b },
        upsert(rows, opts) { ctx.op = 'upsert'; ctx.rows = rows; ctx.opts = opts; return b },
        update(patch) { ctx.op = 'update'; ctx.patch = patch; return b },
        insert(rows) { ctx.op = 'insert'; ctx.rows = rows; return b },
        eq(c, v) { ctx.filters[c] = v; return b },
        is(c, v) { ctx.filters[c] = v; return b },
        in(c, v) { ctx.filters[c] = v; return b },
        not() { return b },
        gte() { return b },
        lte() { return b },
        order() { return b },
        limit() { return b },
        maybeSingle() { ctx.single = true; return b },
        single() { ctx.single = true; return b },
        then(resolve, reject) {
          try { resolve(handlers(ctx) ?? { data: null, error: null }) } catch (e) { reject(e) }
        },
      }
      return b
    },
  }
}

describe('recordDetections (IO)', () => {
  it('reads registry + current visits, then upserts planned rows', async () => {
    const calls = []
    const db = makeDb((ctx) => {
      calls.push({ table: ctx.table, op: ctx.op })
      if (ctx.table === 'hr_detections' && ctx.op === 'select') return { data: [], error: null }
      if (ctx.table === 'hr_detection_visits' && ctx.op === 'select') return { data: [], error: null }
      if (ctx.table === 'class_occurrences') return { data: [], error: null }   // no live class
      if (ctx.op === 'upsert') return { error: null }
      return { data: null, error: null }
    })
    const out = await recordDetections(db, {
      locationId: 'loc1', bridgeId: 'br1',
      samples: [{ device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:00Z', bpm: 150 }],
      nowMs: NOW_MS,
    })
    expect(out).toMatchObject({ ok: true, recorded: 1 })
    expect(calls.some((c) => c.table === 'hr_detections' && c.op === 'upsert')).toBe(true)
    expect(calls.some((c) => c.table === 'hr_detection_visits' && c.op === 'upsert')).toBe(true)
  })

  it('no-ops on an empty batch', async () => {
    const db = makeDb(() => ({ data: [], error: null }))
    expect(await recordDetections(db, { locationId: 'loc1', bridgeId: 'br1', samples: [], nowMs: NOW_MS })).toEqual({ ok: true, recorded: 0 })
  })

  it('degrades gracefully (returns ok:false, does not throw) on a read error', async () => {
    const db = makeDb((ctx) => {
      if (ctx.table === 'hr_detections' && ctx.op === 'select') return { data: null, error: { message: 'boom' } }
      return { data: [], error: null }
    })
    const out = await recordDetections(db, {
      locationId: 'loc1', bridgeId: 'br1',
      samples: [{ device_key: 'ant:1', bpm: 100, recorded_at: '2026-06-18T10:00:00Z' }], nowMs: NOW_MS,
    })
    expect(out).toEqual({ ok: false })
  })
})

describe('recordScanMetadata (IO)', () => {
  it('upserts registry only — never visits', async () => {
    const tables = []
    const db = makeDb((ctx) => {
      if (ctx.op === 'upsert') tables.push(ctx.table)
      if (ctx.table === 'hr_detections' && ctx.op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    })
    const out = await recordScanMetadata(db, {
      locationId: 'loc1', bridgeId: 'br1',
      straps: [{ device_key: 'ble:AA:BB:CC:DD:EE:FF', name: 'Polar', rssi: -50, last_bpm: 120, seen_at: NOW_ISO }],
      nowMs: NOW_MS,
    })
    expect(out).toEqual({ ok: true })
    expect(tables).toEqual(['hr_detections'])
  })
})

describe('resolveDetectionLinks (IO)', () => {
  it('attaches linked_contact + live_now', async () => {
    const db = makeDb((ctx) => {
      if (ctx.table === 'contact_devices') {
        return { data: [{ identifier: 'ant:1', contact_id: 'c1', contacts: { id: 'c1', name: 'Jo B', location_id: 'loc1' } }], error: null }
      }
      if (ctx.table === 'heart_rate_sessions') {
        return { data: [{ device_identifier: 'ant:2' }], error: null }
      }
      return { data: [], error: null }
    })
    const out = await resolveDetectionLinks(db, {
      locationId: 'loc1',
      detections: [{ device_key: 'ant:1' }, { device_key: 'ant:2' }, { device_key: 'ant:3' }],
    })
    expect(out[0]).toMatchObject({ device_key: 'ant:1', linked_contact: { id: 'c1', name: 'Jo B' }, live_now: false })
    expect(out[1]).toMatchObject({ device_key: 'ant:2', linked_contact: null, live_now: true })
    expect(out[2]).toMatchObject({ device_key: 'ant:3', linked_contact: null, live_now: false })
  })

  it('returns [] for no detections', async () => {
    const db = makeDb(() => ({ data: [], error: null }))
    expect(await resolveDetectionLinks(db, { locationId: 'loc1', detections: [] })).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/hr-detections.test.js`
Expected: FAIL — `recordDetections is not a function` (not exported yet).

- [ ] **Step 3: Append the IO functions + their imports**

Add the two imports to the top of `src/lib/hr-detections.js` (under the existing imports):

```js
import { resolveCurrentOccurrence } from './class-occurrences'
import { logWarn } from './log'
```

Append the IO functions at the end of `src/lib/hr-detections.js`:

```js
/**
 * Best-effort: record every device_key in a samples batch into the registry +
 * extend/open its visit. Anchored on /api/bridge/samples. Returns {ok} — never
 * throws (the caller still acks the bridge). Batched: 2 reads + ≤2 upserts,
 * independent of strap count.
 */
export async function recordDetections(db, { locationId, bridgeId, samples, nowMs = Date.now() } = {}) {
  const entries = aggregateSamplesByDevice(samples)
  if (entries.length === 0) return { ok: true, recorded: 0 }
  const keys = entries.map((e) => e.deviceKey)
  const nowIso = new Date(nowMs).toISOString()

  const { data: existingDetections, error: readErr } = await db
    .from('hr_detections')
    .select('id, device_key, first_seen_at, last_seen_at, last_bpm, last_name, last_rssi, visit_count, current_visit_id')
    .eq('location_id', locationId)
    .in('device_key', keys)
  if (readErr) { logWarn('hr-detections', 'registry read failed', { err: readErr, locationId }); return { ok: false } }

  const currentVisitIds = (existingDetections || []).map((d) => d.current_visit_id).filter(Boolean)
  let existingVisits = []
  if (currentVisitIds.length > 0) {
    const { data } = await db
      .from('hr_detection_visits')
      .select('id, detection_id, started_at, last_sample_at, peak_bpm, last_bpm, sample_count, glofox_event_id, class_name')
      .in('id', currentVisitIds)
    existingVisits = data || []
  }

  const liveClass = await resolveCurrentOccurrence(db, { locationId, nowMs })

  const { registryRows, visitRows } = planDetectionWrites({
    existingDetections: existingDetections || [],
    existingVisits, entries, locationId, nowMs, nowIso,
    liveClass, bridgeId, touchVisits: true,
  })

  const { error: rErr } = await db
    .from('hr_detections')
    .upsert(registryRows, { onConflict: 'location_id,device_key' })
  if (rErr) { logWarn('hr-detections', 'registry upsert failed', { err: rErr }); return { ok: false } }

  if (visitRows.length > 0) {
    const { error: vErr } = await db.from('hr_detection_visits').upsert(visitRows)
    if (vErr) { logWarn('hr-detections', 'visit upsert failed', { err: vErr }); return { ok: false } }
  }

  return { ok: true, recorded: registryRows.length }
}

/**
 * Best-effort: enrich registry rows with name/rssi from a /scan snapshot. Updates
 * last_seen/last_name/last_rssi/last_bridge_id; never touches visits.
 */
export async function recordScanMetadata(db, { locationId, bridgeId, straps, nowMs = Date.now() } = {}) {
  const entries = (straps || [])
    .map((s) => ({
      deviceKey: canonicaliseDeviceKey(s?.device_key),
      latestBpm: Number.isFinite(s?.last_bpm) ? s.last_bpm : null,
      peakBpm: null, count: 0,
      latestAt: typeof s?.seen_at === 'string' ? s.seen_at : null,
      name: typeof s?.name === 'string' ? s.name : null,
      rssi: Number.isFinite(s?.rssi) ? s.rssi : null,
    }))
    .filter((e) => e.deviceKey)
  if (entries.length === 0) return { ok: true }
  const keys = entries.map((e) => e.deviceKey)
  const nowIso = new Date(nowMs).toISOString()

  const { data: existingDetections, error: readErr } = await db
    .from('hr_detections')
    .select('id, device_key, first_seen_at, last_seen_at, last_bpm, last_name, last_rssi, visit_count, current_visit_id')
    .eq('location_id', locationId)
    .in('device_key', keys)
  if (readErr) { logWarn('hr-detections', 'scan registry read failed', { err: readErr }); return { ok: false } }

  const { registryRows } = planDetectionWrites({
    existingDetections: existingDetections || [],
    existingVisits: [], entries, locationId, nowMs, nowIso,
    liveClass: null, bridgeId, touchVisits: false,
  })

  const { error } = await db
    .from('hr_detections')
    .upsert(registryRows, { onConflict: 'location_id,device_key' })
  if (error) { logWarn('hr-detections', 'scan metadata upsert failed', { err: error }); return { ok: false } }
  return { ok: true }
}

/**
 * Enrich registry rows with link status (device_key → active contact_devices →
 * contact) + a live-now flag (open heart_rate_session for the key). Two scoped
 * reads; merge in memory. Returns the rows with `linked_contact` + `live_now`.
 */
export async function resolveDetectionLinks(db, { locationId, detections = [] } = {}) {
  if (detections.length === 0) return []
  const keys = detections.map((d) => d.device_key)

  const { data: devices } = await db
    .from('contact_devices')
    .select('identifier, contact_id, contacts!inner(id, name, location_id)')
    .in('identifier', keys)
    .eq('is_active', true)
    .eq('contacts.location_id', locationId)
  const linkByKey = new Map()
  for (const d of devices || []) {
    if (d.contacts) linkByKey.set(d.identifier, { id: d.contact_id, name: d.contacts.name })
  }

  const { data: openSessions } = await db
    .from('heart_rate_sessions')
    .select('device_identifier')
    .eq('location_id', locationId)
    .is('ended_at', null)
    .in('device_identifier', keys)
  const liveKeys = new Set((openSessions || []).map((s) => s.device_identifier))

  return detections.map((d) => ({
    ...d,
    linked_contact: linkByKey.get(d.device_key) || null,
    live_now: liveKeys.has(d.device_key),
  }))
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/hr-detections.test.js`
Expected: PASS (pure-core + IO tests all green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hr-detections.js src/lib/hr-detections.test.js
git commit -m "HR-DETECT.1 — recordDetections/recordScanMetadata/resolveDetectionLinks IO"
```

---

### Task 4: Wire recording into the bridge routes (best-effort)

**Files:**
- Modify: `src/app/api/bridge/samples/route.js`
- Modify: `src/app/api/bridge/scan/route.js`

- [ ] **Step 1: Add the samples-route hook**

In `src/app/api/bridge/samples/route.js`, immediately AFTER the heartbeat update block (the `await db.from('ble_bridges').update({ last_seen_at... }).eq('id', bridge.bridgeId)`) and BEFORE the final `return NextResponse.json({ ok: true, ... })`, insert:

```js
  // HR-DETECT.1 — best-effort durable detection log. Records EVERY device_key in
  // the batch (matched OR dropped_unpaired), so the coach "Detected" tab sees all
  // HR activity. Wrapped so it can never slow or fail the bridge ack.
  try {
    const { recordDetections } = await import('@/lib/hr-detections')
    await recordDetections(db, { locationId: bridge.locationId, bridgeId: bridge.bridgeId, samples })
  } catch (e) {
    logWarn('bridge-samples', 'detection recording threw', { err: e?.message || e })
  }
```

(`logWarn` is already imported in this route.)

- [ ] **Step 2: Add the scan-route hook**

In `src/app/api/bridge/scan/route.js`, immediately AFTER the `if (error) { ... return ... }` block (the success path, where `cleaned` is in scope) and BEFORE the final `return NextResponse.json({ ok: true, accepted: cleaned.length })`, insert:

```js
  // HR-DETECT.1 — best-effort: enrich the detection registry with strap name/RSSI
  // from this snapshot. Never blocks the scan ack.
  try {
    const { recordScanMetadata } = await import('@/lib/hr-detections')
    await recordScanMetadata(db, { locationId: bridge.locationId, bridgeId: bridge.bridgeId, straps: cleaned })
  } catch (e) {
    logWarn('bridge-scan', 'detection enrich threw', { err: e?.message || e })
  }
```

(`logWarn` is already imported in this route.)

- [ ] **Step 3: Verify existing bridge route tests still pass**

Run: `npx vitest run src/app/api/bridge`
Expected: PASS — the hooks are best-effort and don't change the response shape, so any existing samples/scan route tests stay green. (If no such tests exist, this is a no-op; the build in Task 8 covers import resolution.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/bridge/samples/route.js src/app/api/bridge/scan/route.js
git commit -m "HR-DETECT.1 — record detections from bridge samples + scan (best-effort)"
```

---

### Task 5: `GET …/detections` + `GET …/detection-visits` routes

**Files:**
- Create: `src/app/api/live/[locationId]/detections/route.js`
- Create: `src/app/api/live/[locationId]/detection-visits/route.js`
- Test: `src/app/api/live/[locationId]/detections/route.test.js`

- [ ] **Step 1: Write the failing route test**

```js
// src/app/api/live/[locationId]/detections/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc1']),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/hr-detections', () => ({
  resolveDetectionLinks: vi.fn(async (_db, { detections }) => detections.map((d) => ({ ...d, linked_contact: null, live_now: false }))),
}))

import { GET } from './route'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function makeReq() { return new Request('http://localhost/api/live/loc1/detections') }
const props = { params: Promise.resolve({ locationId: 'loc1' }) }

beforeEach(() => { vi.clearAllMocks(); getUserLocationIds.mockReturnValue(['loc1']) })

describe('GET /api/live/[locationId]/detections', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(401)
  })

  it('403 when the location is not in scope', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'coach', isMaster: false })
    getUserLocationIds.mockReturnValue(['other'])
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(403)
  })

  it('200 returns enriched detections', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'coach', isMaster: false })
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [{ id: 'd1', device_key: 'ant:1' }], error: null }) }) }) }),
      }),
    })
    const res = await GET(makeReq(), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.detections[0]).toMatchObject({ device_key: 'ant:1', linked_contact: null, live_now: false })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/live/[locationId]/detections/route.test.js`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write the detections route**

```js
// src/app/api/live/[locationId]/detections/route.js
//
// GET /api/live/[locationId]/detections
//
// HR-DETECT.1 — the coach "Detected" tab data: every strap recorded at this
// location (linked or not), most-recently-seen first, enriched with link status
// (contact_devices) + a live-now flag (open heart_rate_session). Separate from
// the 2s /api/live poll so the hot live board stays lean; this polls slower.
//
// Auth: any staff at the location (mirrors GET /api/live/[locationId]).

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { resolveDetectionLinks } from '@/lib/hr-detections'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ROWS = 500

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  const locationId = params.locationId
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: rows, error } = await db
    .from('hr_detections')
    .select('id, device_key, protocol, first_seen_at, last_seen_at, visit_count, last_bpm, last_name, last_rssi, last_bridge_id')
    .eq('location_id', locationId)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  const detections = await resolveDetectionLinks(db, { locationId, detections: rows || [] })
  return NextResponse.json({ ok: true, detections, capped: (rows || []).length >= MAX_ROWS })
}
```

- [ ] **Step 4: Write the detection-visits route**

```js
// src/app/api/live/[locationId]/detection-visits/route.js
//
// GET /api/live/[locationId]/detection-visits?detection_id=<id>
//
// HR-DETECT.1 — lazy drill-down: the appearance history for one detected strap.
// Scoped by location_id (app guard) AND detection_id. Auth mirrors the live route.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  const locationId = params.locationId
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }
  const detectionId = new URL(request.url).searchParams.get('detection_id')
  if (!detectionId) return NextResponse.json({ ok: false, error: 'detection_id required' }, { status: 400 })

  const db = createServerClient()
  const { data, error } = await db
    .from('hr_detection_visits')
    .select('id, started_at, last_sample_at, peak_bpm, last_bpm, sample_count, glofox_event_id, class_name')
    .eq('location_id', locationId)
    .eq('detection_id', detectionId)
    .order('started_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, visits: data || [] })
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/app/api/live/[locationId]/detections/route.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
noglob git add 'src/app/api/live/[locationId]/detections/route.js' 'src/app/api/live/[locationId]/detection-visits/route.js' 'src/app/api/live/[locationId]/detections/route.test.js'
git commit -m "HR-DETECT.1 — GET detections + detection-visits routes"
```

---

### Task 6: `register-device` route (permanent registration + unregister)

**Files:**
- Create: `src/app/api/live/[locationId]/register-device/route.js`
- Test: `src/app/api/live/[locationId]/register-device/route.test.js`

- [ ] **Step 1: Write the failing route test**

```js
// src/app/api/live/[locationId]/register-device/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc1']),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const props = { params: Promise.resolve({ locationId: 'loc1' }) }
function reqWith(body) {
  return new Request('http://localhost/api/live/loc1/register-device', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
beforeEach(() => { vi.clearAllMocks(); getUserLocationIds.mockReturnValue(['loc1']) })

describe('POST /api/live/[locationId]/register-device', () => {
  it('403 for a non-coach role', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', isMaster: false })
    const res = await POST(reqWith({ device_key: 'ant:1', contact_id: '00000000-0000-0000-0000-000000000001' }), props)
    expect(res.status).toBe(403)
  })

  it('404 when the contact is not at this location (IDOR guard)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'coach', isMaster: false })
    createServerClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'c1', location_id: 'other' }, error: null }) }) }) }),
    })
    const res = await POST(reqWith({ device_key: 'ant:1', contact_id: '00000000-0000-0000-0000-000000000001' }), props)
    expect(res.status).toBe(404)
  })

  it('200 upserts a contact_devices row', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'coach', isMaster: false })
    let upserted = null
    createServerClient.mockReturnValue({
      from: (table) => {
        if (table === 'contacts') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'c1', location_id: 'loc1' }, error: null }) }) }) }
        }
        return {
          upsert: (row, opts) => { upserted = { row, opts }; return { select: () => ({ single: () => Promise.resolve({ data: { id: 'dev1' }, error: null }) }) } },
        }
      },
    })
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: '00000000-0000-0000-0000-000000000001', device_type: 'watch', label: 'Garmin' }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, device_id: 'dev1' })
    expect(upserted.row).toMatchObject({ contact_id: '00000000-0000-0000-0000-000000000001', identifier: 'ant:45075', device_type: 'watch', label: 'Garmin', is_active: true, added_by_contact: false, added_by_user_id: 'u1' })
    expect(upserted.opts).toEqual({ onConflict: 'contact_id,device_type,identifier' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/live/[locationId]/register-device/route.test.js`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write the route**

```js
// src/app/api/live/[locationId]/register-device/route.js
//
// POST   /api/live/[locationId]/register-device  → permanent contact_devices registration
// DELETE /api/live/[locationId]/register-device  → deactivate (unregister)
//
// HR-DETECT.1 — "Remember this device" from the coach Detected tab. Registering a
// strap to a member means it auto-routes to their session every future class
// (contact_devices is the auto path in resolveStrapsForBatch). Coach-role gated,
// same as /pair. (Per-class "pair for today" reuses the existing /pair route.)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canonicaliseDeviceKey } from '@/lib/bridge-samples'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['owner', 'manager', 'head_coach', 'coach']

function guard(user, locationId) {
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (!user.isMaster && !ALLOWED_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Coach only' }, { status: 403 })
  }
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }
  return null
}

const RegisterSchema = z.object({
  device_key: z.string().min(1),
  contact_id: uuidLike,
  device_type: z.enum(['chest_strap', 'watch']).optional(),
  label: z.string().max(80).optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, params.locationId)
  if (denied) return denied

  const validation = await validateBody(request, RegisterSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const deviceKey = canonicaliseDeviceKey(body.device_key)
  if (!deviceKey) return NextResponse.json({ ok: false, error: 'Invalid device_key' }, { status: 400 })

  const db = createServerClient()
  // IDOR guard: the contact must belong to this location.
  const { data: contact } = await db.from('contacts').select('id, location_id').eq('id', body.contact_id).maybeSingle()
  if (!contact || contact.location_id !== params.locationId) {
    return NextResponse.json({ ok: false, error: 'Contact not at this location' }, { status: 404 })
  }

  const deviceType = body.device_type || 'chest_strap'
  const { data, error } = await db
    .from('contact_devices')
    .upsert({
      contact_id: body.contact_id,
      device_type: deviceType,
      identifier: deviceKey,
      label: body.label || null,
      is_active: true,
      added_by_contact: false,
      added_by_user_id: user.id,
    }, { onConflict: 'contact_id,device_type,identifier' })
    .select('id')
    .single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 })

  logInfo('hr-detect', 'register device', { locationId: params.locationId, contactId: body.contact_id, deviceKey, deviceType, actor: user.id })
  return NextResponse.json({ ok: true, device_id: data.id })
}

const UnregisterSchema = z.object({
  device_key: z.string().min(1),
  contact_id: uuidLike,
})

export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, params.locationId)
  if (denied) return denied

  const validation = await validateBody(request, UnregisterSchema)
  if (!validation.ok) return validation.response
  const deviceKey = canonicaliseDeviceKey(validation.data.device_key)
  if (!deviceKey) return NextResponse.json({ ok: false, error: 'Invalid device_key' }, { status: 400 })

  const db = createServerClient()
  const { error } = await db
    .from('contact_devices')
    .update({ is_active: false })
    .eq('contact_id', validation.data.contact_id)
    .eq('identifier', deviceKey)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/app/api/live/[locationId]/register-device/route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
noglob git add 'src/app/api/live/[locationId]/register-device/route.js' 'src/app/api/live/[locationId]/register-device/route.test.js'
git commit -m "HR-DETECT.1 — register-device route (permanent contact_devices link + unregister)"
```

---

### Task 7: The "Detected" tab UI

**Files:**
- Create: `src/app/live/[locationId]/DetectedTab.jsx`
- Modify: `src/app/live/[locationId]/LiveClassClient.jsx`

- [ ] **Step 1: Write `DetectedTab.jsx`**

```jsx
// src/app/live/[locationId]/DetectedTab.jsx
'use client'

// HR-DETECT.1 — durable "Detected" tab: every strap the bridge has recorded at
// this location (linked or not), with appearance history + linking. Polls
// /api/live/[id]/detections slower than the 2s live board.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plug, ChevronDown, ChevronRight, Link2, Check } from 'lucide-react'

const POLL_MS = 12000

export default function DetectedTab({ locationId, contacts }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')   // all | unlinked | live
  const [query, setQuery] = useState('')
  const [linking, setLinking] = useState(null)   // detection row being linked

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/live/${locationId}/detections`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load detections')
      setRows(json.detections || [])
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'unlinked' && r.linked_contact) return false
      if (filter === 'live' && !r.live_now) return false
      if (q) {
        const hay = `${r.last_name || ''} ${r.device_key} ${r.linked_contact?.name || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, filter, query])

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <Plug size={16} className="text-un1t-subtle" />
        <h2 className="text-sm font-semibold">Detected heart-rate devices</h2>
        <span className="ml-auto text-xs text-un1t-subtle">{filtered.length} shown</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {[['all', 'All'], ['unlinked', 'Unlinked'], ['live', 'Live now']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${filter === key ? 'bg-un1t-accent text-white' : 'border border-un1t-border bg-white text-un1t-subtle hover:bg-un1t-surface'}`}
          >
            {label}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search name or key…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-auto w-44 rounded-md border border-un1t-border bg-white px-3 py-1 text-sm"
        />
      </div>

      {error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      {loading && rows.length === 0 ? (
        <p className="mt-8 text-center text-sm text-un1t-subtle">Loading detections…</p>
      ) : filtered.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-un1t-border bg-white p-10 text-center">
          <p className="font-medium">No detections{filter !== 'all' ? ' match this filter' : ' yet'}</p>
          <p className="mt-1 text-sm text-un1t-subtle">Straps appear here once the bridge sees them broadcasting during a class.</p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-un1t-border rounded-2xl border border-un1t-border bg-white">
          {filtered.map((r) => (
            <DetectionRow key={r.id} row={r} locationId={locationId} onLink={() => setLinking(r)} />
          ))}
        </ul>
      )}

      {linking && (
        <LinkModal
          row={linking}
          locationId={locationId}
          contacts={contacts}
          onClose={() => setLinking(null)}
          onDone={() => { setLinking(null); load() }}
        />
      )}
    </section>
  )
}

function DetectionRow({ row, locationId, onLink }) {
  const [open, setOpen] = useState(false)
  const [visits, setVisits] = useState(null)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && visits == null) {
      try {
        const res = await fetch(`/api/live/${locationId}/detection-visits?detection_id=${row.id}`, { cache: 'no-store' })
        const json = await res.json()
        setVisits(json.ok ? (json.visits || []) : [])
      } catch { setVisits([]) }
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggle} className="text-un1t-subtle hover:text-un1t-text" title="Show visit history">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.last_name || 'Heart-rate strap'}</span>
            <span className="shrink-0 rounded-full bg-un1t-border px-1.5 py-0.5 text-[10px] font-semibold uppercase text-un1t-subtle">
              {row.protocol === 'ant' ? 'ANT+' : 'BLE'}
            </span>
            {row.live_now && <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">live</span>}
          </div>
          <p className="truncate font-mono text-xs text-un1t-subtle">{row.device_key}</p>
        </div>
        <div className="text-right">
          {row.linked_contact ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><Check size={12} /> {row.linked_contact.name}</span>
          ) : (
            <button type="button" onClick={onLink} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500">
              <Link2 size={12} /> Link
            </button>
          )}
          <p className="mt-0.5 text-[11px] text-un1t-subtle">
            {row.visit_count} visit{row.visit_count === 1 ? '' : 's'} · {row.last_bpm != null ? `${row.last_bpm} bpm · ` : ''}{formatSince(row.last_seen_at)}
          </p>
        </div>
      </div>

      {open && (
        <div className="mt-2 pl-7">
          {visits == null ? (
            <p className="text-xs text-un1t-subtle">Loading…</p>
          ) : visits.length === 0 ? (
            <p className="text-xs text-un1t-subtle">No recorded visits.</p>
          ) : (
            <ul className="space-y-1">
              {visits.map((v) => (
                <li key={v.id} className="text-xs text-un1t-subtle">
                  {formatDateTime(v.started_at)}{v.class_name ? ` · ${v.class_name}` : ''}
                  {v.peak_bpm != null ? ` · peak ${v.peak_bpm} bpm` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

function LinkModal({ row, locationId, contacts, onClose, onDone }) {
  const [query, setQuery] = useState('')
  const [contactId, setContactId] = useState(null)
  const [deviceType, setDeviceType] = useState('chest_strap')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts.slice(0, 50)
    return contacts.filter((c) => c.name?.toLowerCase().includes(q)).slice(0, 50)
  }, [contacts, query])

  async function pairForToday() {
    if (!contactId) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/live/${locationId}/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: row.device_key, contact_id: contactId, bridge_id: row.last_bridge_id }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Pair failed')
      onDone()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  async function rememberDevice() {
    if (!contactId) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/live/${locationId}/register-device`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: row.device_key, contact_id: contactId, device_type: deviceType }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Register failed')
      onDone()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">Link strap to member</h2>
        <p className="mt-1 font-mono text-sm text-un1t-subtle">{row.device_key}</p>

        <input
          type="search"
          autoFocus
          placeholder="Search members…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mt-3 w-full rounded-md border border-un1t-border bg-white px-3 py-2 text-sm"
        />
        <ul className="mt-2 max-h-48 overflow-auto rounded-md border border-un1t-border">
          {filtered.length === 0 ? (
            <li className="p-3 text-center text-xs text-un1t-subtle">No matches</li>
          ) : (
            filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setContactId(c.id)}
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-un1t-surface ${contactId === c.id ? 'bg-indigo-50 font-medium' : ''}`}
                >
                  {c.name}
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-un1t-subtle">Device type:</span>
          {[['chest_strap', 'Chest strap'], ['watch', 'Watch']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDeviceType(key)}
              className={`rounded-full px-2 py-0.5 ${deviceType === key ? 'bg-un1t-accent text-white' : 'border border-un1t-border text-un1t-subtle'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm font-medium text-un1t-subtle hover:text-un1t-text">Cancel</button>
          <button
            type="button"
            disabled={!contactId || busy}
            onClick={pairForToday}
            className="rounded-md border border-indigo-600 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
          >
            Pair for today
          </button>
          <button
            type="button"
            disabled={!contactId || busy}
            onClick={rememberDevice}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Remember this device
          </button>
        </div>
        <p className="mt-2 text-[11px] text-un1t-subtle">
          “Pair for today” shows them on the board for this class only. “Remember this device” saves it to their profile so it auto-routes every future class.
        </p>
      </div>
    </div>
  )
}

function formatSince(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function formatDateTime(iso) {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' }).format(new Date(iso))
  } catch { return iso }
}
```

- [ ] **Step 2: Wire the tab switch into `LiveClassClient.jsx`**

In `src/app/live/[locationId]/LiveClassClient.jsx`:

(a) Add the import near the top (after the existing imports):

```jsx
import DetectedTab from './DetectedTab'
```

(b) Add tab state inside `LiveClassClient`, next to the other `useState` calls (e.g. after `const [pairing, setPairing] = useState(null)`):

```jsx
  const [tab, setTab] = useState('live')   // 'live' | 'detected'
```

(c) In the render, immediately AFTER the `{error && (...)}` block and BEFORE the `{loading && data.sessions.length === 0 ? (...) : (...)}` block, insert the tab bar:

```jsx
      <div className="mt-4 flex items-center gap-2 border-b border-un1t-border">
        {[['live', 'Live board'], ['detected', 'Detected']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? 'border-un1t-accent text-un1t-text' : 'border-transparent text-un1t-subtle hover:text-un1t-text'}`}
          >
            {label}
          </button>
        ))}
      </div>
```

(d) Wrap the existing live-board body so it only renders on the `live` tab, and render `DetectedTab` on the `detected` tab. Replace the existing block:

```jsx
      {loading && data.sessions.length === 0 ? (
        <p className="mt-10 text-center text-sm text-un1t-subtle">Loading live class…</p>
      ) : (
        <>
          <SessionGrid
            sessions={data.sessions}
            onEndOne={endOne}
          />

          <ClassRosterPanel roster={data.roster} occurrence={data.occurrence} />

          <AvailableStrapsPanel
            straps={data.available_straps}
            onStartPair={(strap) => setPairing(strap)}
          />

          {pairing && (
            <PairModal
              strap={pairing}
              contacts={contacts}
              onCancel={() => setPairing(null)}
              onConfirm={(contactId) => pair({ strap: pairing, contactId })}
            />
          )}
        </>
      )}
```

with:

```jsx
      {tab === 'detected' ? (
        <DetectedTab locationId={locationId} contacts={contacts} />
      ) : loading && data.sessions.length === 0 ? (
        <p className="mt-10 text-center text-sm text-un1t-subtle">Loading live class…</p>
      ) : (
        <>
          <SessionGrid
            sessions={data.sessions}
            onEndOne={endOne}
          />

          <ClassRosterPanel roster={data.roster} occurrence={data.occurrence} />

          <AvailableStrapsPanel
            straps={data.available_straps}
            onStartPair={(strap) => setPairing(strap)}
          />

          {pairing && (
            <PairModal
              strap={pairing}
              contacts={contacts}
              onCancel={() => setPairing(null)}
              onConfirm={(contactId) => pair({ strap: pairing, contactId })}
            />
          )}
        </>
      )}
```

- [ ] **Step 3: Run the production build (catches import-resolution + JSX errors)**

Run: `npm run build`
Expected: build completes with no errors referencing `DetectedTab`, `hr-detections`, or the new routes. (This is the gate that vitest+eslint do NOT cover — per CLAUDE.md, a new import/route only fails here.)

- [ ] **Step 4: Commit**

```bash
noglob git add 'src/app/live/[locationId]/DetectedTab.jsx' 'src/app/live/[locationId]/LiveClassClient.jsx'
git commit -m "HR-DETECT.1 — Detected tab UI (list + filters + history + link modal)"
```

---

### Task 8: Ship — apply migration, full CI mirror, PR, merge

**Files:** none (release task).

- [ ] **Step 1: Apply the migration to prod (gate 1 — before merge)**

Apply `supabase/migrations/292_hr_detections.sql` via the Supabase MCP `apply_migration` tool (project `iyvtbjjxdggiadzwwvdj`). The tables are additive and unreferenced by currently-deployed code, so applying first is safe and prevents the post-merge deploy from reading/writing missing tables.

- [ ] **Step 2: Run the security advisor**

Use the `get_advisors` MCP tool (type=security). Expected: no new ERROR-level findings for `hr_detections` / `hr_detection_visits` (RLS is enabled with a SELECT policy; writes are service-role only). Fix any flagged issue before merging.

- [ ] **Step 3: Run the full CI mirror + build locally**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build
```
Expected: all green. (`check:route-guards` must pass — the new GET/POST/DELETE routes all use `getCurrentUser`; the bridge hooks don't add routes.)

- [ ] **Step 4: Push the branch + open the PR (base=main)**

```bash
git push -u origin hr-detect-detected-tab
gh pr create --base main --head hr-detect-detected-tab \
  --title "HR-DETECT.1 — Detected HR tab (durable detections log + linking)" \
  --body "$(cat <<'EOF'
Adds a "Detected" tab to /live/[locationId] that durably records and lists every HR strap the bridge detects — linked or not — with appearance history and one-tap linking.

**What's new**
- mig 292: `hr_detections` (registry) + `hr_detection_visits` (history), staff-read / service-write RLS.
- `src/lib/hr-detections.js`: pure planner + best-effort `recordDetections` (samples anchor) / `recordScanMetadata` (scan enrich) / `resolveDetectionLinks`.
- Recording hooks in `/api/bridge/samples` + `/api/bridge/scan` (best-effort, never block the ack).
- `GET /api/live/[id]/detections` + `GET /api/live/[id]/detection-visits`.
- `POST/DELETE /api/live/[id]/register-device` (permanent contact_devices link).
- "Detected" tab in LiveClassClient (filters, history drill-down, Pair-for-today + Remember-this-device).

**Scope:** web-only; no new permission key (reuses the live page's membership gate + /pair coach-role gate). No champ-bridge/champ-app change.

Spec: docs/superpowers/specs/2026-06-18-detected-hr-tab-design.md
Plan: docs/superpowers/plans/2026-06-18-detected-hr-tab.md

Verified: vitest + lint + mobile-parity + mobile-imports + route-guards + next build all green. Migration applied to prod + security advisor clean before merge.
EOF
)"
```

- [ ] **Step 5: Confirm CI green, then merge**

Wait for the PR's "Test & lint" + Vercel checks to pass, then merge:

```bash
gh pr checks --watch
gh pr merge --squash
```

Confirm the squash landed on `origin/main` (`git log origin/main --oneline | head`). Vercel auto-deploys `main` to `crm.un1tdublin.com`; the tables already exist from Step 1.

---

## Self-review notes

- **Spec coverage:** registry table (Task 1) ✓, visits/appearance history (Task 1 + planner Task 2) ✓, recording from samples anchor + scan enrich (Tasks 3–4) ✓, list route with link status + live-now (Task 5) ✓, visit drill-down (Task 5) ✓, both link actions — pair-for-today reuses `/pair`, remember-device = register-device (Tasks 6–7) ✓, the Detected tab (Task 7) ✓, membership/coach-role gates + no new permission (Tasks 5–6) ✓, best-effort non-blocking recording (Tasks 3–4) ✓, no migration-less nulls — `vs_category`/etc. are not part of this feature.
- **Type consistency:** `planDetectionWrites` row shapes match the mig 292 columns; `recordDetections`/`recordScanMetadata` both call the same planner with `touchVisits` true/false; `resolveDetectionLinks` output (`linked_contact`, `live_now`) matches what `DetectedTab` reads; `register-device` upsert columns match `contact_devices` (mig 112: `device_type`/`identifier`/`label`/`is_active`/`added_by_contact`/`added_by_user_id`).
- **Gotchas honoured:** `noglob`/quoted bracket paths in every `git add`; `next build` is its own step (vitest+eslint don't catch import resolution); `current_visit_id` has no FK (avoids insert-ordering pain); visit gap keyed on the visit's `last_sample_at` (HR recency) not the registry `last_seen_at` (which scan also bumps); `contact_devices` embed disambiguated implicitly (single FK to contacts, `contacts!inner` is unambiguous).
