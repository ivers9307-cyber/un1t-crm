# Phase 2C — Money Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Third hub via the proven recipe (templates in-tree: `(members)/layout.js`, `/members/page.js` + tests, the 2B nav collapse). Two firsts: a **badged tab** (Invoices — `HubTabs`' `badgeUrl` gets its first real use) and a **Sidebar.jsx edit** (the `/invoices` badge re-keys to `/money` so the count survives the collapse until the phase-3 Home queue replaces sidebar badges).

**Scope note:** regroup only. The spec's deeper Money merge (contractor invoices/expenses out of `/schedule`, `/settings/billing` boundaries) is phase 4 — NOT this PR. `/offer-sales` joins the hub (it was sidebar-orphaned; adding `approvals_offer_purchases` to the entry union is a deliberate visibility ADD, noted in comments).

**Branch:** `git fetch && git worktree add -b hubs-2c-money ../un1t-crm-2c origin/main` (main ≥ 7f0e1bf6, the 2B merge), `npm ci`, baseline `npm test`.

**Verified page gates (2026-08-15, mirror these in tabs + index):** `/accounting` → `accounting_hub` (bounces to `/dashboard`); `/invoices` → `invoices_inbox` (multi-location via `hasPermissionForLocation`); `/card-receipts` → `card_receipts`; `/orders` → `MANAGER_ROLES` AND `orders` (tab uses `orders` only — the old sidebar entry had the same overshow; same-or-better); `/offer-sales` → `approvals_offer_purchases` (bounces to `/dashboard`).

---

### Task 1: `/money` index (TDD — mirror `src/app/members/page.test.js` incl. the `allDenied` base and a tier-1 location-gate case)

`src/app/money/page.js` (literal, outside the group):

```js
  if (hasPermission(user, 'accounting_hub')) redirect('/accounting')
  if (hasPermission(user, 'invoices_inbox')) redirect('/invoices')
  if (hasPermission(user, 'card_receipts')) redirect('/card-receipts')
  if (hasPermission(user, 'orders')) redirect('/orders')
  if (hasPermission(user, 'approvals_offer_purchases')) redirect('/offer-sales')
  redirect('/')
```

(+ signed-out → `/login`, `force-dynamic`, hub-pattern header comment.) Tests (8): signed-out; all→/accounting; accounting denied→/invoices; only card_receipts; only orders; only approvals_offer_purchases; none→/; location-gate `features:{accounting_hub:false}` all granted → /invoices. NOTE: `approvals_offer_purchases` may sit in `APPROVAL_SUBPERMISSION_KEYS` (exempt from location gating) — check `shared/permissions.js` and, if so, say so in a test comment and don't use it for the location-gate case. Commit.

### Task 2: `(money)` route group

```bash
mkdir "src/app/(money)"
git mv src/app/accounting src/app/invoices src/app/card-receipts src/app/orders src/app/offer-sales "src/app/(money)/"
```

`src/app/(money)/layout.js` — mirror `(members)/layout.js` exactly; TABS:

```js
const TABS = [
  { id: 'overview', label: 'Overview',      href: '/accounting',    perms: ['accounting_hub'] },
  { id: 'invoices', label: 'Invoices',      href: '/invoices',      perms: ['invoices_inbox'], badgeUrl: '/api/invoices-inbox/unread-count' },
  { id: 'receipts', label: 'Card receipts', href: '/card-receipts', perms: ['card_receipts'] },
  { id: 'orders',   label: 'Orders',        href: '/orders',        perms: ['orders'] },
  { id: 'offers',   label: 'Offer sales',   href: '/offer-sales',   perms: ['approvals_offer_purchases'] },
]
```

The filter/map must PRESERVE `badgeUrl` (strip only `perms` — the `(members)` template already does this correctly via rest-spread). Header comment: first badged tab; badge dedupe rationale (same endpoint + poller as the sidebar count, so the two can never disagree — CommunicationsTabs precedent). Verify each moved page's signed-out handling (all five are server pages — read the gate lines; report any surprise). `npm test` + `npm run build` (route list unchanged; `/money` present). Commit.

### Task 3: Sidebar collapse + badge re-key (TDD)

- `src/lib/nav-items.test.js` first: money membership → `['/money']`; new entry assertion mirroring 2B:
  `anyPermission: ['accounting_hub', 'invoices_inbox', 'card_receipts', 'orders', 'approvals_offer_purchases']`, `extraActivePaths: ['/accounting', '/invoices', '/card-receipts', '/orders', '/offer-sales']`.
- `src/lib/nav-items.js`: new `/money` entry (icon: an unused lucide, e.g. `Wallet`), section `money`; DELETE the four standalone entries; comments folded forward per precedent, including: the visibility-ADD note for `approvals_offer_purchases`; the `/orders` role-AND-perm overshow note (pre-existing).
- **`src/components/Sidebar.jsx` line ~129**: re-key the invoices badge `'/invoices': invoicesPendingCount` → `'/money': invoicesPendingCount`, with a comment (HUBS.2c — the hub entry carries the invoices count until the phase-3 Home queue retires sidebar badges; the tab inside the hub shows the same count from the same endpoint). The `titleBadgeCount` sum (line ~150) uses the variable directly — untouched.
- Run nav + palette + comms-ia-labels + full suite. Palette keeps `/invoices`, `/orders` entries; NO `/money` palette entry. Commit.

### Task 4: Finalize

Full CI mirror + `npm run build` + CHANGELOG (`HUBS.2c`, next number; the two firsts; the scope note that phase-4 owns the deep merge) + push + PR `"HUBS.2c — Money hub"` with preview-QA notes: Money entry badge shows the invoices count; Invoices TAB badge shows the same number; both disappear for non-`invoices_inbox` users; tabs on all five pages; `/money` lands per permission order. Standard footer. Then final whole-branch review (cross-task seams: badge dedupe, the orders overshow, offer-sales visibility add).
