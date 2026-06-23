# Strava Direct Inbound — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member's own Strava activities import into `strava_activities` (and show on their own Progress) via a **direct** Strava integration — push webhook + backfill — reusing the existing direct-Strava export OAuth, with OpenWearables dropped for Strava.

**Architecture:** champ-app already does direct Strava OAuth (the `activity:write` export) storing tokens in `contact_external_integrations`. We add `activity:read_all` to that one grant (unified connection), then in un1t-crm add: activity-fetch helpers on the Strava client, a pure mapper, a `/api/webhooks/strava` receiver (Strava push subscription), and a backfill cron. The OW Strava path (IB5 branch + the `/api/wearables/strava/connect` from #35) is retired.

**Tech Stack:** Next.js 16 + Supabase, Strava REST API v3 + push webhooks, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-23-strava-direct-inbound-design.md`

**Branches:** un1t-crm work on `strava-direct-inbound` (already cut, off main, spec committed). champ-app work on a sibling `strava-direct-inbound` (cut off its `main` AFTER `git fetch origin main`).

**Pre-push CI mirror:** un1t-crm `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards` + `npm run build`. champ-app `npm test && npm run lint && npm run build`.

---

## File structure

**un1t-crm (create):**
- `supabase/migrations/311_strava_import_backfill.sql` — `import_backfilled_at` column + `strava-import` cron heartbeat row.
- `src/lib/strava-direct-map.js` (+ `.test.js`) — pure raw-Strava-activity → `strava_activities` row.
- `src/lib/strava-import.js` (+ `.test.js`) — `loadStravaConfig`, `ensureFreshToken`, `ingestActivity`, `backfillConnection` (the IO that the webhook + cron share).
- `src/app/api/webhooks/strava/route.js` (+ `.test.js`) — GET handshake + POST events.
- `src/app/api/cron/strava-import/route.js` — backfill cron.

**un1t-crm (modify):**
- `src/lib/strava.js` — add `getActivity`, `listActivities`.
- `src/app/api/webhooks/openwearables/route.js` (+ `.test.js`) — IB5 `strava` branch → explicit ignore.
- `vercel.json` — add the cron schedule.
- `scripts/check-route-guards.mjs` — EXEMPT entry for `/api/webhooks/strava` (Strava doesn't sign; the GET handshake verifies via verify_token).

**champ-app (modify):**
- `src/lib/strava-oauth.js` — default scopes include `activity:read_all`.
- `src/app/account/integrations/IntegrationsManager.jsx` — Strava blurb mentions import+export.
- delete `src/app/account/integrations/StravaImportCard.jsx`, `src/app/api/wearables/strava/connect/route.js` (+ test), `mobile/app/account/connect-strava.jsx`; un-wire them from `integrations/page.jsx` + `mobile/app/account/integrations.jsx`.

---

## Task 1: Migration 311 — backfill column + heartbeat

**Files:** Create `un1t-crm/supabase/migrations/311_strava_import_backfill.sql`

- [ ] **Step 1: Write the SQL**
```sql
-- 311: Strava direct inbound — backfill tracking + cron heartbeat.
-- import_backfilled_at stamps when the strava-import cron has done the one-time
-- last-30-days backfill for a connection, so it isn't re-pulled every tick.
ALTER TABLE contact_external_integrations
  ADD COLUMN IF NOT EXISTS import_backfilled_at timestamptz;

INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds)
VALUES ('strava-import', 300, 600)
ON CONFLICT (name) DO NOTHING;
```
- [ ] **Step 2:** Apply via Supabase MCP (`apply_migration`, name `311_strava_import_backfill`).
- [ ] **Step 3:** `get_advisors` type=security — confirm no new ERROR.
- [ ] **Step 4:** Commit `git add supabase/migrations/311_strava_import_backfill.sql && git commit -m "mig 311 — strava import backfill column + cron heartbeat"`

---

## Task 2: Strava client — `getActivity` + `listActivities`

**Files:** Modify `un1t-crm/src/lib/strava.js`; Test: `un1t-crm/src/lib/strava.test.js` (create if absent)

- [ ] **Step 1: Write the failing test** (`src/lib/strava.test.js`)
```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getActivity, listActivities } from './strava.js'

afterEach(() => vi.restoreAllMocks())

describe('strava client reads', () => {
  it('getActivity fetches the detailed activity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 123, name: 'Run' }) })
    vi.stubGlobal('fetch', fetchMock)
    const a = await getActivity({ accessToken: 'tok', activityId: '123' })
    expect(a.id).toBe(123)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.strava.com/api/v3/activities/123')
    expect(opts.headers.authorization).toBe('Bearer tok')
  })

  it('listActivities passes after + per_page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ([{ id: 1 }, { id: 2 }]) })
    vi.stubGlobal('fetch', fetchMock)
    const rows = await listActivities({ accessToken: 'tok', afterEpoch: 1700000000, perPage: 50 })
    expect(rows).toHaveLength(2)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('after=1700000000')
    expect(url).toContain('per_page=50')
  })

  it('throws on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'nope' }))
    await expect(getActivity({ accessToken: 't', activityId: '1' })).rejects.toThrow(/Strava activity fetch failed: 401/)
  })
})
```
- [ ] **Step 2:** `npx vitest run src/lib/strava.test.js` → FAIL (functions not exported).
- [ ] **Step 3: Implement** — append to `src/lib/strava.js` (uses the module's existing `STRAVA_API_BASE`):
```js
/**
 * Fetch a single DETAILED activity (includes `calories`). Throws on non-2xx.
 */
export async function getActivity({ accessToken, activityId }) {
  const res = await fetch(`${STRAVA_API_BASE}/activities/${encodeURIComponent(activityId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Strava activity fetch failed: ${res.status} ${txt.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * List the athlete's SUMMARY activities (for backfill). `afterEpoch` is a Unix
 * seconds lower bound. Returns the array as-is. Throws on non-2xx.
 */
export async function listActivities({ accessToken, afterEpoch, perPage = 100 }) {
  const u = new URL(`${STRAVA_API_BASE}/athlete/activities`)
  if (afterEpoch) u.searchParams.set('after', String(afterEpoch))
  u.searchParams.set('per_page', String(perPage))
  const res = await fetch(u.toString(), { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Strava activities list failed: ${res.status} ${txt.slice(0, 200)}`)
  }
  return res.json()
}
```
- [ ] **Step 4:** `npx vitest run src/lib/strava.test.js` → PASS.
- [ ] **Step 5:** Commit `git add src/lib/strava.js src/lib/strava.test.js && git commit -m "strava client: getActivity + listActivities (inbound reads)"`

---

## Task 3: Pure mapper `strava-direct-map.js`

**Files:** Create `un1t-crm/src/lib/strava-direct-map.js` + `.test.js`

- [ ] **Step 1: Write the failing test**
```js
import { describe, it, expect } from 'vitest'
import { mapStravaApiActivity } from './strava-direct-map.js'

describe('mapStravaApiActivity', () => {
  it('maps a detailed Strava activity → strava_activities row', () => {
    const row = mapStravaApiActivity({
      contactId: 'c1', athleteId: '883513483',
      activity: {
        id: 19032691312, name: 'Morning Run', type: 'Run', sport_type: 'Run',
        start_date: '2026-06-23T08:00:00Z', moving_time: 4200, elapsed_time: 4300,
        distance: 10000, calories: 640, average_heartrate: 151, max_heartrate: 176,
      },
    })
    expect(row).toMatchObject({
      contact_id: 'c1', strava_activity_id: '19032691312', activity_type: 'Run',
      name: 'Morning Run', started_at: '2026-06-23T08:00:00Z', duration_seconds: 4200,
      distance_meters: 10000, calories_kcal: 640, avg_hr_bpm: 151, max_hr_bpm: 176,
    })
    expect(row.raw_metadata.source).toBe('strava')
    expect(row.raw_metadata.strava_athlete_id).toBe('883513483')
  })
  it('summary activity (no calories) → null calories; falls back to elapsed_time', () => {
    const row = mapStravaApiActivity({ contactId: 'c1', activity: { id: 7, type: 'Ride', elapsed_time: 1800 } })
    expect(row.calories_kcal).toBeNull()
    expect(row.duration_seconds).toBe(1800)
  })
  it('null id → null strava_activity_id; bad numerics → null; tolerates null activity', () => {
    expect(mapStravaApiActivity({ contactId: 'c1', activity: {} }).strava_activity_id).toBeNull()
    expect(mapStravaApiActivity({ contactId: 'c1', activity: { id: 'x', distance: '' } }).distance_meters).toBeNull()
    expect(() => mapStravaApiActivity({ contactId: 'c1', activity: null })).not.toThrow()
  })
})
```
- [ ] **Step 2:** `npx vitest run src/lib/strava-direct-map.test.js` → FAIL.
- [ ] **Step 3: Implement**
```js
// Pure: a raw Strava REST activity (summary OR detailed) → a strava_activities row.
// strava_activity_id is Strava's real numeric activity id (the dedup key for the
// direct path). Personal-only store (mig 308) — never a heart_rate_sessions row.
export function mapStravaApiActivity({ contactId, activity, athleteId = null } = {}) {
  const a = activity || {}
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const str = (v) => (v === null || v === undefined || v === '' ? null : String(v))
  return {
    contact_id: contactId,
    strava_activity_id: str(a.id),
    activity_type: str(a.sport_type || a.type),
    name: str(a.name),
    started_at: a.start_date ?? null,
    duration_seconds: num(a.moving_time ?? a.elapsed_time),
    distance_meters: num(a.distance),
    calories_kcal: num(a.calories),
    avg_hr_bpm: num(a.average_heartrate),
    max_hr_bpm: num(a.max_heartrate),
    raw_metadata: { source: 'strava', strava_athlete_id: athleteId ?? null, type: a.type ?? null, sport_type: a.sport_type ?? null },
  }
}
```
- [ ] **Step 4:** `npx vitest run src/lib/strava-direct-map.test.js` → PASS.
- [ ] **Step 5:** Commit.

---

## Task 4: Shared ingest IO — `strava-import.js`

**Files:** Create `un1t-crm/src/lib/strava-import.js` + `.test.js`. Reference `src/lib/external-export.js` for how the export loads `service_integrations` creds + refreshes — mirror it (do NOT invent a second pattern).

The lib exposes:
- `loadStravaConfig(db)` → `{ clientId, clientSecret, scopes, isEnabled }` from `service_integrations` where `provider='strava'`.
- `ensureFreshToken(db, connection, config)` → returns a live access token; if `connection.expires_at` is within 120s of now, calls `refreshAccessToken` and persists the rotated tokens to `contact_external_integrations`.
- `ingestActivity(db, { connection, activityId, config })` → `ensureFreshToken` → `getActivity` → `mapStravaApiActivity` → upsert `strava_activities` (onConflict `contact_id,strava_activity_id`).
- `backfillConnection(db, { connection, config, sinceMs })` → `ensureFreshToken` → `listActivities(after)` → map each → upsert.

- [ ] **Step 1: Write the failing test** (focus on `ensureFreshToken` — the logic with branches; mock the strava client + db)
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./strava.js', () => ({
  refreshAccessToken: vi.fn(),
  getActivity: vi.fn(),
  listActivities: vi.fn(),
}))
import { ensureFreshToken } from './strava-import.js'
import { refreshAccessToken } from './strava.js'

beforeEach(() => vi.clearAllMocks())

function dbWithUpdateCapture(captured) {
  return { from: () => ({ update: (p) => { captured.payload = p; const c = { eq: () => c }; c.then = (r) => r({ error: null }); return c } }) }
}

const CONFIG = { clientId: 'cid', clientSecret: 'sec' }

describe('ensureFreshToken', () => {
  it('returns the current token when not near expiry', async () => {
    const conn = { id: 'x', access_token: 'live', refresh_token: 'r', expires_at: new Date(Date.now() + 3600_000).toISOString() }
    const token = await ensureFreshToken({ from: () => ({}) }, conn, CONFIG)
    expect(token).toBe('live')
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })
  it('refreshes + persists when expired', async () => {
    refreshAccessToken.mockResolvedValue({ accessToken: 'fresh', refreshToken: 'r2', expiresAt: '2030-01-01T00:00:00Z' })
    const captured = {}
    const conn = { id: 'x', access_token: 'old', refresh_token: 'r', expires_at: new Date(Date.now() - 1000).toISOString() }
    const token = await ensureFreshToken(dbWithUpdateCapture(captured), conn, CONFIG)
    expect(token).toBe('fresh')
    expect(refreshAccessToken).toHaveBeenCalledWith({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'r' })
    expect(captured.payload).toMatchObject({ access_token: 'fresh', refresh_token: 'r2', expires_at: '2030-01-01T00:00:00Z' })
  })
})
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `src/lib/strava-import.js`:
```js
import { logWarn } from '@/lib/log'
import { refreshAccessToken, getActivity, listActivities } from '@/lib/strava'
import { mapStravaApiActivity } from '@/lib/strava-direct-map'

const REFRESH_MARGIN_MS = 120_000

export async function loadStravaConfig(db) {
  const { data } = await db
    .from('service_integrations')
    .select('client_id, client_secret, scopes, is_enabled')
    .eq('provider', 'strava')
    .maybeSingle()
  if (!data) return null
  return { clientId: data.client_id, clientSecret: data.client_secret, scopes: data.scopes || [], isEnabled: !!data.is_enabled }
}

export async function ensureFreshToken(db, connection, config) {
  const expMs = connection.expires_at ? Date.parse(connection.expires_at) : 0
  if (expMs - Date.now() > REFRESH_MARGIN_MS) return connection.access_token
  const fresh = await refreshAccessToken({
    clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: connection.refresh_token,
  })
  await db.from('contact_external_integrations')
    .update({ access_token: fresh.accessToken, refresh_token: fresh.refreshToken, expires_at: fresh.expiresAt, last_error: null })
    .eq('id', connection.id)
  // keep the in-memory row current for subsequent calls in the same tick
  connection.access_token = fresh.accessToken
  connection.refresh_token = fresh.refreshToken
  connection.expires_at = fresh.expiresAt
  return fresh.accessToken
}

export async function ingestActivity(db, { connection, activityId, config }) {
  const token = await ensureFreshToken(db, connection, config)
  const activity = await getActivity({ accessToken: token, activityId })
  const row = mapStravaApiActivity({ contactId: connection.contact_id, activity, athleteId: connection.external_athlete_id })
  if (!row.strava_activity_id) return { skipped: 'no_id' }
  const { error } = await db.from('strava_activities').upsert(row, { onConflict: 'contact_id,strava_activity_id' })
  if (error) { logWarn('strava-import', 'upsert failed', { err: error, activityId }); return { skipped: 'upsert_failed' } }
  return { ingested: row.strava_activity_id }
}

export async function backfillConnection(db, { connection, config, sinceMs }) {
  const token = await ensureFreshToken(db, connection, config)
  const afterEpoch = Math.floor(sinceMs / 1000)
  const activities = await listActivities({ accessToken: token, afterEpoch, perPage: 100 })
  let n = 0
  for (const activity of activities || []) {
    const row = mapStravaApiActivity({ contactId: connection.contact_id, activity, athleteId: connection.external_athlete_id })
    if (!row.strava_activity_id) continue
    const { error } = await db.from('strava_activities').upsert(row, { onConflict: 'contact_id,strava_activity_id' })
    if (!error) n += 1
  }
  return { backfilled: n }
}
```
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit. **During execution, verify `service_integrations` column names (`client_id`/`client_secret`/`scopes`/`is_enabled`) against `external-export.js`'s loader** — adjust `loadStravaConfig` if they differ.

---

## Task 5: Webhook receiver `/api/webhooks/strava`

**Files:** Create `un1t-crm/src/app/api/webhooks/strava/route.js` + `.test.js`. Modify `scripts/check-route-guards.mjs`.

- [ ] **Step 1: Write the failing test** (mock `@/lib/supabase` + `@/lib/strava-import`)
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/strava-import', () => ({ loadStravaConfig: vi.fn(), ingestActivity: vi.fn() }))
import { GET, POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { loadStravaConfig, ingestActivity } from '@/lib/strava-import'

beforeEach(() => { vi.clearAllMocks(); process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = 'vtok' })

function req(url, body) {
  return { url, json: async () => body }
}
// db where the connection lookup resolves to `connection`
function db(connection) {
  return { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: connection }) }) }) }) }) }) }
}

describe('GET handshake', () => {
  it('echoes challenge when verify_token matches', async () => {
    const res = await GET(req('https://x/api/webhooks/strava?hub.mode=subscribe&hub.verify_token=vtok&hub.challenge=abc'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ 'hub.challenge': 'abc' })
  })
  it('403 on token mismatch', async () => {
    const res = await GET(req('https://x/api/webhooks/strava?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=abc'))
    expect(res.status).toBe(403)
  })
})

describe('POST events', () => {
  it('create → ingestActivity for the matched member', async () => {
    createServerClient.mockReturnValue(db({ id: 'conn', contact_id: 'c1', external_athlete_id: '999' }))
    loadStravaConfig.mockResolvedValue({ clientId: 'a', clientSecret: 'b' })
    ingestActivity.mockResolvedValue({ ingested: '123' })
    const res = await POST(req('https://x/api/webhooks/strava', { object_type: 'activity', aspect_type: 'create', object_id: 123, owner_id: 999 }))
    expect(res.status).toBe(200)
    expect(ingestActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ activityId: 123 }))
  })
  it('unknown athlete → 200, no ingest', async () => {
    createServerClient.mockReturnValue(db(null))
    const res = await POST(req('https://x/api/webhooks/strava', { object_type: 'activity', aspect_type: 'create', object_id: 1, owner_id: 5 }))
    expect(res.status).toBe(200)
    expect(ingestActivity).not.toHaveBeenCalled()
  })
  it('non-activity object → ignored', async () => {
    const res = await POST(req('https://x/api/webhooks/strava', { object_type: 'athlete', aspect_type: 'update', object_id: 1, owner_id: 5 }))
    expect(res.status).toBe(200)
    expect(ingestActivity).not.toHaveBeenCalled()
  })
})
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `route.js`:
```js
// Strava push webhook. GET = subscription handshake (verify_token + echo challenge).
// POST = activity events. Strava does NOT sign webhook POSTs (events carry only ids,
// no sensitive data); we act only on owner_ids we have a token for and fetch detail
// with that member's own token. Always 200 fast so Strava doesn't disable the sub.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { loadStravaConfig, ingestActivity } from '@/lib/strava-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const u = new URL(request.url)
  if (u.searchParams.get('hub.mode') === 'subscribe'
    && u.searchParams.get('hub.verify_token') === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    return NextResponse.json({ 'hub.challenge': u.searchParams.get('hub.challenge') })
  }
  return NextResponse.json({ error: 'forbidden' }, { status: 403 })
}

export async function POST(request) {
  let evt
  try { evt = await request.json() } catch { return NextResponse.json({ success: true }) }
  if (evt?.object_type !== 'activity') return NextResponse.json({ success: true, ignored: 'non_activity' })

  const db = createServerClient()
  const { data: connection } = await db
    .from('contact_external_integrations')
    .select('id, contact_id, external_athlete_id, access_token, refresh_token, expires_at')
    .eq('provider', 'strava')
    .eq('external_athlete_id', String(evt.owner_id))
    .is('disconnected_at', null)
    .maybeSingle()
  if (!connection?.contact_id) return NextResponse.json({ success: true, skipped: 'unknown_athlete' })

  try {
    if (evt.aspect_type === 'delete') {
      await db.from('strava_activities').delete()
        .eq('contact_id', connection.contact_id).eq('strava_activity_id', String(evt.object_id))
      return NextResponse.json({ success: true, deleted: String(evt.object_id) })
    }
    // create | update
    const config = await loadStravaConfig(db)
    if (!config) return NextResponse.json({ success: true, skipped: 'not_configured' })
    const r = await ingestActivity(db, { connection, activityId: evt.object_id, config })
    return NextResponse.json({ success: true, ...r })
  } catch (e) {
    console.warn(`[strava-webhook] ingest failed for activity ${evt.object_id}: ${e?.message || e}`)
    return NextResponse.json({ success: true, skipped: 'ingest_error' })
  }
}
```
- [ ] **Step 4:** Run → PASS. Then `npm run check:route-guards` → it will FLAG `/api/webhooks/strava` (no `verify*()` HMAC). Add to the `EXEMPT` map in `scripts/check-route-guards.mjs`:
```js
'src/app/api/webhooks/strava/route.js': 'Strava does not sign webhook POSTs; GET handshake verifies via STRAVA_WEBHOOK_VERIFY_TOKEN, POST acts only on known owner_ids + fetches with our own token',
```
- [ ] **Step 5:** `npm run check:route-guards` → clean. Commit route + test + the guard entry.

---

## Task 6: Backfill cron `/api/cron/strava-import`

**Files:** Create `un1t-crm/src/app/api/cron/strava-import/route.js`. Modify `vercel.json`.

- [ ] **Step 1:** Implement the cron (CRON_SECRET-gated; mirror an existing cron route's auth + `stampHeartbeat`):
```js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadStravaConfig, backfillConnection } from '@/lib/strava-import'

export const runtime = 'nodejs'
export const maxDuration = 300

const BACKFILL_DAYS = 30

export async function GET(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const config = await loadStravaConfig(db)
  if (!config?.isEnabled) { await stampHeartbeat('strava-import'); return NextResponse.json({ success: true, skipped: 'not_configured' }) }

  // Connections that have the read scope but haven't been backfilled yet.
  const { data: pending } = await db
    .from('contact_external_integrations')
    .select('id, contact_id, external_athlete_id, access_token, refresh_token, expires_at, scopes')
    .eq('provider', 'strava')
    .is('disconnected_at', null)
    .is('import_backfilled_at', null)
    .limit(50)

  const sinceMs = Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000
  let done = 0
  for (const connection of pending || []) {
    const hasRead = (connection.scopes || []).some((s) => s === 'activity:read' || s === 'activity:read_all')
    if (!hasRead) continue
    try {
      await backfillConnection(db, { connection, config, sinceMs })
      await db.from('contact_external_integrations').update({ import_backfilled_at: new Date().toISOString() }).eq('id', connection.id)
      done += 1
    } catch (e) {
      console.warn(`[cron strava-import] backfill failed for ${connection.id}: ${e?.message || e}`)
    }
  }
  await stampHeartbeat('strava-import')
  return NextResponse.json({ success: true, backfilled_connections: done })
}
```
- [ ] **Step 2:** Add to `vercel.json` `crons`: `{ "path": "/api/cron/strava-import", "schedule": "*/5 * * * *" }`.
- [ ] **Step 3:** `npm run check:route-guards` (cron auth recognised) + `npm test`. Commit cron + vercel.json.

---

## Task 7: Decommission OW Strava in IB5

**Files:** Modify `un1t-crm/src/app/api/webhooks/openwearables/route.js` + `route.test.js`.

- [ ] **Step 1:** Replace the `connectionProvider === 'strava'` branch body (the `strava_activities` upsert) with an explicit ignore, and drop the now-unused `mapStravaActivity` import:
```js
// Strava is ingested DIRECTLY now (not via OW) — ignore any stray OW strava event
// so it can never fall through to the session/pull path.
if (connectionProvider === 'strava') {
  return NextResponse.json({ success: true, skipped: 'strava_handled_directly' })
}
```
- [ ] **Step 2:** Update `route.test.js` — the existing "strava event → upserts strava_activities" test becomes "strava event → ignored (handled directly), no upsert / no session". Run → PASS. Remove the now-dead `mapStravaActivity` mock if present.
- [ ] **Step 3:** Commit.

---

## Task 8: champ-app — add read scope + retire OW import UI

**Files (champ-app):** Modify `src/lib/strava-oauth.js`, `src/app/account/integrations/page.jsx`, `src/app/account/integrations/IntegrationsManager.jsx`, `mobile/app/account/integrations.jsx`. Delete `src/app/account/integrations/StravaImportCard.jsx`, `src/app/api/wearables/strava/connect/route.js` (+ `.test.js`), `mobile/app/account/connect-strava.jsx`.

- [ ] **Step 1:** `strava-oauth.js` — change the fallback default scopes to include read:
```js
u.searchParams.set('scope', (provider.scopes || ['activity:write', 'activity:read_all', 'read']).join(','))
```
- [ ] **Step 2:** Delete the OW import surfaces + un-wire them: remove `StravaImportCard` import + the "Import your activities" `<section>` from `integrations/page.jsx` (and the `stravaConn` query); remove the Strava inbound `<Pressable>` (→ `/account/connect-strava`) from `mobile/app/account/integrations.jsx`; `git rm` `StravaImportCard.jsx`, `connect-strava.jsx`, `api/wearables/strava/connect/route.js` + its test.
- [ ] **Step 3:** `IntegrationsManager.jsx` — update the `strava` `PROVIDER_META.blurb` to: `'Connect Strava to import your activities here and (optionally) auto-post your UN1T sessions back to Strava.'`
- [ ] **Step 4:** `npm test && npm run lint && npm run build` (champ-app) → green. Commit the scope change + UI consolidation.

---

## Task 9: Ship + operator one-time + live E2E

- [ ] **Step 1:** un1t-crm: full CI mirror + `npm run build` green → push `strava-direct-inbound`, PR base `main`, merge after Vercel check green.
- [ ] **Step 2:** champ-app: CI + build green → push `strava-direct-inbound`, PR base `main`, merge.
- [ ] **Step 3 (operator/agent one-time):**
  - Set un1t-crm Vercel env `STRAVA_WEBHOOK_VERIFY_TOKEN` (random string) + redeploy.
  - Enable `strava` in `service_integrations` with `scopes` = `['read','activity:write','activity:read_all']`, `is_enabled=true`, client_id/secret = the Strava app (260114).
  - Register the push subscription (agent, after deploy): `curl -X POST https://www.strava.com/api/v3/push_subscriptions -F client_id=<id> -F client_secret=<secret> -F callback_url=https://crm.un1tdublin.com/api/webhooks/strava -F verify_token=$STRAVA_WEBHOOK_VERIFY_TOKEN` → expect `{ id }` (Strava GETs the callback to verify first).
  - Richard reconnects Strava in champ-app (grants `activity:read_all`).
  - Data cleanup: `DELETE FROM hr_provider_connections WHERE provider='strava'`; `DELETE FROM strava_activities WHERE raw_metadata->>'source' = 'strava' AND strava_activity_id !~ '^[0-9]+$'` (removes the 2 OW-uuid rows; the backfill re-creates them keyed by real Strava ids). Optional: `DELETE /api/v1/providers/strava/users/{owUserId}/connections/strava` on OW.
- [ ] **Step 4 (live E2E):** after reconnect, the cron backfills (≤5 min) → history on Progress. Log a new Strava activity → webhook delivers (check `strava_activities` for the new real-id row + Svix/Strava sub has no errors) → on Progress. Confirm `SELECT count(*) FROM heart_rate_sessions WHERE raw_metadata->>'source'='strava'` = 0.

---

## Self-review notes
- **Spec coverage:** scope add (T8), client reads (T2), mapper (T3), ingest IO incl. token refresh (T4), webhook GET+POST+delete (T5), backfill cron + column (T1,T6), OW decommission (T7), UI consolidation (T8), operator steps + E2E (T9). All spec sections covered.
- **Type consistency:** `mapStravaApiActivity({contactId, activity, athleteId})`, `ensureFreshToken(db, connection, config)`, `ingestActivity(db,{connection,activityId,config})`, `backfillConnection(db,{connection,config,sinceMs})`, `loadStravaConfig(db)→{clientId,clientSecret,scopes,isEnabled}` — names used consistently across tasks.
- **Verify-at-execution:** `service_integrations` column names (Task 4, vs `external-export.js`); the route-guard EXEMPT path format (Task 5); `contact_external_integrations` onConflict columns unchanged (we only add a column).
