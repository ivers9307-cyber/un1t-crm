# Equipment maintenance & inspections — design

**Date:** 2026-07-31
**Branch:** `equipment-maintenance-inspections`
**Status:** approved, ready for implementation planning

---

## Problem

Studio equipment needs inspecting on a repeating cycle. Today nothing tracks
which piece of kit was last checked, what was checked on it, or whether a
reported fault was ever fixed. Faults get reported ad-hoc through the existing
Issues surface with no link back to the equipment they came from, so there is
no per-asset history and nothing to show an insurer or an H&S auditor.

Operators need: a register of the studio's equipment, a recurring inspection
schedule per kind of equipment, a checklist that must be worked through, defect
reporting with photos, those defects routed to owners, and a record that the
defect was resolved.

## What already exists (and is being reused, not rebuilt)

Two systems in the CRM already cover large parts of this. Both are live.

**`issues` (mig 213, `src/app/api/issues/*`, `mobile/app/issues/`)** — staff
submit a studio problem with up to three photos; it routes to owner + master at
the location plus anyone holding `issues_inbox`; lifecycle is
`open → in_progress → resolved → closed` with claim, mandatory resolution
notes, and `notify_issue_submitted` / `notify_issue_resolved` pushes. Photos
live in the private `issue-photos` bucket at
`{location_id}/{issue_id}/{attachment_id}-{filename}`.

**This is the entire defect-reporting and resolution half of the requirement.**
The design routes inspection faults into it rather than building a second
inbox — one place for owners to look, and the claim/resolve/close/notify
machinery is already proven in production.

**`checklist_templates` / `checklist_instances` (migs 214, 215)** — a working
checklist engine: JSONB items with stable UUIDs, an item snapshot taken on
instance creation so template edits cannot shift state under a live run, tick
state keyed by item id, a `deadline_at` and a sweep cron
(`/api/cron/checklist-sweep`) that flags misses and notifies head coach +
owners.

These tables are **not** extended. They are keyed
`unique (location_id, role, day_of_week)` and
`unique (profile_id, date, template_id)`; those constraints *are* the design of
a person-and-date checklist. An inspection belongs to an asset on a cycle, not
to a person on a date. Forcing both through one table would make every column
nullable-and-conditional and risk breaking coaches' daily checklists in
production. The **patterns** are reused — stable item ids, snapshot-on-create,
tick state keyed by id, deadline sweep — the tables are not.

## Decisions taken during design

| Question | Decision |
|---|---|
| Granularity | Individual assets, ~30–80 per studio. Consumables (kettlebells, mats, bands) are not individually tracked. |
| How inspections reach people | Location-level inspection weekday. A reminder push goes to everyone holding the inspect permission; the app then lists whatever is due that day. No per-person assignment, no shift matching. |
| What owners receive | Only faults notify. Every submission is logged. A separate sweep alerts owners when an inspection was not submitted. |
| Where faults land | The existing Issues inbox, tagged with the equipment. |
| Checklist + interval scope | Defined per **equipment type**; assets inherit. No per-asset override. |
| Failed item handling | One issue per inspection listing every failed item, plus an optional "take out of service" flag on the asset. |
| Surfaces | Mobile inspection run; web setup, web inspection run, web compliance log. |

---

## Data model

Four new tables, all `location_id`-scoped, all RLS service-role-only (matching
`issues` and the checklist tables — API routes mediate every read and write).
Next available migration number is **467**.

`location_id` is `on delete restrict` on all four, matching `issues` (mig 213)
rather than `checklist_templates` (mig 214, cascade). Cascade would be unsafe
here: deleting a location would cascade into both `equipment_types` and
`equipment`, and the `restrict` FK between them could fire mid-cascade. Locations
are not deleted in practice; `restrict` makes that explicit instead of leaving a
latent error.

### `equipment_settings`

One row per location.

| Column | Notes |
|---|---|
| `location_id` | PK, FK `locations` |
| `inspection_day_of_week` | int 0–6, Postgres `dow` convention (0 = Sunday), same as `checklist_templates.day_of_week` |
| `enabled` | boolean, default `false` |
| `created_at` / `updated_at` | |

No row, or `enabled = false`, means the feature is dormant at that location.
Hatch Street stays dark until switched on, and the migrations can land ahead of
the UI without surfacing anything.

### `equipment_types`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `location_id` | FK `locations`, restrict |
| `name` | text, 1–100 chars, `unique (location_id, name)` |
| `items` | JSONB array, default `'[]'`, `check jsonb_typeof = 'array'` |
| `interval_weeks` | int, `check > 0` |
| `enabled` | boolean default true — soft delete, mirrors `checklist_templates.enabled` |
| `created_at` / `updated_at` | |

`items` uses the exact shape the checklist system already validates:
`[{ id: uuid, label: string 1..200, order: int }]`, validated API-side for
length, bounds, and unique ids. Stable per-item UUIDs mean renaming
`"Check belt"` → `"Check belt wear"` preserves history on past inspections.

**Interval is in weeks, not days.** Inspections happen on a fixed weekday, so
weeks are the only unit where the next due date always lands on that weekday
without drift. 1 = weekly, 2 = fortnightly, 4 = four-weekly, 13 = quarterly,
52 = annual.

### `equipment`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `location_id` | FK `locations`, restrict |
| `type_id` | FK `equipment_types`, **on delete restrict** |
| `name` | text 1–100, e.g. `"Treadmill 3"` |
| `asset_tag` | text nullable; `unique (location_id, asset_tag)` where not null |
| `serial_number`, `manufacturer`, `zone` | text nullable |
| `purchase_date` | date nullable |
| `status` | `in_service` \| `out_of_service` \| `retired`, default `in_service` |
| `out_of_service_issue_id` | FK `issues`, nullable, on delete set null |
| `next_due_on` | date not null — the driving column |
| `last_inspected_on` | date nullable |
| `notes` | text nullable |
| `created_at` / `updated_at` | |

Index `(location_id, next_due_on) where status <> 'retired'`. That index *is*
the due list — no generation cron, no pre-created rows to orphan.

### `equipment_inspections`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `location_id` | FK `locations`, restrict |
| `equipment_id` | FK `equipment`, **on delete restrict** — the compliance log cannot be holed |
| `type_id` | FK `equipment_types`, on delete set null (records which type it ran against) |
| `inspector_id` | FK `profiles`, on delete set null |
| `due_on` | date not null — what cycle this run satisfies |
| `items` | JSONB snapshot of the type's items at draft creation |
| `results` | JSONB, `{ "<item_id>": { state: 'pass'\|'fail', note, at, by } }` |
| `status` | `draft` \| `submitted`, default `draft` |
| `submitted_at` | timestamptz nullable |
| `issue_id` | FK `issues`, nullable, on delete set null |
| `created_at` / `updated_at` | |

`unique (equipment_id, due_on)` — one inspection per asset per cycle. This
constraint is the idempotency guard against a double-submit race.

Indexes: `(equipment_id, due_on desc)` for per-asset history,
`(location_id, submitted_at desc)` for the compliance log.

### Change to an existing table

`issues` gains a nullable `equipment_id` (FK `equipment`, on delete set null)
plus an index. That is the only modification to anything already live.

---

## Lifecycle

1. Operator defines types with their checklists and intervals, adds assets,
   sets the location's inspection weekday, enables the feature.
2. On that weekday a morning cron pushes everyone holding the inspect
   permission: *"6 pieces of equipment due for inspection today."*
3. The Maintenance surface lists assets where `next_due_on <= today` and
   `status <> 'retired'`, overdue first.
4. Opening an asset lazily creates a `draft` inspection, snapshotting the
   type's `items`. A mid-run edit to the type cannot shift state under the
   inspector — the same protection `checklist_instances` already provides.
5. Each item is marked pass or fail. **A fail requires a note.** Up to three
   photos per inspection (`MAX_PHOTOS_PER_ISSUE`, `MAX_PHOTO_BYTES`,
   `ALLOWED_PHOTO_MIME` all reused from `src/lib/issues.js`).
6. On submit:
   - If anything failed, **one** `issues` row is created with `equipment_id`
     set, a description composed from the failed items and their notes, and the
     photos attached. `notify_issue_submitted` fires to owner / master /
     `issues_inbox` holders through existing, unmodified code.
   - If "take out of service" was ticked, the asset flips to `out_of_service`
     with `out_of_service_issue_id` pointing at that issue.
   - The inspection goes `submitted`, `last_inspected_on = today`, and
     `next_due_on` rolls forward by `interval_weeks`.
7. An owner resolves the issue in the existing Issues inbox. A hook on
   `/api/issues/[id]/resolve` returns the asset to `in_service` when the
   resolved issue is the one that removed it.
8. An evening sweep cron finds assets still due with no submitted inspection,
   pushes owners + master the outstanding list, and logs
   `equipment.inspection_overdue`. **It flips no state** — the asset simply
   stays overdue and stays top of the list.

### Due-date arithmetic

Two rules, both living in `src/lib/equipment.js` and both directly tested.

**First due date, on asset creation.** `next_due_on` is the next occurrence of
the location's `inspection_day_of_week` on or after today — unless the operator
supplies an explicit first-due date, which wins. If the location has no
`equipment_settings` row yet, `next_due_on` is today and gets snapped to the
weekday at the first roll-forward.

**Roll-forward, on submit.** The new date is `due_on + (interval_weeks × 7)` —
measured from the cycle date, **not** from the day the inspection happened, so a
late inspection does not drag the whole schedule later. If that result is still
in the past (an inspection done very late, more than one cycle overdue), advance
in whole `interval_weeks` steps until it lands on or after today, so submitting
never produces an item that is instantly overdue again. Because the interval is
in whole weeks and `due_on` already sits on the inspection weekday, the result
always lands on that weekday.

### Rules worth stating explicitly

- **Editing a type's `interval_weeks` affects the next roll-forward only**, not
  existing `next_due_on` values. Bulk recalculation is an explicit button, never
  a side effect of saving a type.
- **Out-of-service assets leave the due list** and appear in their own section.
  There is already an open issue against them; nagging for re-inspection of
  known-broken kit is noise.
- **Retiring an asset** removes it from due lists and keeps its full history.
  The `on delete restrict` FK blocks deletion outright.
- **Changing an asset's type** leaves `next_due_on` alone. The new type's
  checklist applies to the next inspection; its interval applies from the next
  roll-forward — the same rule as editing an interval.
- **Submit requires every item in the snapshot to carry a result.** A partially
  ticked inspection stays a draft; the route rejects submission with the
  unmarked item ids in `issues[]`.
- **Status can also be set manually** from the register by `equipment_admin` —
  for kit taken off the floor outside an inspection. That path changes status
  only; it creates no issue and leaves `out_of_service_issue_id` null, so the
  clear-on-resolve hook has nothing to act on and the asset must be returned to
  service manually.
- **Photos are uploaded only at submit**, inside the same request that creates
  the issue. The bucket path is `{location_id}/{issue_id}/…`, so no valid path
  exists until the issue does. Holding photos in the multipart submit means no
  temporary storage, no cleanup job, and no bytes stranded by an abandoned
  draft. Drafts persist ticks and notes only.

---

## Surfaces

### Web — `/maintenance`

Four tabs. The last three are gated on `equipment_admin`.

- **Due** — today's list, runnable from the front-desk laptop.
- **Equipment** — the register table (name, type, zone, status, last inspected,
  next due). A row opens a drawer with details, full inspection history, and
  every issue raised against that asset.
- **Types** — checklist editor and interval per type. The inspection weekday and
  the enable switch live here rather than as a fifth tab.
- **Log** — filterable compliance history with CSV export. This is the tab shown
  to an insurer or auditor.

### Mobile — `mobile/app/maintenance/`

Due list → per-asset inspection screen (pass/fail per item, note required on
fail, photos, out-of-service toggle, submit). A dashboard card alongside
`TodayChecklistCard` surfaces what is due.

---

## Permissions

Two new keys in `shared/permissions.js`:

- **`equipment_admin`** — manage the register, types and settings. Default on
  for owner + master only. Added to `WEB_ONLY_OK` with the reason that register
  and checklist setup is a desktop task.
- **`equipment_inspect`** — see the due list and submit inspections. Default on
  for every role, matching how `issues` is universal. Gets a mobile counterpart
  carrying `webEquivalent: 'equipment_inspect'` so `check:mobile-parity` passes.

Two new notify keys (`mobileOnly`, `isNotify`):

- **`notify_inspection_due`** — default on for anyone who can inspect.
- **`notify_inspection_overdue`** — default on for owner + master.

Faults reuse `notify_issue_submitted` / `notify_issue_resolved` unchanged. That
is the point of routing into `issues`.

---

## Crons

Both need a `cron_heartbeats` row and **must call `stampHeartbeat`** on success,
or they read as stale while running fine.

- **`equipment-inspection-reminder`**, ~07:00 Dublin. For each enabled location
  whose `inspection_day_of_week` matches today, count due assets and push.
  Silent when the count is zero.
- **`equipment-inspection-sweep`**, ~19:00 Dublin. Find assets with
  `next_due_on <= today` and no `submitted` inspection for that `due_on`, push
  owners + master the outstanding list, log the audit event. Deduped through the
  existing `sendPushOnce` so a retry cannot double-ping.

Both authenticate on `CRON_SECRET`, per-row error isolation, `maxDuration = 60`.

All date arithmetic goes through `dublinTodayStr()` from `@/lib/dublin-time`.
Never `new Date().toISOString().slice()` — `check:guardrails` blocks it, and the
BST offset silently corrupts a business "today".

---

## API routes

All use `withAuth` + the service-role client, check the permission, call
`assertLocationAccess`, and return `{ success, data }`. Detail routes return
**404, not 403**, so ids cannot be enumerated. Every route registered in
`src/lib/openapi.js`.

| Route | Purpose |
|---|---|
| `GET/POST /api/equipment` | list register / create asset |
| `GET/PATCH/DELETE /api/equipment/[id]` | detail / edit / retire |
| `GET/POST /api/equipment/types` | list / create type |
| `PATCH/DELETE /api/equipment/types/[id]` | edit / disable type |
| `GET/PUT /api/equipment/settings` | inspection weekday, enable flag |
| `GET /api/equipment/due` | the due list for the active location |
| `POST /api/equipment/[id]/inspection` | create-or-fetch the draft |
| `PATCH /api/equipment/inspections/[id]` | tick items |
| `POST /api/equipment/inspections/[id]/submit` | multipart; photos, issue creation, roll-forward |
| `GET /api/equipment/inspections` | compliance log |

Mobile consumes these through `mobile/lib/maintenance-api.js` built on
`authHeaders()` / `api()` — never a hand-rolled `Bearer`, which drops
`x-impersonate-target` and breaks "View as user".

---

## Code shape

`src/lib/equipment.js` holds the pure logic: interval snapping, due filtering,
item validation, result validation, composing the issue description from failed
items, and the clear-on-resolve rule. Route files stay thin —
`getCurrentUser()` → permission check → `validateBody` → `assertLocationAccess`
→ `createServerClient()` → work → response.

Anything mobile needs is re-exported through `shared/` and imported as
`shared/…`, never a relative `../shared` (Metro 0.84+ / SDK 57 will not resolve
out of the project root).

UI composes `src/components/ui` primitives. Status chips use
`bg-<c>-500/10 text-<c>-700` — the -700 ramp, enforced by
`check:guardrails`.

## Error handling

Submit is the only path where several things change at once. Order: create the
issue with its photos first, then mark the inspection submitted and roll the
asset's due date. If the issue insert fails, the inspection stays `draft` and
nothing advances — the inspector retries with their ticks intact. The
`unique (equipment_id, due_on)` constraint means a retry cannot advance the
cycle twice.

`maxDuration = 60` on the submit route, matching the existing issues POST —
three 10MB photos over 4G will blow the 30s default.

## Testing

Pure-lib vitest:
- first-due-date calculation (every weekday, no-settings-row fallback, explicit
  operator override)
- roll-forward from `due_on` not from today; the multi-cycle-overdue case
  advancing in whole steps; both run under `TZ=Europe/Dublin` **and** a US
  timezone, and across the BST/GMT boundary
- due-list filtering (overdue ordering, retired excluded, out-of-service
  excluded)
- item and result validation (fail without a note is rejected; submit with any
  unmarked item is rejected)
- issue description composition from failed items
- the clear-on-resolve rule

Route tests mirroring the existing `src/app/api/issues/**/route.test.js`
pattern: auth guard present, permission gate, 404-not-403 on cross-location
access.

Cron tests: no double-push, disabled locations skipped, zero-due no-op,
heartbeat stamped.

Before pushing, the full CI mirror plus `npm run build` — this adds routes and
imports, which mocked vitest will not catch.

## Rollout

Migrations are forward-only, applied via Supabase MCP `apply_migration` against
the **un1t-crm** project (`iyvtbjjxdggiadzwwvdj`), with `get_advisors`
(type=security) run after the DDL. They are inert: with no `equipment_settings`
row the feature is invisible, so schema can land before the UI.

Stillorgan only to begin with.

Roughly three PRs:

1. Migrations, `src/lib/equipment.js`, permission keys, web Types + Equipment
   register admin.
2. Due list and inspection run (web + mobile), issue creation, out-of-service
   flag, the resolve hook.
3. Crons, notification keys, compliance log + CSV export.
