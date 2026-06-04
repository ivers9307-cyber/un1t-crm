# Mobile Approvals Inbox — port the web `/approvals` dashboard

**Date:** 2026-06-04 · **Surface:** Expo iOS app (`mobile/`) · **Status:** design approved, ready for plan

## Goal

A unified mobile **Approvals** inbox where a manager clears pending approvals across four categories — **time-off**, **shift swaps**, **FTE expenses**, **contractor invoices** — in one place, with Approve / Decline. Ports the web APPROVALS.1 `/approvals` dashboard to mobile.

## Key finding — almost no backend needed

The web approvals system is already mobile-shaped:

- **`GET /api/approvals/pending`** → `{ success, data: { providers: [ { key, label, reviewBase, count, items:[ApprovalItem] } ], total } }`. Each provider is **role- and active-location-scoped server-side** (a head_coach's response simply omits the owner-only categories). It's service-role, so item titles already carry names.
- **`ApprovalItem`** is uniform across categories: `{ id, title, subtitle, meta, submittedAt, amount, currency, reviewUrl }` — already formatted (e.g. time-off `subtitle` = "Holiday · 2026-06-01 → 2026-06-02 (2 days)"; expense `subtitle` = "May 2026 · 3 items", `amount` = total, `currency` = 'EUR').
- Approve/Decline routes all exist, and **three of four already have mobile helpers**:

| Category (provider `key`) | Approve route | Decline route | Mobile helper |
|---|---|---|---|
| `time_off` | `PUT /api/schedule/time-off/[id]` `{status:'approved'}` | same `{status:'rejected', review_note?}` | `respondToTimeOff(id,status,note,locationId)` ✓ |
| `shift_swaps` | `PUT /api/schedule/swaps/[id]` `{status:'approved'}` | same `{status:'rejected', review_note?}` | `respondToSwap(id,status,note,locationId)` ✓ |
| `fte_expenses` | `POST /api/expenses/[id]/approve` (no body) | `POST /api/expenses/[id]/decline` `{reason}` **(required)** | `approveExpenseClaim(id)` / `declineExpenseClaim(id,reason)` ✓ |
| `contractor_invoices` | `POST /api/invoices/[id]/approve` (no body) | `POST /api/invoices/[id]/decline` `{reason}` **(required)** | **missing → add** `approveInvoice(id)` / `declineInvoice(id,reason)` |

**Role gates:** time-off + swaps = `MANAGER_ROLES` (manager/head_coach/owner/master); expenses + contractor invoices = **owner/master only**. All active-location-scoped. The mobile screen needs **no client-side role logic** — it renders whatever the aggregator returns for the viewer.

## Decisions (user-approved)

1. **The Inbox owns approvals.** Remove the time-off/swap approvals from the schedule **Manage** mode (shipped #375); Manage reverts to pure roster editing. The Inbox is the single home for approving.
2. **Approve finance items from summary.** Expenses + contractor invoices show claimant / period / amount / item-count; the owner approves on that (matches the existing owner-first-pass → bookkeeper-reviews-PDF flow). **No PDF/receipt viewer in v1.**

## Approach — sectioned inbox, uniform card

A manager-only **"Approvals" tile in the More tab** (with a pending-count badge) → a new `mobile/app/approvals.jsx` screen. The screen calls `getPendingApprovals()`, **filters to the four categories**, and renders a **labelled section per non-empty category**, each item a single **uniform `ApprovalCard`**. Sectioning mirrors the web grouping and adapts to the viewer for free (server omits categories they can't approve).

The uniform `ApprovalItem` lets one card render every category — no per-type variants. This **supersedes** the schedule-specific `ApprovalCard` (which read raw rows); that file is deleted once Manage no longer uses it.

## UI

**More tab.** A new tile **Approvals** (icon `checkmark-done-outline`) gated on `canMobile(profile, 'approvals', activeLocation)`, badge = the count of the four mobile categories (so badge always matches the inbox). → `router.push('/approvals')`.

**Approvals screen** (`mobile/app/approvals.jsx`):
- `<Stack.Screen>` with `BackHeaderLeft label="More" fallbackHref="/(tabs)/more"`.
- Loads `getPendingApprovals({ locationId: activeLocation.id })` on mount / focus / pull-to-refresh.
- For each non-empty mobile category (in order: time-off, swaps, expenses, invoices): a section header `Label (N)` then its `ApprovalCard`s.
- Empty → "No pending approvals." Error → red banner.

**`ApprovalCard`** (`mobile/components/approvals/ApprovalCard.jsx`, new — uniform): avatar-less; `title` (bold) · `subtitle` · `meta` location chip · `amount` line when present (`€1,234.00`). **Approve** (one tap) + **Decline** buttons; `busy` spinner while the action is in flight.

**`DeclineSheet`** (`mobile/components/approvals/DeclineSheet.jsx`, new): a bottom-sheet modal with a reason `TextInput` + Confirm. `requireReason` (true for expenses/invoices) disables Confirm until non-empty; optional for time-off/swaps.

## Data flow

- **`mobile/lib/approvals-api.js`** (new): `getPendingApprovals({ locationId })` → `api('/api/approvals/pending', { locationId })`. Passing `locationId` sets the `x-active-location` header so the providers scope to the active studio (they read `getCurrentUser().activeLocation` server-side; there's no `location_id` query param).
- **`mobile/lib/approvals.js`** (new, pure, unit-tested): `MOBILE_APPROVAL_KEYS = ['time_off','shift_swaps','fte_expenses','contractor_invoices']`; `mobileApprovalSections(providers)` → the four providers (in fixed order) that have ≥1 item; `approvalsBadgeCount(providers)` → sum of the four counts.
- **`mobile/lib/invoices-api.js`** (modify): add `approveInvoice(id)` (`POST /api/invoices/[id]/approve`) and `declineInvoice(id, reason)` (`POST /api/invoices/[id]/decline` `{reason}`).
- Reuse `respondToTimeOff`/`respondToSwap` (schedule-api) and `approveExpenseClaim`/`declineExpenseClaim` (expenses-api).

**Approve / decline dispatch** keyed on the provider `key`:

```js
const APPROVE = {
  time_off:            (id) => respondToTimeOff(id, 'approved', null, locationId),
  shift_swaps:         (id) => respondToSwap(id, 'approved', null, locationId),
  fte_expenses:        (id) => approveExpenseClaim(id),
  contractor_invoices: (id) => approveInvoice(id),
}
const DECLINE = {
  time_off:            (id, reason) => respondToTimeOff(id, 'rejected', reason, locationId),
  shift_swaps:         (id, reason) => respondToSwap(id, 'rejected', reason, locationId),
  fte_expenses:        (id, reason) => declineExpenseClaim(id, reason),
  contractor_invoices: (id, reason) => declineInvoice(id, reason),
}
const REASON_REQUIRED = new Set(['fte_expenses', 'contractor_invoices'])
```

After any action, refetch `getPendingApprovals()` (item leaves the list). Surface any `warning`/`warnings` from the expense/invoice approve as a non-blocking `Alert` (e.g. Xero-forward enqueue failed) — the approval still succeeded.

## Slim Manage mode

In `mobile/components/schedule/ManageMode.jsx`: remove the **Pending approvals** section (the collapsible + `ApprovalCard` rendering), the `getPendingTimeOff` + `getOpenSwaps` fetches from `load()`, the `decideTimeOff`/`decideSwap` handlers, and the `ApprovalCard`/`respondTo*` imports. Manage now fetches **only** blocks and renders the day's editor. `getPendingTimeOff`/`getOpenSwaps` in `schedule-api.js` become unused → delete them (the Inbox uses the aggregator). `respondToTimeOff`/`respondToSwap` stay (the Inbox uses them).

## Permissions

Add a `approvals` entry to **`MOBILE_PERMISSIONS`** in `shared/permissions.js` with `webEquivalent: 'approvals_inbox'`, label "Approvals", and a default in `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`: **on** for owner/manager/head_coach/master, **off** for staff. Remove `approvals_inbox` from `WEB_ONLY_OK` in `scripts/check-mobile-parity.mjs` (it now has a mobile counterpart) — keeps `check:mobile-parity` green. The `approvals` permission gates the **tile**; per-category approve rights stay enforced by the routes.

## Edge cases

- **Role-scoped categories** auto-hide (server returns empty for categories the viewer can't approve) — no client gating.
- **Decline reason** required for `fte_expenses`/`contractor_invoices` (route 400s without it) — `DeclineSheet` enforces non-empty.
- **Active-location scope:** switching location re-fetches a different set.
- **Impersonation:** the inbox reflects the effective user's scope (consistent with the app).
- **Refetch, not optimistic:** after each action, reload; pending set is small.
- **Badge consistency:** the More tile badge is computed from the same `getPendingApprovals()` four-category total, so it always matches the inbox.

## Testing

- `mobile/lib/approvals.test.js` (vitest — `mobile/lib/**` in config): `mobileApprovalSections` (filters to the four keys, drops empties, fixed order) + `approvalsBadgeCount` (sums the four, ignores other providers).
- CI mirror: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports` (parity stays green via the permission swap; the new import guard validates the new cross-module imports).
- `cd mobile && npx expo export --platform ios` — bundle compiles.
- On-device: a manager sees time-off/swaps; an owner additionally sees expenses/invoices; approve + decline (with required reason for finance); Manage mode no longer shows approvals; non-manager has no Approvals tile.

## Files

| File | Change |
|---|---|
| `mobile/lib/approvals.js` + `.test.js` | **new** — pure `mobileApprovalSections` + `approvalsBadgeCount` |
| `mobile/lib/approvals-api.js` | **new** — `getPendingApprovals()` |
| `mobile/lib/invoices-api.js` | add `approveInvoice` / `declineInvoice` |
| `mobile/components/approvals/ApprovalCard.jsx` | **new** — uniform-shape card |
| `mobile/components/approvals/DeclineSheet.jsx` | **new** — reason modal |
| `mobile/app/approvals.jsx` | **new** — the inbox screen |
| `mobile/components/schedule/ApprovalCard.jsx` | **delete** — superseded |
| `mobile/components/schedule/ManageMode.jsx` | remove the approvals section |
| `mobile/lib/schedule-api.js` | delete now-unused `getPendingTimeOff` / `getOpenSwaps` |
| `mobile/app/(tabs)/more.jsx` | add the **Approvals** tile + badge |
| `shared/permissions.js` | add `approvals` mobile permission + defaults |
| `scripts/check-mobile-parity.mjs` | drop `approvals_inbox` from `WEB_ONLY_OK` |

No web-app, schema, or API-route changes.

## Out of scope (v1)

PDF/receipt viewing for finance items; the other approval providers (issues triage, bookkeeper queue, roster drafts); Android-specific polish; a standalone count endpoint (the badge derives from the pending fetch).
