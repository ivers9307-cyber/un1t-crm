# Staff Device Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface, per staff member: current app version + "outdated" verdict, all registered devices, and geofence permission state — plus a throttled nudge-to-update push.

**Architecture:** One pure lib (`src/lib/staff-devices.js`) owns every verdict (current device, staleness, semver compare, target version, outdated/no-device). Three surfaces consume it: the **existing** `/settings/notifications/health` page (fleet), the staff list (compact cell), and a Devices card on the staff profile. Mobile reports geofence permission + reports version even when push is declined.

**Tech Stack:** Next.js 16 App Router (server components), Supabase service-role, Zod, Vitest; Expo (expo-constants, expo-device).

**Spec:** `docs/superpowers/specs/2026-07-31-staff-devices-visibility-design.md`
**Branch:** `feat/staff-devices` (worktree `~/code/un1t-crm-geofence`)

**Amendments to the spec, from codebase scouting** (authoritative — the spec predates them):
1. **Do NOT build a new fleet page.** `src/app/settings/notifications/health/page.js` already IS the device fleet view (same `hasPermission(user,'settings')` gate, already selects `device_tokens(id,user_id,platform,device_name,app_version,created_at,last_seen_at)`, already has `statusForUser` bucketing with `HEALTHY_DAYS=14`, `fmtRelative`, `SummaryCard`, `StatusPill`). Extend it.
2. **`StatusPill.amber` uses `text-amber-200`** (`health/page.js:256`) — violates the chip-contrast invariant. Fix the ramp to `-700` while touching the file.
3. **90-day sweep exists** (`src/app/api/cron/sweep-stale-push-tokens/route.js`, `STALE_AFTER_DAYS=90`) — rows older than 90d are deleted, so "no device" already means "nothing in 90 days". Don't add a competing 90d rule.
4. **`app_version` only lands when push registration succeeds** (`mobile/lib/push-register.js` early-returns on simulator / studio kiosk / permission-denied). Task 7 fixes this so version is reported regardless of push consent.
5. `device_tokens` upsert conflict target is `expo_push_token`, and omitted optional fields overwrite to null — any new column must be sent by the client on every register or it will be wiped.

**Rules that bind every task** (CLAUDE.md): service-role routes get no RLS — gate in app code; builders are thenables (`try/await/catch`, never `.catch()`); await every write; chips are `bg-<c>-500/10 text-<c>-700`; `type="button"` on non-submit buttons; no `console.log` in prod paths; mobile never imports `src/lib`; mobile calls go through `api()`. Commit per task: `STAFF-DEV.<n> — <summary>`.

---

### Task 1: Migration 466 — geofence permission + nudge throttle columns

**Files:** Create `supabase/migrations/466_device_tokens_permission_and_nudge.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 466_device_tokens_permission_and_nudge.sql
-- STAFF-DEV.1 — device visibility.
--
-- 1. geofence_permission / _at: what the OS reports for background
--    location on this device. NULL = never reported (client below
--    2.2.0, or pre-STAFF-DEV JS). NULL must render as "—", never as
--    "denied" — absence of data is not a denial.
-- 2. last_update_nudge_at: server-side throttle for the
--    nudge-to-update push (one per device per 24h).

ALTER TABLE public.device_tokens
  ADD COLUMN IF NOT EXISTS geofence_permission text,
  ADD COLUMN IF NOT EXISTS geofence_permission_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_update_nudge_at timestamptz;

ALTER TABLE public.device_tokens
  DROP CONSTRAINT IF EXISTS device_tokens_geofence_permission_check;
ALTER TABLE public.device_tokens
  ADD CONSTRAINT device_tokens_geofence_permission_check
  CHECK (geofence_permission IS NULL OR geofence_permission IN
    ('always', 'when_in_use', 'denied', 'undetermined'));

COMMENT ON COLUMN public.device_tokens.geofence_permission IS
  'STAFF-DEV (mig 466): OS background-location status last reported by this device. NULL = never reported; render as unknown, not denied.';
COMMENT ON COLUMN public.device_tokens.last_update_nudge_at IS
  'STAFF-DEV (mig 466): last time an update-nudge push was sent to this device. 24h throttle.';
```

- [ ] **Step 2:** `ls supabase/migrations | sort -n | tail -3` — 465 must be the latest, no other 466. **Do NOT apply** (supervisor applies via MCP).
- [ ] **Step 3: Commit** — `git add supabase/migrations/466_device_tokens_permission_and_nudge.sql && git commit -m "STAFF-DEV.1 — mig 466: device geofence permission + nudge throttle"`

---

### Task 2: `src/lib/staff-devices.js` — every verdict, one place (TDD)

**Files:** Create `src/lib/staff-devices.js` + `src/lib/staff-devices.test.js`

Clock is **injected** (`now` argument), never read from `Date.now()` inside — copy the design of `mobile/lib/foreground-update-logic.js` so tests need no fake timers.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/staff-devices.test.js
import { describe, it, expect } from 'vitest'
import {
  compareVersions, parseVersion, currentDevice, isStale, deriveTargetVersion,
  deviceVerdict, STALE_AFTER_DAYS,
} from './staff-devices.js'

const T0 = Date.parse('2026-07-31T12:00:00Z')
const daysAgo = (n) => new Date(T0 - n * 86400_000).toISOString()
const dev = (over = {}) => ({
  id: 'd1', user_id: 'u1', platform: 'ios', device_name: 'iPhone',
  app_version: '2.1.0', last_seen_at: daysAgo(0), ...over,
})

describe('parseVersion / compareVersions', () => {
  it('orders normal semver', () => {
    expect(compareVersions('2.2.0', '2.1.0')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.2.0')).toBeLessThan(0)
    expect(compareVersions('2.2.0', '2.2.0')).toBe(0)
  })
  it('compares numerically, not lexically (10 > 9)', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0)
  })
  it('treats missing minor/patch as zero', () => {
    expect(compareVersions('2', '2.0.0')).toBe(0)
    expect(compareVersions('2.1', '2.1.0')).toBe(0)
  })
  it('sorts junk lowest and never equal to a real version', () => {
    for (const junk of [null, undefined, '', '   ', 'abc', 'v-x']) {
      expect(compareVersions(junk, '0.0.1')).toBeLessThan(0)
    }
    expect(parseVersion('nonsense')).toBeNull()
  })
  it('tolerates a leading v and build suffixes', () => {
    expect(compareVersions('v2.2.0', '2.2.0')).toBe(0)
    expect(compareVersions('2.2.0-beta.1', '2.2.0')).toBe(0) // prerelease ignored, by design
  })
})

describe('currentDevice', () => {
  it('picks the most recently seen row', () => {
    const older = dev({ id: 'old', last_seen_at: daysAgo(40), app_version: '1.4.0' })
    const newer = dev({ id: 'new', last_seen_at: daysAgo(1), app_version: '2.1.0' })
    expect(currentDevice([older, newer]).id).toBe('new')
  })
  it('returns null for no devices', () => {
    expect(currentDevice([])).toBeNull()
    expect(currentDevice(null)).toBeNull()
  })
  it('ignores rows with no last_seen_at rather than crashing', () => {
    expect(currentDevice([dev({ id: 'x', last_seen_at: null })]).id).toBe('x')
  })
})

describe('isStale', () => {
  it(`flags devices unseen for more than ${STALE_AFTER_DAYS} days`, () => {
    expect(isStale(dev({ last_seen_at: daysAgo(STALE_AFTER_DAYS + 1) }), T0)).toBe(true)
    expect(isStale(dev({ last_seen_at: daysAgo(1) }), T0)).toBe(false)
  })
})

describe('deriveTargetVersion', () => {
  it('is the highest version among non-stale devices', () => {
    expect(deriveTargetVersion([
      dev({ app_version: '2.2.0' }), dev({ app_version: '2.1.0' }),
    ], T0)).toBe('2.2.0')
  })
  it('ignores stale devices, so an abandoned beta cannot set the bar', () => {
    expect(deriveTargetVersion([
      dev({ app_version: '9.9.9', last_seen_at: daysAgo(STALE_AFTER_DAYS + 5) }),
      dev({ app_version: '2.1.0' }),
    ], T0)).toBe('2.1.0')
  })
  it('returns null when there is nothing to go on', () => {
    expect(deriveTargetVersion([], T0)).toBeNull()
    expect(deriveTargetVersion([dev({ app_version: 'junk' })], T0)).toBeNull()
  })
})

describe('deviceVerdict', () => {
  const target = '2.2.0'
  it('no_device when the staff member has no rows', () => {
    expect(deviceVerdict([], target, T0).kind).toBe('no_device')
  })
  it('outdated when the current device is below target', () => {
    const v = deviceVerdict([dev({ app_version: '2.1.0' })], target, T0)
    expect(v.kind).toBe('outdated')
    expect(v.version).toBe('2.1.0')
  })
  it('current when the current device matches target', () => {
    expect(deviceVerdict([dev({ app_version: '2.2.0' })], target, T0).kind).toBe('current')
  })
  it('keys off the newest device, not the best version', () => {
    // Old iPad on a newer build must NOT mask a downgraded daily phone.
    const v = deviceVerdict([
      dev({ id: 'ipad', app_version: '2.2.0', last_seen_at: daysAgo(40) }),
      dev({ id: 'phone', app_version: '2.1.0', last_seen_at: daysAgo(0) }),
    ], target, T0)
    expect(v.kind).toBe('outdated')
    expect(v.deviceId).toBe('phone')
  })
  it('unknown_version when the current device reported no version', () => {
    expect(deviceVerdict([dev({ app_version: null })], target, T0).kind).toBe('unknown_version')
  })
  it('never reports outdated when there is no target to compare against', () => {
    expect(deviceVerdict([dev({ app_version: '2.1.0' })], null, T0).kind).toBe('current')
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lib/staff-devices.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/lib/staff-devices.js`. Exports: `STALE_AFTER_DAYS = 30`, `parseVersion(str) → [maj,min,patch]|null` (strip leading `v`, split on `.`, take leading integer of each part, ignore `-prerelease`/`+build`; return null if the first part isn't a number), `compareVersions(a,b) → -1|0|1` (nulls sort lowest; two nulls equal), `currentDevice(devices) → device|null` (max `last_seen_at`, nulls last, stable), `isStale(device, nowMs)`, `deriveTargetVersion(devices, nowMs) → string|null` (highest parseable version among non-stale), `deviceVerdict(devices, targetVersion, nowMs) → { kind: 'no_device'|'unknown_version'|'outdated'|'current', version, deviceId, lastSeenAt, stale }`. Pure: no IO, no `Date.now()`. JSDoc every export.
- [ ] **Step 4:** tests PASS. **Step 5: Commit** `STAFF-DEV.2 — staff-devices verdict lib`

---

### Task 3: `GET /api/staff-devices` — fleet payload (TDD)

**Files:** Create `src/app/api/staff-devices/route.js` + `route.test.js`; modify `src/lib/openapi.js`

Returns every active staff profile with their devices + verdict, so all three surfaces share one shape.

- [ ] **Step 1: Write failing tests** — copy the `makeDb` thenable-builder helper from `src/app/api/admin/studio-devices/activity/route.test.js:1-33` verbatim (add `.eq()`/`.gte()`/`.order()` returning `builder`). Cases: 401 unauthenticated; 403 when `hasPermission(user,'settings')` is false (assert `createServerClient` not called); 200 returns `{ success, data: { target_version, staff: [...] } }`; a staff member with no device rows appears with `verdict.kind === 'no_device'`; the newest device drives the verdict; devices array is sorted newest-first.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Gate: `getCurrentUser()` → 401; `hasPermission(user, 'settings')` → 403. Then service-role reads: `profiles` (`id, full_name, email, role, active`) filtered `active = true`, and `device_tokens` (`id, user_id, platform, device_name, app_version, last_seen_at, created_at, geofence_permission, geofence_permission_at`). Group devices by `user_id` in JS; `deriveTargetVersion` across all devices once; `deviceVerdict` per staff member. Response:

```js
{ success: true, data: {
    target_version: '2.2.0' | null,
    staff: [{ id, full_name, email, role,
              verdict: { kind, version, deviceId, lastSeenAt, stale },
              geofence_permission, geofence_permission_at,
              devices: [{ id, platform, device_name, app_version, last_seen_at, stale, geofence_permission }] }] } }
```

`geofence_permission` at staff level comes from the **current** device only. Both selects are bounded (≈22 staff, ≈11 devices) — no pagination needed, but add `.order('last_seen_at', { ascending: false })` on devices so the array order is deterministic.
- [ ] **Step 4:** tests PASS; `npm run check:route-guards` clean.
- [ ] **Step 5:** Register in `openapi.js` (tag `['Staff']`, security `[{ CookieAuth: [] }]`, summary "Staff app versions, devices and geofence permission").
- [ ] **Step 6: Commit** `STAFF-DEV.3 — staff-devices fleet endpoint`

---

### Task 4: Extend the notifications health page (fleet surface)

**Files:** Modify `src/app/settings/notifications/health/page.js`

Do **not** create a new page. This one already loads `device_tokens` and renders a per-staff device table.

- [ ] **Step 1:** Import `deriveTargetVersion`, `deviceVerdict`, `currentDevice` from `@/lib/staff-devices` and compute verdicts from the `device_tokens` rows it already fetches (pass `Date.now()` at the call site — the lib itself stays pure).
- [ ] **Step 2:** Add two columns to the existing per-staff table: **App version** (current device's version, or `—`) with an amber `Outdated` chip when `verdict.kind === 'outdated'`, and **Location permission** rendering `always` → green `Always`, `when_in_use` → amber `While using`, `denied` → red `Denied`, null/undefined → `—`. Chips must use `bg-<c>-500/10 text-<c>-700`.
- [ ] **Step 3:** Add a `SummaryCard` tile: **"On latest"** = count of `current` / total active staff, with the target version as its subtitle.
- [ ] **Step 4: Fix the pre-existing contrast bug** — `StatusPill` amber uses `text-amber-200` (line ~256); change to the `bg-amber-500/10 text-amber-700` house recipe (and check the red/green siblings while there).
- [ ] **Step 5:** `npm run check:guardrails && npm run lint` clean. **Commit** `STAFF-DEV.4 — app version + location permission on the device health page`

---

### Task 5: Staff-list Device cell

**Files:** Modify `src/app/settings/staff/page.js`, `src/components/settings/StaffSearchableList.jsx`

- [ ] **Step 1:** In the page's server load, add a parallel `db.from('device_tokens').select('id, user_id, app_version, last_seen_at, geofence_permission')` (the page currently does a single `profiles` select — make both run under one `Promise.all`). Compute `targetVersion` + a `verdictsById` map with the lib, pass both into `StaffSearchableList`.
- [ ] **Step 2:** Add a **Device** column between Locations and Status: version + relative last-seen (`2.1.0 · 2d`), an amber `Outdated` chip, or a neutral `No app` chip for `no_device`. **Bump the empty-state `colSpan={6}` → `7`.**
- [ ] **Step 3:** Add a `Needs update` option to the existing status pill group (`all | active | inactive | needs_update`), filtering to `outdated` + `no_device` in the same `useMemo`.
- [ ] **Step 4:** `npm run lint && npm run check:guardrails` clean. **Commit** `STAFF-DEV.5 — device column + needs-update filter on the staff list`

---

### Task 6: Per-staff Devices card

**Files:** Create `src/components/settings/StaffDevicesCard.jsx`; modify `src/components/StaffForm.jsx`

- [ ] **Step 1:** Build `StaffDevicesCard({ profileId })` — a client component that fetches `/api/staff-devices` on mount and renders only that profile's entry. (Fetching the whole fleet for one card is acceptable at this scale and avoids a second endpoint; note it in a comment.) Card shell copies the "Mobile App Features" card at `StaffForm.jsx:1052` (`bg-un1t-surface border border-un1t-border rounded-lg p-5`). Rows: device name · platform · version · relative last seen · location-permission chip; stale rows dimmed (`opacity-60`) with a `Stale` chip; the current device marked. Empty state: "No app installed — this staff member has never registered a device." Loading + error states inline, no throw.
- [ ] **Step 2:** Mount it in `StaffForm.jsx` next to the Mobile App Features card, gated `isEdit && staff?.id`.
- [ ] **Step 3:** `npm run lint && npm run check:guardrails` clean. **Commit** `STAFF-DEV.6 — per-staff Devices card`

---

### Task 7: Mobile — report permission + version without push consent

**Files:** Modify `mobile/lib/push-register.js`, `mobile/components/LocationGate.jsx`, `src/app/api/mobile/device-tokens/route.js`

JS-only → ships OTA on the 2.2.0 lane.

- [ ] **Step 1: Server first.** Extend `RegisterSchema` in the device-tokens route with `geofence_permission: z.enum(['always','when_in_use','denied','undetermined']).optional()`. In the upsert, only include the key when present (`...(body.geofence_permission ? { geofence_permission: body.geofence_permission, geofence_permission_at: new Date().toISOString() } : {})`) — **critical**, because an omitted key in an upsert would otherwise wipe the stored value (the same trap that already nulls `device_name`/`app_version` for old clients). Add route tests: permission persisted when sent; keys absent from the patch when omitted.
- [ ] **Step 2:** In `mobile/lib/push-register.js`, export a new `reportDeviceState({ geofencePermission })` that POSTs the same endpoint with the current `expo_push_token` when one exists. Keep `registerForPushNotifications()` behaviour, but have it include `geofence_permission` when the caller passes it.
- [ ] **Step 3:** In `mobile/components/LocationGate.jsx`'s `check` callback, after resolving `Location.getBackgroundPermissionsAsync()`, map status → `always` (granted) / `denied` (denied) / `when_in_use` (undetermined-background but foreground granted) / `undetermined`, and fire `reportDeviceState` when the value **changed** since last report (keep the last reported value in a ref; never report while impersonating or without a session, mirroring the component's existing early-outs). Fire-and-forget in its own try/catch — reporting must never block or break the gate.
- [ ] **Step 4:** `npm run check:mobile-imports && npm run check:mobile-parity` clean; route tests pass. **Commit** `STAFF-DEV.7 — mobile reports geofence permission state`

---

### Task 8: Nudge to update (TDD)

**Files:** Create `src/app/api/staff-devices/nudge/route.js` + `route.test.js`; modify `src/components/settings/StaffSearchableList.jsx` (or the health page — put the button wherever the fleet list lives; pick the health page and say so in the commit); modify `src/lib/openapi.js`

- [ ] **Step 1: Write failing tests.** Cases: 401; 403 for non-`settings`; sends only to profiles whose verdict is `outdated` (never `current`, never `no_device` — the latter have no token by definition); a profile whose current device has `last_update_nudge_at` inside 24h is **skipped** and counted; `last_update_nudge_at` is written for those actually sent; response shape `{ success, data: { sent, skipped_throttled, skipped_no_token } }`; a custom `message` overrides the default body; a `message` over 200 chars → 400.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `POST` with Zod `{ profile_ids: z.array(uuidLike).max(200), message: z.string().max(200).optional() }`. Gate `getCurrentUser` → `hasPermission(user,'settings')`. Recompute verdicts server-side from `device_tokens` — **never trust the client's list of who is outdated**; intersect the requested ids with the genuinely-outdated set. Throttle: skip any whose current device has `last_update_nudge_at > now - 24h`. Send via `sendPush(userIds, { title: 'App update available', body: message || 'Please update Repset from the App Store — your version is out of date.', category: 'app_update', data: { type: 'app_update' } })` from `@/lib/push`. Then `await` an update setting `last_update_nudge_at = now()` on the sent devices' rows. Each step in `try/catch`; a push failure must not 500 the response (report it in the counts).
- [ ] **Step 4:** tests PASS; `check:route-guards` clean.
- [ ] **Step 5: UI** — a `type="button"` "Nudge to update" button on the health page's fleet table header. Confirm modal (reuse `@/components/ui` `Modal`) listing recipient names, a textarea prefilled with the default message, Cancel + Send. On success show `sent / skipped` counts inline.
- [ ] **Step 6:** Register in `openapi.js`. **Commit** `STAFF-DEV.8 — nudge outdated staff to update`

---

### Task 9: Docs + full CI

- [ ] **Step 1:** New `docs/staff-devices.md`: what each surface answers, the verdict definitions (with the "newest device wins, not best version" rule), why null permission ≠ denied, the 24h nudge throttle, and the 90-day sweep interaction (`sweep-stale-push-tokens`) so a future reader knows why old devices vanish.
- [ ] **Step 2:** `docs/CHANGELOG.md` — next-numbered entry, `PR TBD`.
- [ ] **Step 3:** Full CI mirror: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`.
- [ ] **Step 4:** `npm run build`.
- [ ] **Step 5: Commit** `STAFF-DEV.9 — docs + changelog`

---

## Supervisor-only

1. Two-stage review per task (spec compliance, then quality); adversarial whole-branch audit at the end.
2. Apply mig 466 via Supabase MCP (project `iyvtbjjxdggiadzwwvdj`) → `get_advisors(security)`.
3. PR to main; report URL. Post-merge: mobile permission reporting rides the next OTA automatically.
