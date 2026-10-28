# Shelly Groups, Lights and Class Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt and switch Shelly LED controllers, group devices under one switch with a shared schedule (fixed hours or per-class windows), preview a day's schedule, and redesign the web and phone Shelly screens to the approved mockups.

**Architecture:** Lights become a second device `kind` handled by the existing normaliser, client, reconcile and toggle paths (`set/light` with `on` only). Groups are a new per-location table. Each tick, a pure resolver turns (device, its group) into the "effective target" the existing exactly-once planner already understands. Class mode's single first-to-last window is replaced by per-class windows joined across short gaps, in the shared engine. The preview reuses that engine through a read-only route.

**Tech Stack:** Next.js 16 App Router routes (`withAuth`), Supabase (service role, forward-only SQL migrations), zod, vitest, React (web) and Expo/React Native (`mobile/`).

**Spec:** `docs/superpowers/specs/2026-10-26-shelly-groups-lights-design.md`. Read it with v1's `docs/superpowers/specs/2026-08-22-shelly-device-control-design.md`.

## Global Constraints

- A light is switched with `set/light` carrying **`on` only**: never `brightness`, `mode`, colour or `temperature`.
- No route accepts a `location_id`; every handler uses `withAuth({ permission: 'device_control' })` and the caller's active location; foreign or malformed ids answer **404**.
- A device belongs to **at most one group**, and only a group at its own location (database-enforced).
- Pressing a group's switch, or its "back to schedule", **clears every member's device override first** (group wins).
- Joining a group clears the device's own schedule (`schedule_mode='none'`, `fixed_windows='[]'`, `class_rule='{}'`). Leaving a group or deleting it switches nothing.
- `class_rule` = `{ lead_min, lag_min, merge_gap_min, days }`; defaults **15 / 10 / 30 / [1..7]**; lead/lag/merge each `0..180`.
- Two class windows join when `next.on_at − prev.off_at <= merge_gap_min` minutes.
- New tables and columns: closed to `anon`/`authenticated` (`REVOKE ALL … FROM anon, authenticated`); phone and web read through `/api`. Migrations are forward-only, applied via Supabase MCP to project `iyvtbjjxdggiadzwwvdj` **before** the code that reads them deploys; run `get_advisors` (security) after. Check the next free migration number after syncing main (775 was free on 2026-10-26).
- Name columns on every select that reaches a client (`DEVICE_COLUMNS`, and a new `GROUP_COLUMNS`).
- `set/groups` batches per direction (one `on` call, one `off` call per location per tick), switch and light entries together.
- Every PR runs the CI mirror from `CLAUDE.md` (13 commands) plus `npm run build` when it adds a route or import, adds `docs/changelog/entries/<PR>.md`, and registers routes in `src/lib/openapi.js`.
- Copy is sentence case, no "please", no "!" (CDS content rules in the repo's UI).
- The phone PR (Task 13–14) is last: merging anything under `mobile/` publishes an OTA to every phone.

## Review Focus

1. **Group with no members** toggled or scheduled: answers success with nothing sent and makes no cloud call (pinned in Task 9).
2. **One member offline during a group press:** the response is `partial` and names that member; the others are stamped. The phone shows amber "1 of 2 on" (pinned in Tasks 8 and 13).
3. **A class on a weekday not in `days`:** produces no window that day, while the other days still do (pinned in Task 5).
4. **Gap exactly equal to `merge_gap_min`:** joins; one minute more does not. Overlapping and touching class windows join into one (pinned in Task 5).
5. **A group deleted while its override is live:** members keep their physical state; the next tick sends nothing for them (pinned in Task 7).

---

## PR 1 — Lights backend (then the live gate)

### Task 1: Normalise light components

**Files:**
- Modify: `src/lib/shelly/status.js` (`switchChannels`, `supportFor`, `normaliseGetItem`, `normaliseAllStatus`, `stateFromReading`, `groupId`)
- Test: `src/lib/shelly/status.test.js`

**Interfaces:**
- Produces: every channel/reading entry gains `kind: 'switch' | 'light'` and `brightness: number|null` (always null for a switch). `normaliseAllStatus` rows gain `kind`. `supportFor` returns `{supported:true}` when there is a switch **or** a light. `stateFromReading(prev, reading, channel, atIso, kind = 'switch')` matches on channel **and** kind and adds `brightness` to `last_state`. `groupId(d)` is unchanged (`<device_id>_<channel>`).

- [ ] **Step 1: Write the failing tests**

```js
it('reads light:N components as lights with brightness', () => {
  const r = normaliseGetItem({ id: 'abc', gen: 2, online: 1, status: {
    'light:0': { output: true, brightness: 40, apower: 12.5, aenergy: { total: 3 } },
    'light:1': { output: false, brightness: 100 } } })
  expect(r.supported).toBe(true)
  expect(r.channels).toEqual([
    expect.objectContaining({ kind: 'light', channel: 0, output: true, brightness: 40, apower: 12.5, aenergy_wh: 3 }),
    expect.objectContaining({ kind: 'light', channel: 1, output: false, brightness: 100, apower: null }),
  ])
})
it('reads rgb:0 and rgbw:0 profiles as a single light on channel 0', () => {
  for (const key of ['rgb:0', 'rgbw:0']) {
    const r = normaliseGetItem({ id: 'abc', gen: 2, online: 1, status: { [key]: { output: true, brightness: 70 } } })
    expect(r.channels).toEqual([expect.objectContaining({ kind: 'light', channel: 0, output: true, brightness: 70 })])
  }
})
it('a switch channel carries kind switch and brightness null', () => {
  const r = normaliseGetItem({ id: 'abc', gen: 3, online: 1, status: { 'switch:0': { output: true } } })
  expect(r.channels[0]).toMatchObject({ kind: 'switch', brightness: null })
})
it('discovery offers the RGBW PM (light only) as supported, one row per light', () => {
  const rows = normaliseAllStatus({ data: { devices_status: { abc: { _dev_info: { gen: 2, code: 'SNDC-0D4P10WW' }, 'rgbw:0': { output: false } } } } })
  expect(rows).toEqual([expect.objectContaining({ device_id: 'abc', channel: 0, kind: 'light', supported: true })])
})
it('stateFromReading matches on kind too, and keeps brightness', () => {
  const reading = { online: true, channels: [{ kind: 'light', channel: 0, output: true, brightness: 55, apower: null, aenergy_wh: null, temperature_c: null, source: 'cloud' }] }
  expect(stateFromReading(null, reading, 0, 'T', 'light')).toMatchObject({ online: true, output: true, brightness: 55 })
  expect(stateFromReading(null, reading, 0, 'T', 'switch')).toMatchObject({ online: true, output: null })
})
```

- [ ] **Step 2: Run them and confirm they fail** — `npx vitest run src/lib/shelly/status.test.js` → the new cases FAIL.
- [ ] **Step 3: Implement.** Light keys: `/^light:(0|[1-9]\d*)$/`, plus `rgb:0`/`rgbw:0` → channel 0. If a device reports both `rgb:0` and `rgbw:0`, keep one row (rgbw wins). A device with switches and lights lists both kinds. `brightness` goes through the existing `num()` (absent is not zero).
- [ ] **Step 4: Run** `npx vitest run src/lib/shelly` → all PASS (existing switch cases unchanged).
- [ ] **Step 5: Commit** `SHELLYLIGHT.1 — normaliser reads light/rgb/rgbw components`.

### Task 2: Client `setLight` and mixed `setGroups`

**Files:**
- Modify: `src/lib/shelly/client.js`
- Test: `src/lib/shelly/client.test.js`

**Interfaces:**
- Produces: `setLight(deviceId, channel, on) → result` (same tags as `setSwitch`, through `commandFailure`). `setGroups(groups, on)` accepts **either** the old `string[]` (switch ids) **or** `{ switch?: string[], light?: string[] }`. It sends only the non-empty keys: `{ switch:{ids, command:{on}}, light:{ids, command:{on}} }`. The result shape is unchanged (`failed` keyed `<id>_<channel>`).

- [ ] **Step 1: Write the failing tests**

```js
it('setLight sends set/light with on ONLY', async () => {
  const { fetchImpl, calls } = fetchStub([{ status: 200, body: '' }])
  const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
  expect(await c.setLight('abc', 0, true)).toMatchObject({ ok: true })
  expect(calls[0].url).toContain('/v2/devices/api/set/light?')
  expect(JSON.parse(calls[0].init.body)).toEqual({ id: 'abc', channel: 0, on: true })
})
it('setLight: a 400 DEVICE_OFFLINE is a device failure', async () => { /* status 400 {error} → kind device, code DEVICE_OFFLINE */ })
it('setGroups sends switch and light groups in one call and drops empty kinds', async () => {
  const { fetchImpl, calls } = fetchStub([{ status: 200, body: '' }, { status: 200, body: '' }])
  const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
  await c.setGroups({ switch: ['a_0'], light: ['b_0'] }, true)
  expect(JSON.parse(calls[0].init.body)).toEqual({ switch: { ids: ['a_0'], command: { on: true } }, light: { ids: ['b_0'], command: { on: true } } })
  await c.setGroups({ switch: [], light: ['b_0'] }, false)
  expect(JSON.parse(calls[1].init.body)).toEqual({ light: { ids: ['b_0'], command: { on: false } } })
})
it('setGroups still accepts a bare id array as switches', async () => { /* body === { switch:{ids:['a_0'],command:{on:true}} } */ })
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** If every kind is empty, return `{ ok: true, statusCode: 0, failed: {} }` with no request.
- [ ] **Step 4: Run** `npx vitest run src/lib/shelly` → PASS.
- [ ] **Step 5: Commit** `SHELLYLIGHT.2 — client setLight and mixed set/groups`.

### Task 3: `kind` on devices, adopt, commands

**Files:**
- Create: `supabase/migrations/775_shelly_device_kind.sql`
- Modify: `src/lib/shelly/device-load.js` (`DEVICE_COLUMNS` + `kind`), `src/lib/shelly/schemas.js` (`ShellyAdoptBody.kind` optional enum, default `'switch'`), `src/app/api/shelly/devices/route.js` (adopt stores `kind` from the live reading, never trusts the body over the reading), `src/lib/shelly/reconcile.js` (read readings by kind; command batches split by kind into one `setGroups({switch, light}, on)`), `src/lib/shelly/reconcile.js#runNowForDevice` and `src/app/api/shelly/devices/[id]/toggle/route.js` (`setLight` when `device.kind === 'light'`), `src/app/api/widget/devices/route.js` (select `kind`; widget toggle goes through the same toggle route).
- Test: `src/lib/shelly/reconcile.test.js`, `src/app/api/shelly/devices/route.test.js`, `src/app/api/shelly/devices/[id]/toggle/route.test.js`, `tests/select-columns` gate (via `npm run check:select-columns`).

**Interfaces:**
- Consumes: Task 1 `kind` on readings; Task 2 `setLight`, mixed `setGroups`.
- Produces: `shelly_devices.kind text NOT NULL DEFAULT 'switch' CHECK (kind IN ('switch','light'))`. `UNIQUE (device_id, channel)` stays as it is: a light and a switch never share a device id and channel on the same hardware.

- [ ] **Step 1: Write the migration** with the column, `COMMENT ON COLUMN`, and a self-check `DO` block asserting the column exists with its CHECK. No grant change (the table is already client-closed for writes; reads stay as mig 562).
- [ ] **Step 2: Write the failing tests:**
  - reconcile: two planned `on`s (one switch, one light) produce exactly one `setGroups({switch:['s_0'], light:['l_0']}, true)` and both get stamped;
  - toggle: a `kind:'light'` device calls `setLight`, never `setSwitch`;
  - adopt: adopting channel 0 of an rgbw device stores `kind:'light'` even when the body says `switch`;
  - refresh: a light's `last_state.brightness` is written, and a light with `aenergy` rolls into `shelly_energy_daily` exactly as a relay does (the energy step matches readings by channel AND kind).
- [ ] **Step 3: Run and confirm they fail.**
- [ ] **Step 4: Implement**, then `npx vitest run src/lib/shelly src/app/api/shelly` → PASS; `npm run check:select-columns` → ok (the migration adds `kind`).
- [ ] **Step 5: Commit** `SHELLYLIGHT.3 — kind on shelly_devices; lights adopt, toggle and reconcile`.

### Task 4: Discovery and card show lights; ship PR 1; live gate

**Files:**
- Modify: `src/app/api/shelly/discover/route.js` (pass `kind` through), `src/components/automations/ShellyDiscoverPanel.jsx` (adopt button for `kind:'light'`; label "Light"), `src/components/automations/ShellyDeviceCard.jsx` (a "Light · 55%" state line; no brightness control), `src/lib/openapi.js`
- Test: `src/components/automations/ShellyDiscoverPanel.test.jsx`, `ShellyDeviceCard.test.jsx`

- [ ] **Step 1: Failing tests:**
  - Discover renders an rgbw row with an enabled "Adopt" button and no "Not supported yet" chip;
  - the card for `{kind:'light', last_state:{output:true, brightness:55}}` shows "On · 55%" and renders no slider.
- [ ] **Step 2: Implement; run** `npx vitest run src/components/automations` → PASS.
- [ ] **Step 3: CI mirror + `npm run build`; apply mig 775; open PR 1** with changelog entry; merge when green.
- [ ] **Step 4: Live gate (Richard + builder).** Richard adopts both RGBW PMs at Stillorgan, then presses On, then Off. Confirm from Vercel logs and `shelly_devices.last_state`:
  1. the component shape matches what Task 1 handles;
  2. On restores the brightness last set in the Shelly app (Richard confirms by eye);
  3. one group press (or a reconcile batch) with a relay and a light moves both.

  **If 2 fails, or `set/light` refuses the component: stop and report.** Do not start PR 2.

---

## PR 2 — Groups and per-class schedules (backend)

### Task 5: Per-class windows in the engine

**Files:**
- Modify: `src/lib/schedule/desired-state.js` (`resolveDayWindows` class branch; export `DEFAULT_MERGE_GAP_MIN = 30`)
- Modify: `src/lib/shelly/schemas.js` (`ShellyClassRule` + `merge_gap_min`, `days`; export `DEFAULT_MERGE_GAP_MIN`, `ALL_DAYS = [1,2,3,4,5,6,7]`)
- Test: `src/lib/schedule/desired-state.test.js` (run under both `TZ=Europe/Dublin` and `TZ=America/New_York`, as the file already does), `src/lib/shelly/schemas.test.js`

**Interfaces:**
- Produces: class mode returns one window per joined cluster, `[{ on_at, off_at }]` sorted by `on_at`, for occurrences whose local start falls on a weekday in `class_rule.days` (default all). The fixed branch and Sonos are untouched.

Algorithm (not determined by the signature): map each live occurrence to `[start − lead, (end ?? start) + lag]`; sort by `on_at`; fold, joining while `next.on_at − cur.off_at <= merge_gap_min·60000`; drop occurrences whose `isoDow` in `tz` is not in `days`.

- [ ] **Step 1: Failing tests** (all with lead 15, lag 10, merge 30 unless stated):
  - `06:00–06:45` and `07:00–07:45` → **one** window `05:45–07:55` (gap 0 after lead/lag);
  - `06:00–06:45` and `09:30–10:15` → **two** windows;
  - gap exactly 30 min joins; 31 min does not (Review Focus 4);
  - overlapping classes join;
  - `days:[1,2,3,4,5]` on a Saturday date → `[]`; the same input on a Monday → windows (Review Focus 3);
  - a cancelled occurrence is ignored;
  - `merge_gap_min: 0` keeps touching windows separate only when there's a gap > 0;
  - schemas: `ShellyClassRule.parse({})` → `{lead_min:15, lag_min:10, merge_gap_min:30, days:[1,2,3,4,5,6,7]}`; `days:[]` is refused ("Pick at least one day"); `days:[8]` is refused.
- [ ] **Step 2: Run, confirm FAIL. Step 3: Implement. Step 4:** `TZ=America/New_York npx vitest run src/lib/schedule src/lib/shelly src/lib/sonos` and the same with `TZ=Europe/Dublin` → PASS.
- [ ] **Step 5: Commit** `SHELLYGROUPS.1 — class mode switches per class, joining short gaps`.

### Task 6: `shelly_groups` table and `group_id`

**Files:**
- Create: `supabase/migrations/776_shelly_groups.sql` (renumber if taken)
- Test: `tests/migration-776-shelly-groups.test.js` (PGlite, following the existing `tests/migration-7xx-*.test.js` pattern)

**Interfaces:**
- Produces:
  - `shelly_groups(id uuid pk, location_id uuid not null → locations on delete cascade, name text not null check 1..60, icon text not null default 'bulb' check in ('bulb','fan','tv','plug','droplet'), sort_order int not null default 0, enabled boolean not null default false, schedule_mode text not null default 'none' check (none|fixed|class), fixed_windows jsonb not null default '[]', class_rule jsonb not null default '{}', override jsonb, last_applied jsonb, created_by uuid → profiles on delete set null, created_at, updated_at, unique (location_id, name))`
  - `shelly_devices.group_id uuid null → shelly_groups(id) on delete set null`, indexed
  - trigger `shelly_devices_group_same_location` (BEFORE INSERT OR UPDATE OF group_id, location_id) raising when the group's `location_id` differs
  - `REVOKE ALL ON public.shelly_groups FROM anon, authenticated`, RLS enabled with no policy
  - `audit_mutation` attached if `shelly_devices` has it (match it)

- [ ] **Step 1: Failing PGlite tests:**
  - a cross-location `group_id` raises;
  - deleting a group nulls `group_id` and keeps the device row;
  - `anon`/`authenticated` hold no privilege (`information_schema.table_privileges`);
  - a duplicate name at one location → 23505;
  - re-running the migration is a no-op.
- [ ] **Step 2: Write the migration; run** `npx vitest run tests/migration-776-shelly-groups.test.js` → PASS; `npm run check:rls-restrictive && npm run check:select-columns` → ok.
- [ ] **Step 3: Commit** `SHELLYGROUPS.2 — shelly_groups table and group_id (mig 776)`.

### Task 7: Effective target (pure)

**Files:**
- Create: `src/lib/shelly/effective.js`
- Test: `src/lib/shelly/effective.test.js`

**Interfaces:**
- Produces: `effectiveTarget(device, group | null, nowMs) → object` with the shape `planDeviceAction` already reads:
  `{ ...device, enabled, schedule_mode, fixed_windows, class_rule, override }`.
  - No group: returns `device` unchanged.
  - With a group: schedule fields come from the group; `override` = the device's override if live (`isLiveOverride`), else the group's override if live, else `null`; `last_applied` stays the device's own.
- Also produces `GROUP_COLUMNS = 'id, location_id, name, icon, sort_order, enabled, schedule_mode, fixed_windows, class_rule, override, last_applied, created_at, updated_at'`.

- [ ] **Step 1: Failing tests:**
  - an ungrouped device passes through untouched;
  - a grouped device with `enabled:false` and mode `none` inherits the group's `enabled:true`/`class`;
  - a live device override beats a live group override;
  - an expired device override falls through to the group's;
  - Review Focus 5: a device whose group was deleted (`group_id` null) with `last_applied` from the group's `ov:` key → `planDeviceAction(effectiveTarget(d, null, now), …)` returns `null` (mode none, nothing sent).
- [ ] **Step 2: Implement; run** `npx vitest run src/lib/shelly/effective.test.js` → PASS. **Step 3: Commit** `SHELLYGROUPS.3 — effective target resolver`.

### Task 8: Reconcile and runNow use groups

**Files:**
- Modify: `src/lib/shelly/reconcile.js` (`reconcileLocation`: load the location's groups with `GROUP_COLUMNS`, `.eq('location_id', …)`, at most 50; plan each device against `effectiveTarget`; skip grouped devices whose group is class-mode when occurrences failed; a failed groups read skips **grouped** devices for the tick and still runs ungrouped ones), `runNowForDevice` (accepts an optional `group`)
- Test: `src/lib/shelly/reconcile.test.js`

**Interfaces:**
- Consumes: Task 7 `effectiveTarget`, `GROUP_COLUMNS`; Task 3 mixed batches.

- [ ] **Step 1: Failing tests:**
  - two members of a fixed-mode group inside their window both get `on` in one `setGroups`, each stamped `w:<on_at>`;
  - one member in `failedCommands` is unstamped while the other is stamped (Review Focus 2, backend half);
  - a groups read error → ungrouped devices still planned, grouped ones skipped, warn `groups load failed`;
  - occurrences failure skips class-mode **groups'** members only.
- [ ] **Step 2: Implement; run** `npx vitest run src/lib/shelly` → PASS. **Step 3: Commit** `SHELLYGROUPS.4 — reconcile plans devices through their group`.

### Task 9: Group routes and preview

**Files:**
- Create:
  - `src/app/api/shelly/groups/route.js` (`GET` list with members and `now`; `POST` create);
  - `src/app/api/shelly/groups/[id]/route.js` (`PATCH` name, icon, sort_order, enabled, schedule; `DELETE`);
  - `src/app/api/shelly/groups/[id]/devices/route.js` (`PUT {device_ids: uuid[]}`: sets membership, clears joined devices' own schedules, releases removed ones);
  - `src/app/api/shelly/groups/[id]/toggle/route.js` (`POST {state:'on'|'off'|'auto', hours?}`);
  - `src/app/api/shelly/preview/route.js` (`GET ?date=YYYY-MM-DD`);
  - `src/lib/shelly/group-now.js`;
  - route tests beside each.
- Modify:
  - `src/lib/shelly/schemas.js`: `ShellyGroupCreate`, `ShellyGroupPatch` (strict, reusing `ShellyWindow`/`ShellyClassRule`), `ShellyGroupMembers`, `ShellyGroupToggle` (same presets and `MAX_OVERRIDE_HOURS` as `ShellyToggleBody`), `ShellyPreviewQuery`;
  - `src/app/api/shelly/devices/route.js` (`GET` rows include `group_id`, `kind`);
  - `src/lib/openapi.js`;
  - `tests/cross-tenant/session-routes.test.js`.

**Interfaces:**
- Produces:
  - `GET /api/shelly/groups` → `{ success, groups: [{ ...GROUP_COLUMNS minus last_applied, device_ids: uuid[], now }] }`, where `now = describeGroupNow(group, members, windows, nowMs)` returns `{ on_count, member_count, mode: 'override'|'window'|'idle'|'none', until: iso|null, next_on: iso|null }`;
  - `POST …/toggle` → `{ success:true, applied: 'all'|'partial'|'none', pending_device_ids: uuid[], group }`; with `state:'auto'`, the override is cleared and the members are run-now'd;
  - `GET /api/shelly/preview?date=` → `{ success, date, classes:[{starts_at, ends_at, name}], groups:[{id, windows:[{on_at, off_at}]}], ignored_overrides: uuid[] }`.
- Toggle order (decides the semantics):
  1. write the group override;
  2. clear every member's device override;
  3. send one `setGroups({switch, light}, on)` over the members;
  4. stamp each landed member's `last_applied` with `overrideKey(groupOverride)`;
  5. report the members that didn't land as pending.

  With zero members, step 3 is skipped and the answer is `applied:'all'` (Review Focus 1).

- [ ] **Step 1: Failing route tests:**
  - create/rename/duplicate name → 409 `name_taken`;
  - PUT devices with a foreign device id → 404 and no change;
  - PUT clears the joining device's schedule fields;
  - toggle clears member overrides and sends exactly one `setGroups`;
  - an offline member → `applied:'partial'` with its id;
  - an empty group → no client call;
  - preview for a Saturday with `days` Mon–Fri → no windows for that group;
  - cross-tenant: an owner at another location PATCHing/toggling a group → 404 and the row unchanged; staff without `device_control` → 403.
- [ ] **Step 2: Implement; run** `npx vitest run src/app/api/shelly src/lib/shelly tests/cross-tenant` → PASS.
- [ ] **Step 3: CI mirror + `npm run build`; apply mig 776; open PR 2** with changelog entry.
- [ ] **Step 4: Commit** `SHELLYGROUPS.5 — group routes, group toggle (group wins), day preview`.

---

## PR 3 — Web redesign

### Task 10: Group card with schedule and members

**Files:**
- Create: `src/components/automations/ShellyGroupCard.jsx`, `ShellyGroupMembersEditor.jsx` (+ tests)
- Modify: `src/components/automations/ShellyScheduleEditor.jsx` (three choices "Never automatic" / "Fixed hours" / "Follow classes"; class fields: on before, off after, keep on if the gap is under, days)

**Interfaces:**
- Consumes: Task 9 routes. `ShellyScheduleEditor` gains an `onSave(patch)` that the group card points at `PATCH /api/shelly/groups/[id]` and the device card at the existing device PATCH.

- [ ] **Step 1: Failing component tests:**
  - choosing "Follow classes" reveals the four class fields with defaults 15 / 10 / 30 / Mon–Sun;
  - unticking every day shows "Pick at least one day" and does not save;
  - the members editor warns "These plugs will follow this group's schedule" before saving;
  - the group switch shows "1 of 2 on" when `now.on_count=1, member_count=2`.
- [ ] **Step 2: Implement with `@/components/ui` primitives and `un1t-*` tokens; run** `npx vitest run src/components/automations` → PASS. **Step 3: Commit** `SHELLYGROUPS.6 — web group card and schedule editor`.

### Task 11: Day preview strip

**Files:** Create `src/components/automations/ShellyDayPreview.jsx` (+ test)

- [ ] **Step 1: Failing tests:**
  - renders a "Classes" lane plus one lane per group from a `/api/shelly/preview` fixture;
  - "Next day" fetches `date+1` in the location's zone;
  - a joined window shows the caption "Classes under 30 min apart keep the lights on";
  - a group with `ignored_overrides` shows "Manual override not shown".
- [ ] **Step 2: Implement** (positions as % of 24 h of the location's local day; times via `@/lib/location-time` helpers, never `new Date('…Z')`). **Step 3: Commit** `SHELLYGROUPS.7 — day preview strip`.

### Task 12: Page restructure

**Files:** Modify `src/components/automations/ShellyDevicesClient.jsx`, `ShellyDeviceCard.jsx` (schedule editor only for ungrouped devices; shows its group's name otherwise), `ShellyDiscoverPanel.jsx` (styling only)

- [ ] **Step 1: Failing tests:**
  - the page lists group cards (sorted by `sort_order`) and then a "Not in a group" section;
  - "New group" creates through POST and appears without a reload;
  - a banner "N devices on your Shelly account aren't set up here" appears when discover returns unadopted supported rows.
- [ ] **Step 2: Implement; run** `npx vitest run src/components/automations` → PASS.
- [ ] **Step 3: CI mirror + build; open PR 3** with changelog. **Commit** `SHELLYGROUPS.8 — web Shelly page redesign`.

---

## PR 4 — Phone redesign (ships as an OTA; last)

### Task 13: Phone helpers

**Files:** Modify `mobile/lib/shelly.js`, `mobile/lib/api.js` (wrappers via `api()`: `listShellyGroups`, `toggleShellyGroup`, `countUnadoptedShelly`); Test `mobile/lib/shelly.test.js`

**Interfaces:**
- Produces:
  - `groupTone(group) → 'on'|'off'|'mixed'|'offline'`: mixed when `0 < on_count < member_count`;
  - `groupReasonLine(group, tz, nowMs) → string`: "Follows classes · on until 19:10", "Fixed hours · 06:00–21:00", "1 of 2 on · manual until midnight", "Never automatic";
  - `lightStateLabel(device)` → "On · 55%".

- [ ] **Step 1: Failing tests** for each string above, plus the mixed tone (Review Focus 2, phone half). **Step 2: Implement** (re-typed, not imported from `src/lib`; zone maths via `shared/zoned-time`). **Step 3:** `npm run check:mobile-imports && npm run check:mobile-lint` → ok. **Commit** `SHELLYGROUPS.9 — phone group helpers`.

### Task 14: Phone screen

**Files:** Modify `mobile/app/(staff)/shelly/index.jsx` (+ its test if present, else add `mobile/app/(staff)/shelly/index.test.jsx` following sibling screen tests)

- [ ] **Step 1: Failing tests** against the approved mockup:
  - header shows the studio, the next class and total watts;
  - the banner appears when the unadopted count is above 0 (discover is called once per screen open, never on the 30 s poll);
  - group cards show one switch and the members underneath;
  - pressing the group switch calls `toggleShellyGroup` and paints pending/partial copy before any new state;
  - a "Not in a group" card lists ungrouped devices with their own switches;
  - lights show "On · 55%".
- [ ] **Step 2: Implement. Step 3:** CI mirror (incl. `check:ota-paths`, `check:mobile-parity`); run the screen in the iOS simulator against a preview deploy and take screenshots for the PR.
- [ ] **Step 4: Open PR 4** with changelog. Update `docs/BACKLOG.md` (covers/lights line → lights shipped on/off only; groups shipped). Merge only when Richard has seen the screenshots. **Commit** `SHELLYGROUPS.10 — phone Smart plugs redesign with groups`.
