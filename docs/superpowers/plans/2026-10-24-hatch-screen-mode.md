# Hatch Screen Mode (CRM side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CRM decides, per Hatch floor screen, when the franchise app is in front and when marketing is, publishes that as a cached plan to each Android box, lets staff override a screen for an hour, and notices a dark screen.

**Architecture:** A fourth automation (`screen_mode`) on the existing `location_automations` row and class spine; a third `fleet_devices` role (`screen`) with heartbeat and override columns; one device-authenticated endpoint that computes the day's merged class windows on request (nothing fires server-side, no cron added); overrides as state on the device row rung through the existing Realtime doorbell; a screen pass in the fleet-health cron that grades on heartbeat alone. The Android agent (UN1T Screen) that consumes the plan is a **separate plan in its own repository** (`un1t-screen`), written after the bench test in the spec's §11 step 0; this plan ends with a CRM that a box can be pointed at.

**Tech Stack:** Next.js 16 App Router, Supabase (service role in routes, PGlite for migration tests), vitest, zod, existing fleet helpers (`src/lib/fleet-device-auth.js`, `src/lib/fleet-doorbell.js`, `src/lib/fleet-health.js`), existing climate planning helpers (`src/lib/class-climate.js`).

**Spec:** `docs/superpowers/specs/2026-10-24-hatch-screen-mode-design.md`

## Global Constraints

- Every `/api` route runs on the service role: the route is the gate. Device routes authenticate with `verifyFleetDeviceToken(request, db)` and refuse with a 404-shaped body on anything but a `screen` device. Admin detail routes return 404, never 403, for an unknown or foreign device.
- A device is never sent shell text. The only value the plan carries that the box acts on is `class_app_package`, validated against `PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/` (max 200 chars) at write time.
- Registering a screen, widening its role, linking its display and minting its token are **master-only** (`user.isMaster`), matching the existing fleet claim and token routes. Overriding a screen needs `fleet_restart` at the device's studio (or master). Configuring the automation needs `MANAGER_ROLES` at the studio through the existing `PUT /api/automations/[key]` gate.
- Spec values: `lead_in_min` 10, `lead_out_min` 5, `stale_plan_mode` `'class_app'`, `poll_seconds` 600, plan window now − 2 h to now + 36 h, a class with no `ends_at` lasts 60 min, override durations `[30, 60, 120, 240]` minutes, kiosk cast poll 60 000 ms (default stays 6 000), screen offline after `OFFLINE_AFTER_MS` (15 min), plan-endpoint rate limit 30 per minute per device name.
- Wall-clock config (`excluded_slots`) is matched in the studio's zone via `slotKey(startsAt, zone)` from `@/lib/class-climate`; zones come from `getLocationZone(db, locationId)` (`@/lib/location-time`), never a `'Europe/Dublin'` literal (`check:guardrails` bans it).
- Every supabase write destructures `error` and judges it; add each new file under `src/app/api/fleet/`, `src/app/api/admin/fleet/`, `src/lib/screen-*.js` and `src/lib/fleet-screen-health.js` to the `no-unchecked-supabase-write` path list in `eslint.guardrails.config.mjs`.
- A new column holding no secret needs no special name; the migration adds no credential. `fleet_devices` keeps its deny-all policies for `anon`/`authenticated`, so no grant is written.
- Logs carry ids and device names only, never a token or a cast URL (`logInfo`/`logWarn`/`logError` from `@/lib/log`).
- Migrations are forward-only, applied with the Supabase MCP `apply_migration` against `iyvtbjjxdggiadzwwvdj` BEFORE the code that reads the new columns deploys; run `get_advisors` (security) after.
- Run the CI mirror (CLAUDE.md "Build, test & ship") before pushing, and `npm run build` (new routes and a page change).
- Commit after every task with the house subject shape `SCREENMODE.<n> — <summary>`.

## Review Focus

1. A class with `ends_at` null must produce a 60-minute window, never a zero-length or open one (Task 2, "a class with no ends_at lasts 60 minutes").
2. Two classes 06:00–06:50 and 07:00–07:50 with lead-in 10 and lead-out 5 must be ONE window 05:50–07:55, not two with a 5-minute marketing flash between them (Task 2, "touching windows merge").
3. A kiosk's or bridge's device token presented to the plan endpoint must get the 404 shape and must NOT stamp a heartbeat (Task 6, "a non-screen device is refused and not stamped").
4. An override whose `override_until` has passed must not appear in the plan, and `modeAt` must fall back to the windows (Task 2 "a lapsed override is ignored"; Task 5 "a lapsed override is omitted").
5. A screen that has never reported must grade `ok` with detail `never reported`, not `unreachable`: six boxes registered on Monday and provisioned on Friday must not page a master all week (Task 10, "never reported is not an outage").

---

### Task 1: Migration 768 — the `screen` role and its columns

**Files:**
- Create: `supabase/migrations/768_fleet_screens.sql`
- Test: `tests/migration-768-fleet-screens.test.js`

**Interfaces:**
- Produces: `fleet_devices.role` CHECK `('kiosk','bridge','screen')`; new nullable columns `tv_display_id uuid REFERENCES public.tv_displays(id) ON DELETE SET NULL`, `last_heartbeat_at timestamptz`, `reported_mode text CHECK (reported_mode IN ('class_app','marketing','unknown'))`, `reported_version text`, `override_mode text CHECK (override_mode IN ('class_app','marketing'))`, `override_until timestamptz`; index `fleet_devices_screen_idx ON fleet_devices (location_id) WHERE role = 'screen'`.

- [ ] **Step 1: Write the failing test** (PGlite; template `tests/migration-760-un1t-trial-regrant.test.js`: create reduced `locations`, `tv_displays` (mig 160 columns `id, location_id, label, token, active`) and `fleet_devices` (mig 474 columns) in `beforeAll`, then run the real 768 file)

```js
it("role accepts 'screen' and still refuses a made-up role", async () => {
  await db.query(`INSERT INTO public.fleet_devices (device_name, location_id, role) VALUES ('hatch-screen1', '${LOC}', 'screen')`)
  await expect(db.query(`INSERT INTO public.fleet_devices (device_name, role) VALUES ('x', 'toaster')`)).rejects.toMatchObject({ code: '23514' })
})
it('a screen links to a display and the link clears when the display is deleted', async () => {
  await db.query(`UPDATE public.fleet_devices SET tv_display_id = '${TV}' WHERE device_name = 'hatch-screen1'`)
  await db.query(`DELETE FROM public.tv_displays WHERE id = '${TV}'`)
  const { rows } = await db.query(`SELECT tv_display_id FROM public.fleet_devices WHERE device_name = 'hatch-screen1'`)
  expect(rows[0].tv_display_id).toBeNull()
})
it('reported_mode and override_mode are CHECKed', async () => {
  await expect(db.query(`UPDATE public.fleet_devices SET reported_mode = 'off' WHERE device_name = 'hatch-screen1'`)).rejects.toMatchObject({ code: '23514' })
  await expect(db.query(`UPDATE public.fleet_devices SET override_mode = 'unknown' WHERE device_name = 'hatch-screen1'`)).rejects.toMatchObject({ code: '23514' })
})
it('the file is re-runnable', async () => { await db.exec(SQL) })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/migration-768-fleet-screens.test.js`
Expected: FAIL (file not found / CHECK still refuses `screen`).

- [ ] **Step 3: Write the migration.** One transaction, `SET lock_timeout = '5s'`, re-runnable (`DROP CONSTRAINT IF EXISTS fleet_devices_role_check` then `ADD CONSTRAINT`, `ADD COLUMN IF NOT EXISTS` ×6, `CREATE INDEX IF NOT EXISTS`), a `COMMENT` on each new column saying it is set only for `role = 'screen'`, and a closing `DO $$` self-check that reads `pg_constraint` for the three CHECKs. No grants (mig 474's deny-all policies stand).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/migration-768-fleet-screens.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/768_fleet_screens.sql tests/migration-768-fleet-screens.test.js
git commit -m "SCREENMODE.1 — mig 768: fleet_devices gains the screen role, display link, heartbeat and override columns"
```

---

### Task 2: `src/lib/screen-mode.js` — the pure planner

**Files:**
- Create: `src/lib/screen-mode.js`
- Test: `src/lib/screen-mode.test.js`

**Interfaces:**
- Consumes: `slotKey(startsAt, zone)`, `classMatchesFilter(occurrence, classFilter)` from `@/lib/class-climate`; `DEFAULT_TZ` from `@shared/zoned-time`.
- Produces (browser-safe, no DB):
  - `SCREEN_MODE_KEY = 'screen_mode'`
  - `SCREEN_MODES = Object.freeze(['class_app', 'marketing'])`, `REPORTED_MODES = Object.freeze(['class_app', 'marketing', 'unknown'])`
  - `OVERRIDE_MINUTES = Object.freeze([30, 60, 120, 240])`
  - `PACKAGE_NAME_RE` (Global Constraints), `PACKAGE_NAME_MAX = 200`
  - `PLAN_LOOKBACK_MS = 2 * 3_600_000`, `PLAN_LOOKAHEAD_MS = 36 * 3_600_000`, `PLAN_POLL_SECONDS = 600`, `DEFAULT_CLASS_MS = 3_600_000`
  - `DEFAULT_SCREEN_CONFIG = Object.freeze({ device_names: [], class_app_package: null, lead_in_min: 10, lead_out_min: 5, class_filter: [], excluded_slots: [], stale_plan_mode: 'class_app' })`
  - `resolveScreenConfig(config: unknown) -> typeof DEFAULT_SCREEN_CONFIG` (coerces the way `resolveConfig` in `class-climate.js` does: arrays filtered to strings, numbers clamped ≥ 0, `class_filter` lower-cased, `class_app_package` kept only if it matches `PACKAGE_NAME_RE`, `stale_plan_mode` kept only if in `SCREEN_MODES`)
  - `planScreenWindows({ occurrences, config, zone = DEFAULT_TZ }) -> Array<{ from: string, until: string, classes: Array<{ id: string, name: string|null, starts_at: string, ends_at: string }> }>` — ISO strings, sorted by `from`, overlapping or touching windows merged (`a.until >= b.from`), cancelled rows must already be excluded by the caller, each class id is the occurrence's `glofox_event_id`
  - `modeAt({ windows, override }, nowMs) -> 'class_app' | 'marketing'` — an override with `until > nowMs` wins; else `class_app` inside any window; else `marketing`

- [ ] **Step 1: Write the failing tests**

```js
const occ = (id, s, e, name = 'UN1T Strength') => ({ glofox_event_id: id, name, starts_at: s, ends_at: e })
const cfg = resolveScreenConfig({ class_app_package: 'com.franchise.app' })
it('a class with no ends_at lasts 60 minutes', () => {
  const [w] = planScreenWindows({ occurrences: [occ('un1t:1', '2026-10-27T06:00:00Z', null)], config: cfg })
  expect(w.from).toBe('2026-10-27T05:50:00.000Z'); expect(w.until).toBe('2026-10-27T07:05:00.000Z')
})
it('touching windows merge', () => {
  const ws = planScreenWindows({ occurrences: [occ('un1t:1', '2026-10-27T06:00:00Z', '2026-10-27T06:50:00Z'), occ('un1t:2', '2026-10-27T07:00:00Z', '2026-10-27T07:50:00Z')], config: cfg })
  expect(ws).toHaveLength(1); expect(ws[0].from).toBe('2026-10-27T05:50:00.000Z'); expect(ws[0].until).toBe('2026-10-27T07:55:00.000Z'); expect(ws[0].classes.map((c) => c.id)).toEqual(['un1t:1', 'un1t:2'])
})
it('a gap wider than lead-out plus lead-in stays two windows', () => { /* 06:00–06:50 and 07:30–08:20 → 2 windows */ })
it('class_filter and excluded_slots drop classes before merging', () => {
  const c = resolveScreenConfig({ class_filter: ['strength'], excluded_slots: ['Tue 06:00'] })
  // Tue 06:00 Dublin = 2026-10-27T06:00:00Z (GMT); the strength class at that slot is excluded, a 'Mobility' class never matched
})
it('resolveScreenConfig refuses a bad package name and a bad stale mode', () => {
  expect(resolveScreenConfig({ class_app_package: 'com.x; rm -rf /' }).class_app_package).toBeNull()
  expect(resolveScreenConfig({ class_app_package: 'com.franchise.app' }).class_app_package).toBe('com.franchise.app')
  expect(resolveScreenConfig({ stale_plan_mode: 'blank' }).stale_plan_mode).toBe('class_app')
  expect(resolveScreenConfig({ lead_in_min: -4 }).lead_in_min).toBe(0)
})
it('modeAt: override wins, a lapsed override is ignored, inside a window is class_app', () => {
  const windows = [{ from: '2026-10-27T05:50:00.000Z', until: '2026-10-27T07:55:00.000Z', classes: [] }]
  const T = Date.parse('2026-10-27T06:30:00Z')
  expect(modeAt({ windows, override: { mode: 'marketing', until: '2026-10-27T07:00:00Z' } }, T)).toBe('marketing')
  expect(modeAt({ windows, override: { mode: 'marketing', until: '2026-10-27T06:00:00Z' } }, T)).toBe('class_app')
  expect(modeAt({ windows, override: null }, Date.parse('2026-10-27T09:00:00Z'))).toBe('marketing')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/screen-mode.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module** with the signatures above. Merging: sort by `from`, fold left, extend `until` to the max and concatenate `classes`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/screen-mode.test.js src/lib/class-climate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/screen-mode.js src/lib/screen-mode.test.js
git commit -m "SCREENMODE.2 — pure planner: merged class windows, config coercion, modeAt"
```

---

### Task 3: Registry entry

**Files:**
- Modify: `src/lib/automations/registry.js` (the `AUTOMATIONS` array and `automationStatus`)
- Test: `src/lib/automations/registry.test.js`

**Interfaces:**
- Produces: `getAutomation('screen_mode')` → `{ key: 'screen_mode', label: 'Class screens', description: 'Show the class app on the floor screens during each class and marketing content the rest of the time.', supportsBackfill: false, reviewBase: '/automations' }`; `automationStatus('screen_mode', location, { connected })` → `{ available: connected === true, trialConfigured: false }` (same branch as the climate keys).

- [ ] **Step 1: Add the failing assertions** to the existing `describe('automations registry')`

```js
it('registers screen_mode and judges it on the connected answer', () => {
  expect(getAutomation('screen_mode')).toMatchObject({ label: 'Class screens', supportsBackfill: false })
  expect(automationStatus('screen_mode', null, { connected: true })).toEqual({ available: true, trialConfigured: false })
  expect(automationStatus('screen_mode', null, { connected: false })).toEqual({ available: false, trialConfigured: false })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/automations/registry.test.js` → FAIL.
- [ ] **Step 3: Add the entry and widen the `class_climate || bathroom_climate` branch to include `screen_mode`.**
- [ ] **Step 4: Run to verify pass**, then `npx vitest run src/app/\(marketing\)` to be sure the hub page's filter (which hides the climate keys from the generic toggle list) still renders; add `screen_mode` to that filter in `src/app/(marketing)/automations/page.js` so no generic toggle appears for it.
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.3 — registry: the Class screens automation"`

---

### Task 4: Config validation and the schedule preview for `screen_mode`

**Files:**
- Modify: `src/app/api/automations/[key]/route.js` (the `Schema` and the device check), `src/app/api/automations/[key]/schedule/route.js` (the key allowlist)
- Create: `src/lib/screen-doorbell.js`
- Test: `src/app/api/automations/[key]/route.test.js`, `src/app/api/automations/[key]/schedule/route.test.js`, `src/lib/screen-doorbell.test.js`

**Interfaces:**
- Consumes: `pingDevice(deviceName) -> Promise<boolean>` from `@/lib/fleet-doorbell`; `resolveScreenConfig`, `PACKAGE_NAME_RE`, `PACKAGE_NAME_MAX` from `@/lib/screen-mode`.
- Produces: `ringScreens(deviceNames: string[]) -> Promise<number>` (count of pings sent; never throws; sequential) and `ringScreensForDisplay(db, displayId: string) -> Promise<number>` (reads `fleet_devices` `device_name` where `tv_display_id = displayId` and `role = 'screen'`, then `ringScreens`; a read error logs a warning and returns 0) in `src/lib/screen-doorbell.js`.
- Route behaviour: when `key === 'screen_mode'`, the body's `config` is additionally validated: `device_names` (array of `string().min(1).max(100)`, max 50) must all be `fleet_devices` rows at `body.location_id` with `role = 'screen'` (else 400 `unknown_device`, no names echoed, mirroring the W0.12 AC check); `class_app_package`, when present, must match `PACKAGE_NAME_RE` and be ≤ `PACKAGE_NAME_MAX` (else 400 `bad_package_name`); the stored config is `resolveScreenConfig(body.config)` plus the validated `device_names`. After a successful upsert, `ringScreens(config.device_names)` runs inside its own `try/catch` (fire-and-forget, never fails the response). The schedule route accepts `key === 'screen_mode'` alongside the two climate keys.

- [ ] **Step 1: Write the failing route tests** (existing fixtures: `getCurrentUser` owner at `LOC`, `assertLocationAccess` → null; mock `@/lib/screen-doorbell` `ringScreens: vi.fn(async () => 1)`)

```js
it('screen_mode: refuses a device name that is not a screen at this studio', async () => {
  createServerClient.mockReturnValue({ from: (t) => t === 'fleet_devices' ? { select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [{ device_name: 'hatch-screen1' }], error: null }) }) }) }) } : {} })
  const res = await PUT(req({ location_id: LOC, enabled: true, config: { device_names: ['hatch-screen1', 'stillorgan-tv1'], class_app_package: 'com.franchise.app' } }), { params: Promise.resolve({ key: 'screen_mode' }) })
  expect(res.status).toBe(400); expect((await res.json()).error).toBe('unknown_device')
})
it('screen_mode: refuses a package name with shell characters', async () => { /* 'com.x; reboot' → 400 bad_package_name, no fleet_devices read */ })
it('screen_mode: stores the resolved config and rings the named screens', async () => {
  // upsert mock captures its argument; expect config.lead_in_min 10, class_filter lower-cased, and ringScreens called with ['hatch-screen1']
})
// schedule/route.test.js
it("answers for screen_mode the way it does for class_climate", async () => { /* GET …/screen_mode/schedule?location_id=LOC → 200 with classes[] */ })
it('still refuses an unsupported key', async () => { /* glofox_lead_provisioning → 400 */ })
// screen-doorbell.test.js (mock @/lib/fleet-doorbell pingDevice)
it('ringScreens pings each name and counts the ones that sent', ...)
it('ringScreensForDisplay reads screens linked to the display and never throws on a read error', ...)
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run 'src/app/api/automations' src/lib/screen-doorbell.test.js` → FAIL.
- [ ] **Step 3: Implement.** In the PUT route, branch on `key === 'screen_mode'` after `validateBody`; the generic `device_ids` AC check stays for the climate keys.
- [ ] **Step 4: Run to verify pass**, then `npm run check:location-scoping` and `npm run check:route-guards` (both must stay green; the new read is scoped `.eq('location_id', body.location_id)`).
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.4 — screen_mode config validation, schedule preview, screen doorbell"`

---

### Task 5: `src/lib/screen-plan.js` — building a device's plan

**Files:**
- Create: `src/lib/screen-plan.js`
- Test: `src/lib/screen-plan.test.js`

**Interfaces:**
- Consumes: `planScreenWindows`, `modeAt`, `resolveScreenConfig`, `PLAN_LOOKBACK_MS`, `PLAN_LOOKAHEAD_MS`, `PLAN_POLL_SECONDS` from `@/lib/screen-mode`; `getLocationZone`, `LocationZoneReadError` from `@/lib/location-time`; `getAppUrl` from `@/lib/app-url`.
- Produces:
  - `SCREEN_DEVICE_COLUMNS = 'device_name, role, location_id, tv_display_id, override_mode, override_until'`
  - `buildScreenPlan(db, device, { nowMs = Date.now() } = {}) -> Promise<ScreenPlan>` where `device` has the columns above and `ScreenPlan = { ok: true, server_now, generated_at, timezone, poll_seconds, class_app_package, cast_url, stale_plan_mode, override: { mode, until } | null, windows, degraded?: 'zone_unreadable' | 'automation_unreadable' | 'occurrences_unreadable' }`
  - `expectedModesFor(db, devices, { nowMs }) -> Promise<Map<string, 'class_app'|'marketing'|null>>` for the fleet page: one `location_automations` + `class_occurrences` read per distinct `location_id`, `null` for a device at a studio with the automation disabled or absent.

Rules: the automation row is read `.eq('location_id', device.location_id).eq('automation_key', 'screen_mode')`; disabled, absent, or the device not in `device_names` → `windows: []`, `class_app_package` still echoed (null if absent). Occurrences: `.eq('location_id', …).is('cancelled_at', null).gte('starts_at', now − PLAN_LOOKBACK_MS).lte('starts_at', now + PLAN_LOOKAHEAD_MS).order('starts_at')`, select `glofox_event_id, name, starts_at, ends_at`. The display: `tv_displays` select `id, token, active, location_id` `.eq('id', device.tv_display_id).eq('location_id', device.location_id)`; `cast_url = \`${getAppUrl()}/tv/cast/${token}?kiosk=1\`` only when found and active, else `null`. Override returned only while `Date.parse(override_until) > nowMs`. A `LocationZoneReadError` → `timezone: null`, `windows: []`, `degraded: 'zone_unreadable'` (never a guessed zone, never a throw); a failed automation or occurrences read → the matching `degraded` value with `windows: []`.

- [ ] **Step 1: Write the failing tests** (fake db in the `makeFakeDb((call) => …)` style from `src/lib/tv-admin.test-helpers.js`, keyed on `call.table`)

```js
it('builds merged windows, the cast URL and the poll cadence', async () => {
  const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
  expect(plan.poll_seconds).toBe(600); expect(plan.cast_url).toBe('https://crm.test/tv/cast/tok-1?kiosk=1'); expect(plan.windows).toHaveLength(1); expect(plan.timezone).toBe('Europe/Dublin')
})
it('a device not in device_names gets no windows but still the package name', ...)
it('a display at another studio or inactive yields cast_url null', ...)
it('a lapsed override is omitted; a live one is returned', ...)
it('an unreadable zone degrades instead of guessing', async () => {
  getLocationZone.mockRejectedValue(new LocationZoneReadError('x'))
  const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
  expect(plan.degraded).toBe('zone_unreadable'); expect(plan.windows).toEqual([]); expect(plan.timezone).toBeNull()
})
it('expectedModesFor answers per device from one read per studio', ...)
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/screen-plan.test.js` → FAIL.
- [ ] **Step 3: Implement** with the rules above. `server_now` and `generated_at` are both `new Date(nowMs).toISOString()`.
- [ ] **Step 4: Run to verify pass**, then `npm run check:select-columns` (the six new columns resolve from mig 768).
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.5 — buildScreenPlan and expectedModesFor"`

---

### Task 6: `GET /api/fleet/screen-plan` — the device endpoint

**Files:**
- Create: `src/app/api/fleet/screen-plan/route.js`
- Test: `src/app/api/fleet/screen-plan/route.test.js`

**Interfaces:**
- Consumes: `verifyFleetDeviceToken(request, db)`; `buildScreenPlan`, `SCREEN_DEVICE_COLUMNS` from `@/lib/screen-plan`; `REPORTED_MODES` from `@/lib/screen-mode`; `checkRateLimit(db, key, { max: 30, windowMs: 60_000 })`, `rateLimitResponse` from `@/lib/rate-limit`.
- Produces: `GET /api/fleet/screen-plan?mode=<class_app|marketing|unknown>&version=<≤40 chars>` with `Authorization: Bearer fdv_…` → 200 `ScreenPlan`; 401 `{ ok:false, error:'Unauthorised' }` on no/unknown token; 404 `{ ok:false, error:'Not found' }` when the device's role is not `screen` (nothing stamped); 429 from the limiter (fails open on a limiter error, as the public TV routes do).

Order inside the handler: auth → rate limit (key `screen-plan:<device_name>`) → role check → read the device row with `SCREEN_DEVICE_COLUMNS` by `device_name` → stamp `{ last_heartbeat_at: now, reported_mode: mode if in REPORTED_MODES else 'unknown', reported_version: version || null, updated_at: now }` (a failed stamp is logged with `logWarn`, the plan is still returned) → `buildScreenPlan`.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/fleet-device-auth` `verifyFleetDeviceToken`, `@/lib/screen-plan` `buildScreenPlan`, `@/lib/rate-limit` `checkRateLimit: async () => ({ allowed: true })`; fake db records the `fleet_devices` update)

```js
it('401 with no device', ...)
it('a non-screen device is refused and not stamped', async () => {
  verifyFleetDeviceToken.mockResolvedValue({ device_name: 'stillorgan-tv1', role: 'kiosk', location_id: LOC })
  const res = await GET(new Request('http://t/api/fleet/screen-plan?mode=marketing'))
  expect(res.status).toBe(404); expect(writesOf(db)).toHaveLength(0); expect(buildScreenPlan).not.toHaveBeenCalled()
})
it('stamps the heartbeat, mode and version, then returns the plan', async () => {
  // expect update payload { reported_mode: 'class_app', reported_version: '1.0.3' } and body.poll_seconds 600
})
it("an unlisted mode is stored as 'unknown'", ...)
it('429 when the limiter says no', ...)
```

- [ ] **Step 2: Run to verify failure** — FAIL, module not found.
- [ ] **Step 3: Implement** (`export const runtime = 'nodejs'`, `export const dynamic = 'force-dynamic'`).
- [ ] **Step 4: Run to verify pass**, then `npm run check:route-guards` (the `verifyFleetDeviceToken(` pattern is recognised) and `npm run check:location-scoping`.
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.6 — GET /api/fleet/screen-plan: heartbeat and plan for a screen"`

---

### Task 7: Registering a screen — create route and the widened claim route

**Files:**
- Create: `src/app/api/admin/fleet/devices/route.js`
- Modify: `src/app/api/admin/fleet/devices/[name]/route.js` (`ClaimSchema`, the update payload)
- Test: `src/app/api/admin/fleet/devices/route.test.js`, `src/app/api/admin/fleet/devices/[name]/route.test.js` (new; the route had none), `src/lib/fleet-commands.test.js` (one added case)

**Interfaces:**
- Produces:
  - `POST /api/admin/fleet/devices` body `{ device_name: /^[a-z0-9][a-z0-9-]{1,62}$/, location_id: uuidLike, role: z.enum(['screen']), label?: string ≤ 80, tv_display_id?: uuidLike | null }` → 201 `{ ok, device: { device_name, location_id, role, label, tv_display_id } }`; 401; 403 `Master only`; 400 `display_not_at_location` when the display is missing, inactive or at another studio; 409 `{ ok:false, error:'exists' }` on `23505`.
  - `PATCH …/devices/[name]`: `role: z.enum(['kiosk','bridge','screen'])`, optional `tv_display_id: uuidLike.nullable()` with the same display check; the response adds `tv_display_id`.
  - `assertDisplayAtLocation(db, displayId, locationId) -> Promise<{ ok: true } | { ok: false }>` in `src/lib/screen-plan.js` (one `tv_displays` read `.eq('id', …).eq('location_id', …).eq('active', true)`), shared by both routes.

Role `kiosk`/`bridge` on POST is deliberately refused (Pis arrive through discovery; a hand-made Pi row would never be health-graded).

- [ ] **Step 1: Write the failing tests** (mock `@/lib/auth` `getCurrentUser`; fake db)

```js
it('403 for a non-master owner', ...)
it('refuses a Pi role on create', async () => { /* role 'kiosk' → 400 */ })
it('refuses a display at another studio', async () => { /* tv_displays read returns null → 400 display_not_at_location, no insert */ })
it('creates a screen and returns 201', async () => { /* insert payload has role 'screen', tv_display_id */ })
it('409 when the name exists', async () => { /* insert error { code: '23505' } */ })
// [name]/route.test.js
it('claims a discovered device as a screen with a display', ...)
it('still claims a kiosk with no display', ...)
// src/lib/fleet-commands.test.js — pin the spec's "no Pi action applies to a screen"
it('no fleet action applies to a screen', () => {
  for (const action of ACTION_NAMES) expect(actionAppliesToRole(action, 'screen')).toBe(false)
  expect(availableActions('screen', () => true)).toEqual([])
})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Mirror the PATCH route's shape (`getCurrentUser` → `isMaster` → `validateBody` → `createServerClient` → work → `{ ok, device }`), `logInfo('fleet-cmd', 'screen registered', { device, by: user.id })`.
- [ ] **Step 4: Run to verify pass**, then `npm run check:route-guards` and `npm run check:location-scoping`.
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.7 — register a screen; claim route accepts the screen role and a display link"`

---

### Task 8: The override route

**Files:**
- Create: `src/app/api/admin/fleet/devices/[name]/screen-override/route.js`
- Test: `src/app/api/admin/fleet/devices/[name]/screen-override/route.test.js`

**Interfaces:**
- Consumes: `hasPermissionForLocation(user, locationId, 'fleet_restart')` from `@/lib/permissions`; `SCREEN_MODES`, `OVERRIDE_MINUTES` from `@/lib/screen-mode`; `ringScreens` from `@/lib/screen-doorbell`.
- Produces: `POST …/devices/[name]/screen-override` body `z.union([ z.object({ mode: z.enum(SCREEN_MODES), minutes: z.union(OVERRIDE_MINUTES.map(z.literal)) }), z.object({ clear: z.literal(true) }) ])` → 200 `{ ok, override: { mode, until } | null }`. 401 no session; 404 when the device is missing, has no `location_id`, or `role !== 'screen'`; 403 when the caller is neither master nor holds `fleet_restart` at the device's studio. Writes `override_mode`/`override_until` (`now + minutes`, or both null on clear) and `updated_at`; then `ringScreens([name])` in its own `try/catch`.

- [ ] **Step 1: Write the failing tests**

```js
it('404 for a kiosk, with the same body as an unknown name', ...)
it('403 for a staffer without fleet_restart at that studio', ...)
it('sets a 60-minute override and rings the device', async () => {
  // update payload override_mode 'class_app', override_until = NOW + 60 min (fake Date.now via vi.setSystemTime inside the test, no timers), ringScreens called with ['hatch-screen1']
})
it('clear nulls both columns', ...)
it('refuses minutes outside the list', async () => { /* 45 → 400 */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, `npm run check:route-guards`.
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.8 — screen override as device state, rung through the doorbell"`

---

### Task 9: The cast page in kiosk mode, and content pushes that ring the screens

**Files:**
- Create: `src/lib/tv-cast-poll.js`, `src/lib/tv-cast-poll.test.js`
- Modify: `src/app/tv/cast/[token]/page.js` (read `searchParams.kiosk`, pass `kiosk` to `TVDisplay`; fix the "every 3s" comment), `src/app/tv/cast/[token]/TVDisplay.jsx` (`castPollMs(kiosk)` replaces `POLL_MS`), `src/app/api/admin/tv-displays/[id]/content/route.js` (ring after PUT and DELETE)
- Test: `src/app/api/admin/tv-displays/[id]/content/route.test.js` (add two cases)

**Interfaces:**
- Produces: `CAST_POLL_MS = 6000`, `CAST_KIOSK_POLL_MS = 60_000`, `isKioskParam(value: unknown) -> boolean` (true only for the string `'1'`), `castPollMs(kiosk: boolean) -> number`.
- Consumes: `ringScreensForDisplay(db, display.id)` from `@/lib/screen-doorbell`, called after a successful upsert (PUT) and a successful delete (DELETE), inside its own `try/catch`; the response is unchanged either way.

- [ ] **Step 1: Write the failing tests**

```js
// tv-cast-poll.test.js
it('kiosk slows the poll to 60 s and anything else keeps 6 s', () => {
  expect(castPollMs(true)).toBe(60_000); expect(castPollMs(false)).toBe(6000)
  expect(isKioskParam('1')).toBe(true); expect(isKioskParam('true')).toBe(false); expect(isKioskParam(undefined)).toBe(false)
})
// content/route.test.js (mock @/lib/screen-doorbell)
it('a push rings the screens linked to the display', async () => { /* PUT ok → ringScreensForDisplay called with (db, TV_ID) */ })
it('a ring failure never fails the push', async () => { /* ringScreensForDisplay rejects → PUT still 200 */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** In `page.js`: `const { kiosk } = await props.searchParams` → `kiosk={isKioskParam(kiosk)}`. In `TVDisplay.jsx`: `const pollMs = castPollMs(Boolean(kiosk))` and `setInterval(tick, pollMs)` with `kiosk` in the effect's dependency list.
- [ ] **Step 4: Run to verify pass**: `npx vitest run src/lib/tv-cast-poll.test.js 'src/app/api/admin/tv-displays'`, then `npm run build` (a page's props changed).
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.9 — cast page kiosk poll, content pushes ring the linked screens"`

---

### Task 10: Fleet health — the screen pass

**Files:**
- Modify: `src/lib/fleet-health.js` (add `gradeScreen`), `src/lib/fleet-health.test.js`
- Create: `src/lib/fleet-screen-health.js`, `src/lib/fleet-screen-health.test.js`
- Modify: `src/app/api/cron/fleet-health/route.js` (call the pass first; carry its counts into both `stampHeartbeat` calls)
- Create: `src/app/api/cron/fleet-health/route.test.js`

**Interfaces:**
- Produces in `fleet-health.js`: `SCREEN_OFFLINE_AFTER_MS = OFFLINE_AFTER_MS`; `gradeScreen(fleetRow: { device_name, last_heartbeat_at }, nowMs) -> { name, state: 'ok'|'unreachable', detail, since, connected }` — `last_heartbeat_at` null → `{ state: 'ok', detail: 'never reported', connected: false }`; age < 15 min → `{ state: 'ok', detail: '', connected: true }`; age ≥ 15 min → `{ state: 'unreachable', detail: 'no heartbeat for N min', since: last_heartbeat_at, connected: false }`.
- Produces in `fleet-screen-health.js`: `runScreenHealth(db, { nowMs, notify }) -> Promise<{ checked: number, alerted: number }>` where `notify(db, alerts) -> Promise<boolean>` is the cron's own function passed in. It reads `fleet_devices` `device_name, last_heartbeat_at, location_id` where `role = 'screen'` and `location_id is not null`; reads `fleet_device_health` priors `.in('device_name', names)`; grades with `gradeScreen`, decides with `decideAlert(graded, prior, nowMs)`; if any alerts, calls `notify` and on a `false` or thrown result rolls `alerted_at` back exactly as the cron does (recovered → the prior stamp, down → null); upserts the rows `onConflict: 'device_name'`; never throws (a read error logs `logError('fleet-health', 'screen pass skipped', …)` and returns `{ checked: 0, alerted: 0 }`).
- Cron: after the `CRON_SECRET` check, `const db = createServerClient(); const now = Date.now(); const screens = await runScreenHealth(db, { nowMs: now, notify })` runs BEFORE `tailscaleConfigured()` is consulted; the unconfigured early return stamps `{ configured: false, screens_checked, screens_alerted }` and returns them; the final stamp and response carry the same two fields.

- [ ] **Step 1: Write the failing tests**

```js
// fleet-health.test.js
it('never reported is not an outage', () => {
  expect(gradeScreen({ device_name: 'hatch-screen1', last_heartbeat_at: null }, NOW)).toMatchObject({ state: 'ok', detail: 'never reported', connected: false })
})
it('a 20-minute silence grades unreachable; 10 minutes grades ok', () => {
  expect(gradeScreen({ device_name: 'hatch-screen1', last_heartbeat_at: ago(20 * 60_000) }, NOW).state).toBe('unreachable')
  expect(gradeScreen({ device_name: 'hatch-screen1', last_heartbeat_at: ago(10 * 60_000) }, NOW)).toMatchObject({ state: 'ok', connected: true })
})
// fleet-screen-health.test.js (fake db; notify = vi.fn(async () => true))
it('grades every claimed screen, alerts once on a new outage and persists rows', ...)
it('a failed notify rolls alerted_at back so the next tick alerts again', ...)
it('a read error skips the pass without throwing', ...)
// cron route.test.js (mock @/lib/tailscale-api tailscaleConfigured: () => false, @/lib/fleet-screen-health runScreenHealth, @/lib/cron-heartbeat stampHeartbeat)
it('runs the screen pass even when Tailscale is unconfigured and reports its counts', async () => {
  runScreenHealth.mockResolvedValue({ checked: 6, alerted: 1 })
  const res = await GET(new Request('http://t/api/cron/fleet-health', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))
  expect(runScreenHealth).toHaveBeenCalled(); expect((await res.json()).data).toMatchObject({ configured: false, screens_checked: 6, screens_alerted: 1 })
  expect(stampHeartbeat).toHaveBeenCalledWith('fleet-health', expect.objectContaining({ screens_checked: 6 }))
})
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** The Tailscale pass is otherwise untouched: screens never appear in `names`, so the auto-register upsert cannot touch them.
- [ ] **Step 4: Run to verify pass**: `npx vitest run src/lib/fleet-health.test.js src/lib/fleet-screen-health.test.js 'src/app/api/cron/fleet-health'`.
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.10 — fleet-health grades screens on their heartbeat, independent of Tailscale"`

---

### Task 11: The fleet page — screens section, register form, override buttons

**Files:**
- Modify: `src/app/admin/fleet/page.js` (select the new columns; `expectedModesFor`; master-only lists of locations and displays), `src/app/admin/fleet/FleetAdmin.jsx` (a `ScreensSection`)
- Create: `src/app/admin/fleet/ScreensSection.jsx`, `src/app/admin/fleet/ScreensSection.test.jsx`

**Interfaces:**
- Consumes: `expectedModesFor(db, devices, { nowMs })` (Task 5); routes from Tasks 7 and 8; the existing token button in `FleetAdmin.jsx`.
- Produces: page rows for screens gain `lastHeartbeatAt, reportedMode, reportedVersion, expectedMode, override: { mode, until } | null, displayLabel, canOverride` (`can('fleet_restart')`); `FleetAdmin` receives `screens` (those rows), `locations` (`[{ id, name }]`, masters only, else `[]`) and `displays` (`[{ id, label, location_id }]`, masters only) and renders `<ScreensSection screens locations displays isMaster onChanged />` above the Pi list.
- `ScreensSection` props `{ screens, locations, displays, isMaster, onChanged }`: a table (device, where it hangs, display, last seen via `timeAgo`, "Showing" chip from `reportedMode`, "Should show" from `expectedMode`, amber row note `showing marketing during a class` when `reportedMode === 'marketing' && expectedMode === 'class_app'`, override in force with its `until`); per row, when `canOverride`: **Show class app for 1 h** (`{ mode:'class_app', minutes:60 }`), **Show marketing for 1 h**, **Back to schedule** (`{ clear:true }`), each `fetch` to the Task 8 route then `onChanged()`; when `isMaster`, a **Register screen** form (`Field`s: device name, label, location `<select>`, display `<select>` filtered to the chosen location) posting to the Task 7 route. House primitives (`Button`, `Card`, `Field`, `EmptyState` from `@/components/ui`), light-theme chip recipe `bg-<c>-500/10 text-<c>-700`, every non-submit `<button type="button">`.

- [ ] **Step 1: Write the failing component test** (RTL; `vi.stubGlobal('fetch', vi.fn(...))`; no fake timers)

```jsx
it('renders a screen with its modes and flags a mismatch', () => {
  render(<ScreensSection screens={[row({ reportedMode: 'marketing', expectedMode: 'class_app' })]} locations={[]} displays={[]} isMaster={false} onChanged={() => {}} />)
  expect(screen.getByText(/showing marketing during a class/i)).toBeInTheDocument()
})
it('override buttons appear only with canOverride and post the body', async () => {
  // click "Show class app for 1 h" → fetch('/api/admin/fleet/devices/hatch-screen1/screen-override', { method:'POST', body: JSON.stringify({ mode:'class_app', minutes:60 }) … }) and onChanged called
})
it('the register form is master-only and filters displays by the chosen location', ...)
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the component, then wire `page.js` (`.select('device_name, location_id, role, label, api_token_hash, last_render_at, tv_display_id, last_heartbeat_at, reported_mode, reported_version, override_mode, override_until, locations(name), tv_displays(label)')`) and `FleetAdmin.jsx` (`onChanged = () => router.refresh()`).
- [ ] **Step 4: Run to verify pass**: `npx vitest run 'src/app/admin/fleet'`, `npm run check:guardrails`, `npm run build`.
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.11 — fleet page: screens with heartbeat, modes, overrides and registration"`

---

### Task 12: The hub card

**Files:**
- Create: `src/components/automations/ScreenModeCard.jsx`, `src/components/automations/ScreenModeCard.test.jsx`
- Modify: `src/app/(marketing)/automations/page.js` (read screens, displays-free; read `hasTimetable`; render the card OUTSIDE `MembershipSourceGate`)

**Interfaces:**
- Consumes: `PUT /api/automations/screen_mode` (Task 4), `GET /api/automations/screen_mode/schedule?location_id=` (Task 4), `planScreenWindows`, `resolveScreenConfig`, `DEFAULT_SCREEN_CONFIG`, `PACKAGE_NAME_RE` from `@/lib/screen-mode`; `slotKey` from `@/lib/class-climate`; `fmtClassTime` from `./ClassClimateCard`.
- Produces: `ScreenModeCard({ locationId, timezone, screens: [{ device_name, label }], hasTimetable: boolean, initialEnabled, initialConfig })`. Page reads: `fleet_devices` `.select('device_name, label').eq('location_id', loc).eq('role', 'screen').order('device_name')`; `hasTimetable` = one `class_occurrences` row `.eq('location_id', loc).is('cancelled_at', null).gte('starts_at', nowIso).limit(1)` exists; the `screen_mode` row from the existing `byKey`. The page renders the card only when `canCurated && screens.length > 0`, in its own `<div>` after the gated block.

Card behaviour: toggle (disabled with a title until `hasTimetable && class_app_package matches PACKAGE_NAME_RE && device_names.length > 0`); checklist of screens; package-name `Field` with inline validity; lead-in / lead-out numbers; class filter text; "Today's plan": fetch the schedule, compute `planScreenWindows({ occurrences: classes, config, zone: timezone })` client-side and list each window as `from → until` with its class names, each class clickable to toggle its `slotKey` into `excluded_slots` (the climate card's pattern); when `!hasTimetable`, the copy "No class timetable is being synced for this studio." replaces the plan. Save = `PUT` with `{ location_id, enabled, config }`.

- [ ] **Step 1: Write the failing component test**

```jsx
it('cannot be enabled without a valid package name', () => { /* toggle disabled; type 'com.franchise.app' and tick one screen → enabled */ })
it('shows merged windows from the schedule', async () => { /* fetch returns two touching classes → one window row, "UN1T Strength, UN1T Conditioning" */ })
it('says so when no timetable is synced', () => { ... })
it('saves the config shape the route expects', async () => { /* PUT body.config has device_names, class_app_package, lead_in_min, lead_out_min, class_filter, excluded_slots */ })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the card and the page wiring.
- [ ] **Step 4: Run to verify pass**: `npx vitest run src/components/automations 'src/app/(marketing)'`, `npm run check:guardrails`, `npm run check:select-columns`, `npm run build`.
- [ ] **Step 5: Commit** — `git commit -am "SCREENMODE.12 — Class screens card on the automations hub"`

---

### Task 13: Operator doc, changelog, CI mirror

**Files:**
- Create: `docs/fleet-screens.md`
- Create after `gh pr create`: `docs/changelog/entries/<PR>.md`
- Modify: `eslint.guardrails.config.mjs` (arm `no-unchecked-supabase-write` on the new paths, if not done per task)

- [ ] **Step 1: Write `docs/fleet-screens.md`** (CRM side only; the box's own provisioning lives with the agent repo): register a screen on `/admin/fleet` (name convention `hatch-screenN`, label where it hangs, link to the "Hatch screens" display), mint its token (shown once; it goes into the box at provisioning, never into chat or a file in this repo), enable **Class screens** on `/automations` at Hatch with the package name and the screens ticked, what the fleet page's chips mean, what an override does and how long it lasts, what alerts fire and to whom (masters), and the two latency numbers (content push: seconds via the doorbell; a class added in un1t.online: up to ~25 min).
- [ ] **Step 2: Run the full CI mirror** from CLAUDE.md "Build, test & ship" plus `npm run build`. Expected: all green.
- [ ] **Step 3: Apply mig 768 to prod** with the Supabase MCP `apply_migration` (project `iyvtbjjxdggiadzwwvdj`), then `get_advisors` type `security`. Expected: no new ERROR-level finding.
- [ ] **Step 4: Push, open the PR** (`gh pr create --base main --fill`), add `docs/changelog/entries/<PR>.md` with one row `| #<PR> | SCREENMODE.1 — Hatch floor screens: class app during class, marketing otherwise (mig 768) | 2026-10-… . … |`, commit and push.

---

## What this plan does not include

- **The Android agent (UN1T Screen).** Its own plan in the `un1t-screen` repository, written once the bench test (spec §11 step 0) confirms the franchise app survives backgrounding. It consumes exactly: `GET /api/fleet/screen-plan` (Task 6), the Realtime channel `fleet:<device_name>` (existing), and the cast page with `?kiosk=1` (Task 9).
- **Ringing the doorbell from the un1t.online sync** when a studio's occurrences change (spec §4, optional). A follow-up once the poll cadence has been observed.
- **Alerting on a mode mismatch** (spec §7, shown in amber on the fleet page only).
