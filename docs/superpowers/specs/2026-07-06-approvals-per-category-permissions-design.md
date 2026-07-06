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
per-role/per-user *grant*. It stays the **only location-gated key**.

The six sub-keys are **not location-gated** (`isFeatureGatedByLocation` returns `false`
for them). This is deliberate: today, turning the Approvals feature card off only hides
the aggregator inbox — it does **not** disable approving on the source pages (those
gate on their own permissions like `schedule` / `invoices_inbox`). If the six sub-keys
were gated by the `approvals_inbox` feature flag, disabling the card would suddenly
break source-page approvals too — a footgun. So the card governs the aggregator only;
the six grants govern approve-ability everywhere else.

**Inbox visibility rule (derived):** `hasPermission(user, 'approvals_inbox')` is
redefined in the web adapter as *feature enabled at the active location* **AND** *user
holds ≥1 of the six grants*. Every current consumer of `approvals_inbox` (nav item,
page guard, command palette, today-feed badge) routes through `hasPermission`, so this
single derived definition covers them all with no other call-site changes. Each tab
renders only for the categories the user holds.

### 2. Role defaults — behaviour-preserving

Each role's default is **seeded from the category's current source-route approver
set** — i.e. who can approve that category *today* — because approve-ability today is
gated by the source routes, not by `approvals_inbox`. The rule is simple:

- **Finance + rosters** (contractor invoices, employee expenses, rosters) → `owner`
  (+ `master`), matching the current `['owner']` route checks.
- **Agent requests, time off, shift swaps** → `MANAGER_ROLES`
  (`master`, `owner`, `manager`, `head_coach`), matching the current
  `MANAGER_ROLES` route checks.

| Role | Contr. inv | Expenses | Agent req | Time off | Swaps | Rosters |
|---|---|---|---|---|---|---|
| master | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| manager | — | — | ✓ | ✓ | ✓ | — |
| head_coach | — | — | ✓ | ✓ | ✓ | — |
| staff | — | — | — | — | — | — |
| reception | — | — | — | — | — | — |

(master bypasses the tiers anyway once past the location gate; listed ✓ for clarity.)

These replace the single `approvals_inbox: true/false` entry in each role map of
`DEFAULT_WEB_PERMISSIONS_BY_ROLE`.

**One intended visible change:** `head_coach` previously had `approvals_inbox` off by
default, so they never saw the aggregator inbox — even though they could already
approve time-off / swaps / agent-requests on the source pages. Under the derived
visibility rule they now *see* the Approvals inbox showing exactly those three
categories. This grants no new authority (they could already approve those); it just
surfaces the aggregator for someone who can act on it.

### 3. Enforcement — one central map, three call sites

A single map in `shared/` — `APPROVAL_CATEGORY_PERMISSION` (provider key →
permission key) — is the only place the category→permission relationship is defined.
There are **two** enforcement points (not three): the inbox has no separate action
route — its inline approve/decline buttons POST to the same per-category source routes,
so gating the source routes covers both the source pages and the inbox inline actions.

- **Inbox aggregation** (`src/lib/approvals/registry.js` + the six providers under
  `src/lib/approvals/providers/`): each provider gains a `permissionKey`. The registry's
  `getPendingApprovals` / `getPendingApprovalsCount` visibility filter gates each
  provider by `hasPermission(user, provider.permissionKey)` — one central gate replacing
  the six per-provider `canApproveAtActiveLocation(...)` role checks, which are then
  deleted from the providers.
- **Source routes** (the real mutation, shared by source pages *and* inbox inline
  actions): each category's approve/decline route swaps its hard-coded role check for
  `hasPermissionForLocation(user, <row>.location_id, APPROVAL_CATEGORY_PERMISSION[cat])`
  — the location-specific resolver, because these routes act on a row at a specific
  `location_id`. Routes and current checks:
  - Contractor invoices — `/api/invoices/[id]/approve` + `/decline` (master/owner-at-loc → 404)
  - Employee expenses — `/api/expenses/[id]/approve` + `/decline` (`canApprove`/`canDecline` helper → 403)
  - Agent requests — `/api/agent/membership-requests/[id]` PATCH (location-membership only → 404). **Per the agent-requests decision, this route is now fully gated on `approvals_agent_requests` (default manager+); plain staff lose the comms-page action.**
  - Time off — `/api/schedule/time-off/[id]` PUT (the `approved`/`rejected` branch's `MANAGER_ROLES` gate; the requester self-cancel path is left untouched)
  - Shift swaps — `/api/schedule/swaps/[id]` PUT via `resolveSwapTransition` in
    `src/lib/swap-lifecycle.js`; only the `approved` transition switches to the
    permission (via a new `canApprove` arg defaulting to the old `MANAGER_ROLES` check
    so existing callers/tests are unaffected). Claim/accept/reject-by-target stay as-is.
  - Roster approvals — `/api/schedule/rosters/[id]/approve` POST (owner-at-loc → 403)

### 4. Roles / Settings UI

In `src/components/RolePermissions.jsx`:

- The six toggles render **grouped under an "Approvals" subsection heading**, with a
  select-all / grant-all affordance (owner/master normally want all six).
- The single `approvals_inbox` per-role toggle is **removed** from the grant list; it
  lives on only as the location feature card on the location settings page.
- Existing "changed-from-default" amber-dot behaviour and sparse-diff storage work
  unchanged for the six new keys.

### 5. Migration

Forward-only, applied via Supabase MCP against un1t-crm (mig **378**). **Data-only**
(no schema change): strip the now-inert `approvals_inbox` key from the two grant blobs.

- `UPDATE profile_locations SET permissions = permissions - 'approvals_inbox'
  WHERE permissions ? 'approvals_inbox'`
- `UPDATE location_role_permissions SET permissions = permissions - 'approvals_inbox'
  WHERE permissions ? 'approvals_inbox'`
- `locations.features.approvals_inbox` is **left untouched** — it remains the location
  feature gate.

**Why strip, not expand:** as a *grant*, `approvals_inbox` only ever controlled who
could open the aggregator page — it never gated approve-ability (the source routes do).
The seeded role defaults already reproduce current approve-ability, and the derived
visibility rule reproduces current aggregator access for everyone holding a grant.
Expanding `approvals_inbox` into the six sub-keys would wrongly transfer aggregator-only
signal into approve-ability. The one edge it doesn't preserve — a manager explicitly
*denied* the aggregator via `approvals_inbox: false` will see it again once they hold a
default grant — has no security impact (they could always approve via the source pages)
and is accepted.

`approvals_inbox` stays in `WEB_PERMISSIONS` (so `WEB_PERMISSION_KEYS` still recognises
it as a valid location-feature key for `LocationFeatures` + the features route). The six
new keys are added to `WEB_PERMISSIONS` so `sanitizePermissionsBlob()` preserves them on
save.

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
- **Migration verification:** after applying mig 378, no row in
  `profile_locations.permissions` or `location_role_permissions.permissions` still
  contains an `approvals_inbox` key; `locations.features` rows are untouched.

## Rollout

Behaviour-preserving by construction: on deploy, seeded defaults reproduce current
access and the migration expands existing overrides, so no one's access changes until
an operator opens the per-location Roles tab and grants a category to someone new.
