# Role-level AC device defaults — design

**Date:** 2026-07-07
**Status:** Approved (brainstorming) — pending implementation plan
**Repo:** un1t-crm

## Problem

Which AC units a staff member can operate is a **per-(profile, location) allowlist**
(`profile_locations.ac_device_ids`, `uuid[]`, mig 210), ticked on each person in
`StaffForm`. To give a role access you must edit every individual profile. There is no
way to say "at this location, this role controls these units" once.

`authoriseDevice()` in `src/lib/ac-devices.js` enforces the allowlist today:
- master → all
- `ac_device_ids IS NULL` **and** role ∈ {manager, owner} → all (legacy backfill)
- else device id must be in the array; `[]` = none

The boolean **`studio_management`** permission (already role-defaulted: master/manager/
owner on, staff/head_coach/reception off) gates reaching the AC UI/routes at all; the
allowlist decides *which* units within that. This design does NOT change
`studio_management` — it makes the **allowlist** role-defaultable.

## Goal

The AC allowlist comes from a **per-(location, role) default** configured once in the
Roles tab, resolved through the same three-tier stack the permission role-templates use
(code default → role template → per-user override). Per-profile ticking remains as an
override for exceptions.

## Decisions (settled during brainstorming)

1. **Per-role curated device lists** (not a plain all/none boolean): operators pick the
   specific AC devices each role gets by default, per location.
2. **Per-profile override stays**, gaining an explicit "inherit from role" state.
3. **Behaviour-preserving migration**: existing blanket empty-array backfills flip to
   "inherit" so role defaults actually take effect for existing staff.

## Design

### 1. Storage

Add a nullable `ac_device_ids uuid[]` column to **`location_role_permissions`** (the
per-(location, role) table from mig 364 that already holds the permission templates).
Semantics mirror the per-profile column:

- `NULL` = **not configured** → inherit the code default
- `[]` = explicitly **none**
- `[ids]` = exactly those devices

No "all" sentinel at the template level — "all" is expressed by the operator ticking
every unit, or by leaving the template `NULL` so the code default (which *does* carry an
"all" for manager/owner) applies.

### 2. Resolution — three-tier resolver

New pure helper (in `shared/` so web can import it; mirrors `resolvePermission`'s tier
order). Effective allowlist for user U, role R, location L:

- **Master** → `ALL` (short-circuit).
- **Tier 2 — per-user override** (`profile_locations.ac_device_ids`): if **non-NULL**
  (an array, including `[]`) → that is the answer (`[]` = none, `[ids]` = those).
- **Tier 2.5 — role template** (`location_role_permissions.ac_device_ids` for (L, R)):
  if **non-NULL** → that is the answer. `location_role_permissions` is keyed by
  (location, role, **employment_type**) — for the staff role there are `all` / `fte` /
  `contractor` / `casual` variant rows (RECEPTION.2). The effective template value uses
  the same precedence the permission templates use: the employment-type **variant** row's
  `ac_device_ids` if non-NULL, else the base `all` row's, else fall through. This resolved
  value is carried on the user the same way `activeRoleTemplate` already is.
- **Tier 3 — code default** (`DEFAULT_AC_ACCESS_BY_ROLE`): master/owner/manager =
  `'all'`, head_coach/staff/reception = `'none'`. Preserves the mig-210 backfill intent.

Result is either the sentinel `ALL` or a concrete set of device ids. `NULL` at a tier
means "no decision here, fall through"; `[]` is a real decision ("none").

### 3. Enforcement & read paths

- **`authoriseDevice()`** (`src/lib/ac-devices.js`, used by turn-on / turn-off / extend /
  state) is refactored to consult the resolver: a device is allowed iff the result is
  `ALL` or the set contains the device id. The current inline `NULL + manager/owner ⇒
  all` branch is removed (the code default now supplies that).
- **`GET /api/studio-management/ac/devices`** (the operator's device list) filters via
  the same resolver, so the visible set equals the controllable set.
- **`loadDeviceForUser()`** (which already loads the device + the user's assignment) also
  loads the (location, role) role-template `ac_device_ids` so the resolver has all three
  tiers. (Equivalently `getCurrentUser()` can preload it per active location; the plan
  picks whichever is cleaner — the resolver's inputs are: role, per-user list, role-
  template list.)

### 4. Roles tab UI

In `src/components/RolePermissions.jsx`, add an **"AC devices"** section for the active
(location, role) — and, for the staff role, the active employment-type **segment** the
component already switches between (all / fte / contractor / casual), editing that row's
`ac_device_ids`:
- Fetches the location's `ac_devices` (reuse the existing options endpoint pattern; the
  role-permissions load can also return the current template `ac_device_ids`).
- Multi-select checklist of the location's units. Three explicit save states:
  **specific list** (`[ids]`), **None** (`[]` — explicit deny), and **Inherit code
  default** (`NULL` — the section's default when never configured). "All" is a
  convenience that ticks every current unit (a concrete `[ids]` list, not a sentinel);
  "Inherit" is the distinct control that clears back to `NULL`.
- Saved to `location_role_permissions.ac_device_ids` via the existing role-permissions
  `PUT /api/locations/[id]/role-permissions` route, extended to accept + persist the
  column alongside the `permissions` blob.
- A hint that AC control only takes effect when **`studio_management` is on** for the
  role (that boolean gate is unchanged).

### 5. Per-profile override

`StaffForm`'s `AcDeviceAllowlistPicker` stays but gains an explicit **"Inherit from
role"** state that writes `NULL` (distinct from `[]` = explicit none and `[ids]` =
explicit list). Most profiles inherit; only exceptions carry an explicit override. The
`staff-write.js` `buildAssignmentRow` already round-trips `null` / `[]` / `[ids]` for
this column — the UI just needs the third choice.

### 6. Migration (behaviour-preserving)

`mig 379`, forward-only, via Supabase MCP against un1t-crm:
- `ALTER TABLE location_role_permissions ADD COLUMN ac_device_ids uuid[]` (nullable).
- `UPDATE profile_locations SET ac_device_ids = NULL WHERE ac_device_ids = '{}'` — flips
  the blanket mig-210 empty-array backfill (staff / head_coach / contractor) to
  **inherit**, so the role default flows through. Deliberate non-empty per-person lists
  and the manager/owner `NULL`s are untouched.
- `get_advisors` (security) after the DDL.

**Day-one effect is identical access** (staff → none via code default; manager/owner →
all via code default; explicit per-person lists preserved), but role defaults now
propagate to inheriting profiles.

### 7. Out of scope

- No change to `studio_management` (still the boolean gate for reaching AC; still
  role-defaulted). Splitting AC vs doors out of `studio_management` is a separate concern.
- Door access (`unifi_door_ids`) is the sibling model but is NOT part of this change
  (could adopt the same pattern later if wanted).
- Mobile AC control (if any) rides the same routes/resolver; no dedicated mobile UI here.

## Testing

- **Resolver unit tests** across all tier combinations: master → ALL; per-user `[ids]`
  and `[]` override the template/default; role-template `[ids]`/`[]` override the code
  default; `NULL` at each tier falls through; code defaults (manager/owner=all,
  staff=none).
- **`authoriseDevice` behaviour-preservation snapshot**: on day one (no templates, backfill
  migrated), manager/owner control all, staff/head_coach/reception control none, a
  master controls all, and a staff member with an explicit `[dev]` list controls only
  that device.
- **Role-defaults-take-effect test**: with a template `ac_device_ids = [dev1]` for the
  staff role at L, a staff member with per-user `NULL` resolves to `{dev1}`.
- **Migration test/verification**: `profile_locations.ac_device_ids = '{}'` → `NULL`;
  non-empty arrays and existing `NULL`s unchanged; the new column exists and defaults
  `NULL`.
