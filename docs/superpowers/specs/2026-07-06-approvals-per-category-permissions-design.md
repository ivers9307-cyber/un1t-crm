# Per-category approval permissions — design

**Date:** 2026-07-06
**Status:** Approved (brainstorming) — pending implementation plan
**Repo:** un1t-crm

## Problem

The Approvals inbox is gated by a single permission, `approvals_inbox`, which is
all-or-nothing: granting it exposes every category (Contractor invoices, Employee
expenses, Agent requests, Time off, Shift swaps, Roster approvals). There is no way
to make one staff member responsible for approving a single category.

Compounding this, each category also carries a **hard-coded role floor** in its
provider backend (and on its source page), independent of `approvals_inbox`:

| Category | Hard-coded approver roles today |
|---|---|
| Contractor invoices | owner, master |
| Employee expenses | owner, master |
| Agent requests | manager and up |
| Time off | manager, head_coach, owner, master |
| Shift swaps | manager, head_coach, owner, master |
| Roster approvals | owner, master |

So even inside the inbox, a plain `staff` role is floored out of every category.
Delegating a single category to one person is impossible.

## Goal

Replace the single grant with **six independently-grantable per-category
permissions**. The per-category permission becomes the **single source of truth**
for who can approve that category — enforced in the aggregated inbox, the inline
approve/decline action, and each category's own source page. Hard-coded role floors
are removed.

## Decisions (settled during brainstorming)

1. **Permission is the only gate.** Drop the hard-coded role floors. Whoever holds a
   category's permission can approve it, regardless of role. Role defaults merely
   pre-seed sensible starting points that operators override in the Roles UI.
2. **Six categories** become independent toggles: Contractor invoices, Employee
   expenses, Agent requests, Time off, Shift swaps, Roster approvals. The Bookkeeper
   invoice-queue and Issues tabs keep their existing separate gates (out of scope).
3. **Enforce everywhere.** The per-category permission is enforced in the inbox
   aggregation, the inline approve/decline action, and each category's source-page
   approve/decline action.

## Design

### 1. Permission keys

Six new grant keys in `shared/permissions.js`, mapped 1:1 to the registry providers:

| Category | New permission key |
|---|---|
| Contractor invoices | `approvals_contractor_invoices` |
| Employee expenses | `approvals_fte_expenses` |
| Agent requests | `approvals_agent_requests` |
| Time off | `approvals_time_off` |
| Shift swaps | `approvals_shift_swaps` |
| Roster approvals | `approvals_rosters` |

`approvals_inbox` is **repurposed to the location feature gate only** — the Settings
feature card ("is Approvals switched on for this location at all"). It is removed as a
per-role/per-user *grant*. The six sub-keys **inherit the location gate** from
`approvals_inbox`: if the feature card is off for a location, all six resolve `false`
there regardless of role/user grants.

**Inbox visibility rule:** the Approvals inbox (nav item + page) is visible iff the
feature is enabled at the user's active location **and** the user holds ≥1 of the six
grants. Each tab renders only for the categories the user holds.

### 2. Role defaults — behaviour-preserving

Each role's default for the six keys is **seeded from the current floor table**, so on
deploy day nothing changes for anyone until an operator edits the Roles UI:

| Role | Contr. inv | Expenses | Agent req | Time off | Swaps | Rosters |
|---|---|---|---|---|---|---|
| master | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| manager | — | — | ✓ | ✓ | ✓ | — |
| head_coach | — | — | — | ✓ | ✓ | — |
| staff | — | — | — | — | — | — |
| reception | — | — | — | — | — | — |

(master bypasses tiers anyway once the location gate passes; listed ✓ for clarity.)

These replace the `approvals_inbox: true/false` entries in
`DEFAULT_WEB_PERMISSIONS_BY_ROLE`.

### 3. Enforcement — one central map, three call sites

A single map in `shared/` — `APPROVAL_CATEGORY_PERMISSION` (provider key →
permission key) — is the only place the category→permission relationship is defined.
Consumed by all three enforcement points so the rule cannot drift:

- **Inbox aggregation** (`src/lib/approvals/registry.js` + each provider under
  `src/lib/approvals/providers/`): each provider gains a `permissionKey`. The registry
  filters providers by `hasPermission(user, provider.permissionKey)`, and
  `fetchPending` / `countPending` / tab visibility use the permission instead of the
  hard-coded role list.
- **Inline approve/decline action** (the shared inbox action endpoint): checks the
  category's permission before mutating. Security-critical — inline approvals are live,
  so this is the primary real mutation path.
- **Source pages**: each category's own approve/decline action (Time-off page, roster
  page, contractor-invoices page, etc.) swaps its role-floor check for the same
  `hasPermission(user, APPROVAL_CATEGORY_PERMISSION[category])` check. The
  implementation plan will inventory the exact endpoint/handler per category (six
  source features).

### 4. Roles / Settings UI

In `src/components/RolePermissions.jsx`:

- The six toggles render **grouped under an "Approvals" subsection heading**, with a
  select-all / grant-all affordance (owner/master normally want all six).
- The single `approvals_inbox` per-role toggle is **removed** from the grant list; it
  lives on only as the location feature card on the location settings page.
- Existing "changed-from-default" amber-dot behaviour and sparse-diff storage work
  unchanged for the six new keys.

### 5. Migration

Forward-only, applied via Supabase MCP against un1t-crm. **Data-only** (no schema
change) — expands existing stored grants:

- For every row in `profile_locations.permissions` and
  `location_role_permissions.permissions` that explicitly sets `approvals_inbox`:
  - `approvals_inbox: true` → set all six sub-keys `true`
  - `approvals_inbox: false` → set all six sub-keys `false`
  - then remove `approvals_inbox` from that grant blob.
- `locations.features.approvals_inbox` is **left untouched** — it remains the location
  feature gate.
- Run `get_advisors` after applying (per estate convention), though no DDL is involved.

`sanitizePermissionsBlob()` / `WEB_PERMISSION_KEYS` must include the six new keys so
they survive save; `approvals_inbox` stays a recognised key for the location-features
namespace but is dropped from the grant-key set.

### 6. Mobile

Mobile approvals viewing stays on the existing `mobile.approvals` gate for this build.
Because the approve/decline **action endpoints** enforce the six keys, mobile cannot
bypass them — a mobile user lacking a category's grant simply cannot complete the
action. A full per-category mobile UI (six mobile toggles + tab filtering) is a
follow-up, not part of this build.

### 7. Out of scope

- Bookkeeper invoice-queue and Issues tabs (keep their current separate gates).
- Per-category mobile UI (viewing) — follow-up.
- Any change to what the source pages *do* beyond swapping their approve/decline
  authorization check.

## Testing

- **Behaviour-preserving snapshot:** seeded role defaults for the six keys reproduce
  the old floor table exactly (per role × category).
- **Resolver unit tests:** the six keys resolve correctly through all tiers (location
  gate off → false; per-user override; role template; role default); location-gate
  inheritance from `approvals_inbox` works.
- **End-to-end:** a `staff` user granted only `approvals_time_off`
  - sees the Approvals inbox with only the Time off tab,
  - can approve a time-off request (inbox inline + source page),
  - is refused (403 / redirect) on a contractor-invoice approval via **both** the
    inbox inline action **and** the contractor-invoices source page.
- **Migration test:** a stored `approvals_inbox: true` and a stored
  `approvals_inbox: false` each expand to the six sub-keys with the right boolean and
  drop `approvals_inbox`.

## Rollout

Behaviour-preserving by construction: on deploy, seeded defaults reproduce current
access and the migration expands existing overrides, so no one's access changes until
an operator opens the per-location Roles tab and grants a category to someone new.
