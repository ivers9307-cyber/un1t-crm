# Strava Inbound (personal-only, via OpenWearables) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member connects Strava (via OpenWearables) and sees *their own* Strava activities on *their own* dashboard/progress — never in any community/points surface.

**Architecture:** OW runs the Strava OAuth + sync + webhook + token refresh. The existing IB5 webhook (`/api/webhooks/openwearables`) **branches** on `provider==='strava'` and upserts into a dedicated **`strava_activities`** table (member-own RLS, no location/staff/points), then returns — it never touches `heart_rate_sessions`, `finalizeSessionRewards`, or class-correlation. Personal-only is enforced structurally (separate store), not by per-query filters.

**Tech Stack:** Next.js 16 + Supabase (un1t-crm + champ-app), OpenWearables (Fly), Vitest. Reuses the IB1 OW client + the IB4 connect pattern.

**Spec:** `docs/superpowers/specs/2026-06-22-strava-inbound-design.md`

**Branches:** un1t-crm work on `strava-inbound` (off fresh main; spec lives here). champ-app work on a sibling `strava-inbound` off its `main` (cut it AFTER `git fetch origin main`). 

**Pre-push CI mirror:** un1t-crm `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`; champ-app `npm test && npm run lint`.

---

## PHASE 0 — Spike (THE GATE — partly operator-run; do before Phase 1)

Not codeable TDD tasks — ops + verification. The build (Phase 1) assumes these pinned the payload shape + connect URLs. If OW can't deliver Strava activities or the callback can't be resolved, STOP and reconsider (direct integration).

- [ ] **S1 — Configure OW's Strava provider.** With OW admin/dev creds, `PUT https://un1t-ow-backend.fly.dev/api/v1/oauth/providers/strava` setting `client_id` + `client_secret` (from `service_integrations` where `provider='strava'`). Confirm `GET /api/v1/oauth/providers?enabled_only=true` lists `strava`. *(Operator supplies OW creds; agent can run the calls.)*
- [ ] **S2 — Resolve Strava's single Authorization Callback Domain.** OW's OAuth callback is `un1t-ow-backend.fly.dev`; the export app uses `app.champfitness.ie`. Decide: (a) the existing Strava app can't host two domains → register a **second Strava app** with callback `un1t-ow-backend.fly.dev` and use ITS client_id/secret in S1; or (b) confirm OW supports a custom redirect through champ-app's domain. **Record the chosen app's client_id/secret + the exact OW authorize URL** — these feed Task 4. *(Operator decision + Strava dashboard.)*
- [ ] **S3 — Connect a real Strava account through OW** (Richard): hit OW's `GET /api/v1/oauth/strava/authorize?user_id=<an OW user>&redirect_uri=<any>` in a browser, authorize on Strava, confirm OW stores the connection. Then confirm OW **syncs activities** and **fires `workout.created`** to the Svix endpoint with `data.source.provider === 'strava'`. **Capture the real payload JSON** (from the Svix dashboard or `crm.un1tdublin.com` logs) — pin the field names (`data.{id,type,name,start_time,end_time,duration_seconds,distance_meters,calories_kcal,avg_heart_rate_bpm,max_heart_rate_bpm}`).
- [ ] **S4 — Gate decision.** Activities flow + payload captured → proceed to Phase 1, adjusting `mapStravaActivity` (Task 2) to the real field names if they differ from the assumed Workout-Output shape. Otherwise stop.

---

## PHASE 1 — Build (post-spike)

### Task 1: Migration 308 — `strava_activities`

**Files:** Create `un1t-crm/supabase/migrations/308_strava_activities.sql`

- [ ] **Step 1: Write the SQL**
```sql
-- 308: personal-only Strava activity store. Strava API Policy §5.4 forbids
-- showing derived Strava data to other members, so this table is read ONLY by
-- the member's own views: member-own RLS, NO location_id, NO staff policy, NO
-- points columns. It is deliberately NOT heart_rate_sessions.
CREATE TABLE strava_activities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  strava_activity_id text NOT NULL,
  activity_type      text,
  name               text,
  started_at         timestamptz,
  duration_seconds   numeric,
  distance_meters    numeric,
  calories_kcal      numeric,
  avg_hr_bpm         numeric,
  max_hr_bpm         numeric,
  raw_metadata       jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, strava_activity_id)
);
CREATE INDEX idx_strava_activities_contact ON strava_activities (contact_id, started_at DESC);
ALTER TABLE strava_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers view own strava activities" ON strava_activities
  FOR SELECT TO public USING (contact_id = (SELECT private.auth_contact_id()));
-- service-role writes only (the webhook). NO staff policy by design.
```
- [ ] **Step 2:** Apply via Supabase MCP (`apply_migration`, `308_strava_activities`).
- [ ] **Step 3:** `get_advisors` type=security — confirm `strava_activities` has its SELECT policy (not in `rls_enabled_no_policy`) and no new ERROR.
- [ ] **Step 4:** Commit `git add supabase/migrations/308_strava_activities.sql && git commit -m "mig 308 — strava_activities personal-only store"`

---

### Task 2: `mapStravaActivity` pure lib (un1t-crm)

**Files:** Create `un1t-crm/src/lib/strava-activity-map.js` + `.test.js`

- [ ] **Step 1: Write the failing test**
```js
import { describe, it, expect } from 'vitest'
import { mapStravaActivity } from './strava-activity-map.js'

describe('mapStravaActivity', () => {
  it('maps an OW strava workout payload → strava_activities row', () => {
    const row = mapStravaActivity({
      contactId: 'c1',
      activity: {
        id: 'strava-987', type: 'running', name: 'Morning Run',
        start_time: '2026-06-21T06:30:00Z', end_time: '2026-06-21T07:10:00Z',
        duration_seconds: 2400, distance_meters: 8000, calories_kcal: 540,
        avg_heart_rate_bpm: 150, max_heart_rate_bpm: 178,
      },
    })
    expect(row).toMatchObject({
      contact_id: 'c1', strava_activity_id: 'strava-987', activity_type: 'running',
      name: 'Morning Run', started_at: '2026-06-21T06:30:00Z', duration_seconds: 2400,
      distance_meters: 8000, calories_kcal: 540, avg_hr_bpm: 150, max_hr_bpm: 178,
    })
    expect(row.raw_metadata).toBeTruthy()
  })
  it('returns null strava_activity_id when the activity id is missing', () => {
    expect(mapStravaActivity({ contactId: 'c1', activity: {} }).strava_activity_id).toBeNull()
  })
  it('coerces bad numerics to null and tolerates a null activity', () => {
    const row = mapStravaActivity({ contactId: 'c1', activity: { id: 'x', distance_meters: '' } })
    expect(row.distance_meters).toBeNull()
    expect(() => mapStravaActivity({ contactId: 'c1', activity: null })).not.toThrow()
  })
})
```
- [ ] **Step 2:** `npx vitest run src/lib/strava-activity-map.test.js` → FAIL.
- [ ] **Step 3: Implement**
```js
// Pure: an OW strava workout.created payload's `data` → a strava_activities row.
// Personal-only store (mig 308) — never a heart_rate_sessions row.
export function mapStravaActivity({ contactId, activity } = {}) {
  const a = activity || {}
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const str = (v) => (v === null || v === undefined || v === '' ? null : String(v))
  return {
    contact_id: contactId,
    strava_activity_id: str(a.id),
    activity_type: str(a.type),
    name: str(a.name),
    started_at: a.start_time ?? null,
    duration_seconds: num(a.duration_seconds),
    distance_meters: num(a.distance_meters),
    calories_kcal: num(a.calories_kcal),
    avg_hr_bpm: num(a.avg_heart_rate_bpm),
    max_hr_bpm: num(a.max_heart_rate_bpm),
    raw_metadata: { ow_activity_id: a.id ?? null, source: 'strava' },
  }
}
```
- [ ] **Step 4:** `npx vitest run src/lib/strava-activity-map.test.js` → PASS.
- [ ] **Step 5:** Commit `git add src/lib/strava-activity-map.js src/lib/strava-activity-map.test.js && git commit -m "strava: pure activity→row mapper"`

---

### Task 3: IB5 webhook branch + `normaliseProvider` recognises strava

**Files:** Modify `un1t-crm/src/app/api/webhooks/openwearables/route.js`; Test: `route.test.js`

- [ ] **Step 1: Write the failing test** (append to the POST describe block in `route.test.js`):
```js
it('strava event → upserts strava_activities, NEVER a session/points/class-link', async () => {
  const upsert = vi.fn(() => Promise.resolve({ error: null }))
  const db = makeDb({
    connection: { id: 'conn-s', contact_id: 'c-1' },
    contact: { id: 'c-1', location_id: 'loc-1', max_hr_override: null, dob: null },
    location: { id: 'loc-1', settings: {} },
  })
  db.from = ((orig) => (table) => (table === 'strava_activities' ? { upsert } : orig(table)))(db.from)
  createServerClient.mockReturnValue(db)
  const body = JSON.stringify({ type: 'workout.created', data: { id: 'str-1', type: 'ride', user_id: 'ow-u', start_time: '2026-06-21T06:00:00Z', source: { provider: 'strava' } } })
  const res = await POST(makeRequest({ body }))
  const json = await res.json()
  expect(res.status).toBe(200)
  expect(json.strava).toBe('str-1')
  expect(upsert).toHaveBeenCalledTimes(1)
  expect(db._inserts).toHaveLength(0)              // no heart_rate_sessions insert
  expect(finalizeSessionRewards).not.toHaveBeenCalled()  // no points
})
```
(If `makeDb` doesn't allow overriding `from`, extend `makeDb` to accept a `strava` upsert mock instead — keep it minimal.)
- [ ] **Step 2:** `npx vitest run src/app/api/webhooks/openwearables/route.test.js` → the new test FAILS.
- [ ] **Step 3: Implement** — two edits to `route.js`:

  (a) `normaliseProvider` (~line 450): add `'strava'` to `KNOWN`:
  ```js
  const KNOWN = new Set(['apple_health', 'fitbit', 'whoop', 'garmin', 'strava'])
  ```
  (b) After the member is resolved (right after the `if (!connection?.contact_id) { … unknown_user }` block, BEFORE the contact/location loads), insert the strava branch:
  ```js
  // ── Strava: PERSONAL-ONLY (ToS §5.4). Land in strava_activities and return —
  // never a heart_rate_sessions row, never finalizeSessionRewards, never a
  // class link. So Strava data cannot reach any community/points surface.
  if (connectionProvider === 'strava') {
    const root = message?.payload && typeof message.payload === 'object' ? message.payload : message
    const activity = (root?.workout && typeof root.workout === 'object' ? root.workout : null)
      || (root?.data && typeof root.data === 'object' ? root.data : null)
    const row = mapStravaActivity({ contactId: connection.contact_id, activity })
    if (!row.strava_activity_id) {
      return NextResponse.json({ success: true, skipped: 'incomplete_payload' })
    }
    const { error: stravaErr } = await db
      .from('strava_activities')
      .upsert(row, { onConflict: 'contact_id,strava_activity_id' })
    if (stravaErr) {
      console.warn(`[ow-webhook] strava upsert failed for ${row.strava_activity_id}: ${stravaErr.message}`)
      return NextResponse.json({ success: true, skipped: 'strava_upsert_failed' })
    }
    return NextResponse.json({ success: true, strava: row.strava_activity_id })
  }
  ```
  (c) Add the import at the top: `import { mapStravaActivity } from '@/lib/strava-activity-map'`
- [ ] **Step 4:** `npx vitest run src/app/api/webhooks/openwearables/route.test.js` → ALL pass (existing apple/pull tests untouched).
- [ ] **Step 5:** `npm run check:route-guards` (webhook still recognised). Commit `git add src/app/api/webhooks/openwearables/route.js src/app/api/webhooks/openwearables/route.test.js && git commit -m "IB5 — strava branch: personal-only upsert to strava_activities, skip session/points"`

---

### Task 4: champ-app — Connect Strava (via OW OAuth)

**Files:** Create `champ-app/src/app/api/wearables/strava/connect/route.js`; modify the integrations screen(s) (`src/app/account/integrations/IntegrationsManager.jsx` + `mobile/app/account/integrations.jsx`). Read `src/app/api/wearables/connect/route.js` (IB4) for the auth + `ensureUser` + `hr_provider_connections` upsert pattern.

- [ ] **Step 1:** Endpoint `POST /api/wearables/strava/connect` — authenticate the member (cookie/Bearer) → `contacts` row; `ensureUser({ externalUserId: contact_id })` to get the OW user id; **upsert `hr_provider_connections`** `{ contact_id, provider:'strava', provider_user_id: owUserId, status:'active' }` (service-role) so IB5 resolves the member; build and return `{ authorizeUrl }` = `${OW_BASE}/api/v1/oauth/strava/authorize?user_id=${owUserId}&redirect_uri=${encodeURIComponent(<champ-app integrations return URL>)}`. **Use the exact authorize base/params pinned in Phase 0 (S2/S3).** `DELETE` revokes (status='revoked' + best-effort OW revoke). NO dev creds returned/logged (mirror IB4).
- [ ] **Step 2:** Integrations UI — add a **"Connect Strava"** button that calls the endpoint and `window.location = authorizeUrl` (web) / opens it via `expo-web-browser` (native, mirroring the existing OAuth integrations). Show connected/disconnect state from the `hr_provider_connections` strava row.
- [ ] **Step 3:** Lint (`npm run lint`) + (native) `npm run check:mobile-imports` if present. Manual reasoning only — no unit test for the redirect glue; the route's pure pieces (URL build) can have a tiny test if cheap.
- [ ] **Step 4:** Commit the endpoint + UI (`git add` the specific files).

---

### Task 5: champ-app — "Your Strava activities" display (member-own only)

**Files:** Modify `champ-app/src/app/progress/page.jsx` + `ProgressView.jsx` (web) and `mobile/app/(tabs)/progress.jsx` (native).

- [ ] **Step 1:** Load the member's `strava_activities` (RLS-scoped): `.from('strava_activities').select('strava_activity_id, activity_type, name, started_at, distance_meters, duration_seconds, avg_hr_bpm, max_hr_bpm').order('started_at', { ascending: false }).limit(30)`. Mirror how `page.jsx` already loads `heart_rate_sessions` / `member_health_metrics`.
- [ ] **Step 2:** Render a **"Your Strava activities"** card listing each activity (type label, date, distance km, duration, HR if present). Reuse the `shared/workout-detail.js` formatters (`workoutLabel`, `formatDistance`) where they fit. Render only when there are rows. This card lives ONLY on the member's own Progress — do NOT add Strava to any leaderboard/feed/friend-board/challenge component.
- [ ] **Step 3:** Native equivalent in `progress.jsx` (same query + card, NativeWind styling).
- [ ] **Step 4:** `npm run lint`; commit web + native (`git add` specific files).

---

### Task 6: Ship

- [ ] **Step 1:** un1t-crm CI mirror (test/lint/parity/imports/route-guards) — green. Push `strava-inbound`; PR base `main`; merge after Vercel + Test&lint green.
- [ ] **Step 2:** champ-app CI (`npm test && npm run lint`) — green. Push `strava-inbound`; PR base `main`; merge after green.
- [ ] **Step 3:** **Verify live (post-spike):** with the real connected Strava account, confirm a new/synced activity lands in `strava_activities` (`SELECT … FROM strava_activities WHERE contact_id=…`) and appears on the member's Progress — and confirm it is ABSENT from `heart_rate_sessions` (`SELECT count(*) FROM heart_rate_sessions WHERE source='strava'` → 0) and from any leaderboard.

---

## Self-review notes / guardrails
- **The personal-only guarantee is the separate table.** No task adds `strava` to `heart_rate_sessions`, the finalizer, `credit-attendance`, challenges, leaderboards, the feed, or friend boards. If any future task touches those, it must NOT read `strava_activities`.
- `mapStravaActivity` field names assume the OW Workout-Output shape; **Phase 0 S3 pins the real names** — adjust Task 2 if they differ.
- Connect URLs (Task 4) depend on Phase 0 S2/S3 (callback domain + authorize URL).
- New imports added (un1t-crm: `mapStravaActivity`; champ-app: none beyond existing) — the Vercel PR check is the real build gate.
