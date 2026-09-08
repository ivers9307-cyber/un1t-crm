# NAV-BADGE.1 — per-item sidebar badges, scoped to the viewer's level

**Date:** 2026-09-08
**Status:** design approved, implementation not started
**Operator ask (Richard, 8 Sep):** *"I want it back for any sidebar item that has an actionable item for me and my level, and the same should apply for the head coach and their outstanding approvals for their level, and owner and manager."*

---

## Background

`HOME.3` retired eight per-item sidebar badges at once — invoices, approvals, churn/lead radar, issues, WhatsApp, email tickets, host events — on the reasoning that each was a separate poller duplicating a count the needs-attention queue on `/dashboard/today` already computes. It deleted the per-source count routes (`/api/approvals/count`, `/api/issues/count`, `/api/churn-radar/count`, `/api/lead-radar/count`, `/api/hosts/pending-events/count`) and left one poller against `/api/home-queue/count` driving only the browser tab title.

`MAIL-BADGE.1` (2 Sep) restored exactly one row — Messages — deliberately narrow: one row, two pollers, reading the hub's *own* endpoints so the sidebar and the tab strip can never disagree.

Today `Sidebar.jsx` hardcodes `badge={item.href === '/communications' ? messagesBadge : 0}`. Every other row is structurally incapable of showing a number, including Approvals, which at the time of writing has seven pending items (five time-off, two contractor invoices).

## Goals

1. A sidebar row shows a number when there is work **that viewer** can act on.
2. The scoping is per-role and per-location without restating any role logic — a head coach sees rosters and shift swaps at their locations, an owner sees contractor invoices and FTE expenses, master sees everything.
3. Request cost does not regress against `HOME.3`.
4. Adding a further row later is a one-entry registration, not a new subsystem.

## Non-goals

- Badges for Sales, Members, Operations, Team, Dashboard. None has a count query today; each would need a new query **and** a new role gate, and every new gate is a fresh chance to show someone a number that isn't theirs. The registry makes each a later one-entry addition once "actionable" is defined for that hub.
- Any change to Messages. See "Why Messages is untouched".
- New permission keys, migrations, or `shared/` changes. **No OTA.**

---

## Decisions taken during design

### A badge points at the surface that will *show* the item

A pending time-off request is reviewed on `/approvals` but belongs conceptually to the Team hub. It badges **Approvals**, because that is the page that will render it.

`home-queue.js` names the failure this avoids: *"a badge that reads lower than the queue actually holding is the 'click it, find nothing behind it' trap this estate has hit before."* The inverse is the same trap — a badge on a row whose page does not surface the item. Mapping by *where it is reviewed* rather than *where it conceptually belongs* means no number appears twice and every badge is clickable to the thing it counts.

Consequence: all ten approvals providers roll up into the single `/approvals` number.

### Scope: rows with trustworthy counts

| row | source | count query |
|---|---|---|
| `/approvals` | all ten approvals providers | `getPendingApprovalsCount` (existing) |
| `/money` | invoices queue awaiting action | extracted from `/api/invoices-inbox/unread-count` (existing) |
| `/communications` | mail needs-reply + WA/IG needs-action | **unchanged**, existing two pollers |

### The tab title becomes the sum of every badge

Today `(N) Repset · …` is fed by `home-queue/count` (approvals + mail + inbox). Once `/money` badges, that number and the sidebar would disagree — the "two counters disagree about the same row" failure `home-queue.js` exists to prevent. The title becomes the sum of the badges actually on screen.

---

## Architecture

### Why Messages is untouched

`poll-store.js` dedupes **per URL**: `Sidebar.jsx` and `CommunicationsTabs.jsx` deliberately read the same two URLs (`/api/email/mail/count?scope=all`, `/api/whatsapp/unread-count`) so their numbers can never disagree, and the store collapses N readers of a URL into one visibility-gated request per cadence.

Folding Messages into a new aggregate endpoint would leave the tab strip polling the old two while the sidebar polled a third — more requests, and MAIL-BADGE.1's guarantee broken. So Messages keeps its existing pollers, and the new endpoint covers Approvals and Money only:

```
before:  home-queue/count  +  mail/count  +  whatsapp/unread-count   = 3 URLs
after:   nav-badges        +  mail/count  +  whatsapp/unread-count   = 3 URLs
```

Flat request cost, two badges gained. `/api/home-queue/count` stays where it is, serving `/dashboard/today`; the sidebar simply stops being one of its consumers.

### `src/lib/nav-badges/registry.js`

Modelled on `src/lib/approvals/registry.js`, the pattern this codebase already tests and extends.

```js
export const NAV_BADGE_SOURCES = [
  {
    navHref: '/approvals',
    key: 'approvals',
    isVisible: (user) => hasPermission(user, 'approvals_inbox'),
    count: (db, user) => getPendingApprovalsCount(db, user),
  },
  {
    navHref: '/money',
    key: 'invoices',
    isVisible: (user) => hasPermissionForLocation(user, viewerActiveLocationId(user), 'invoices_inbox'),
    count: (db, user) => countInvoicesAwaitingAction(db, user),
  },
]

export async function getNavBadgeCounts(db, user) // → { counts, degraded }
```

**Two rules the registry enforces.**

1. **No source computes its own gate.** Every `count` delegates to the query that already backs its surface. `getPendingApprovalsCount` fans out over the ten providers applying **each provider's own** `isVisible` — so the per-role, per-location scoping is not restated here and cannot drift from what `/approvals` renders. The badge is definitionally what the page will show, because it is the same function.

   `isVisible` on the source is a cheap pre-filter only: it decides whether to *run* the query at all, mirroring the row's own sidebar permission so a user who cannot see the row never pays for its count. It is never the authority on which rows come back — the count function is.

2. **The invoices count moves to a shared helper.** It is inline in `/api/invoices-inbox/unread-count` today, whose header still claims it drives *"the red badge on the sidebar /invoices item"* — a badge `HOME.3` deleted, on a row `HUBS.2c` folded into `/money`. Extract the query to `src/lib/invoices-inbox/count.js`; both the route and the registry call it; fix the stale comment. One behaviour change: the badge lands on `/money`, where the queue now lives.

### `GET /api/nav-badges`

`withAuth({ permission: null, location: false })` — same posture as `home-queue/count`: any authenticated session may call it, and a user with no approver authority gets a small answer cheaply.

```json
{ "success": true,
  "data": { "counts": { "/approvals": 7, "/money": 2 }, "degraded": [] } }
```

**Absent ≠ zero.** A source the viewer cannot see is omitted from the map entirely. A source they *can* see with nothing pending sends an explicit `0`. A source that threw is omitted **and** listed in `degraded`. Registered in `src/lib/openapi.js` like every other route.

**Failure posture.** `Promise.allSettled` per source; one bad source degrades one row and never blanks the sidebar — the same posture `getPendingApprovals` already takes for a failing provider.

This is deliberately *better* than the `EMAIL-TICKET-CLEANUP.2` precedent, which made `home-queue/count` answer **500** on a failed tickets lookup. That endpoint had no choice: a bare sum has no per-source field in which to be honest, so it could not distinguish "this excludes tickets, which we could not check" from "nothing to do". This endpoint has both `counts` and `degraded`, so it stays 200 and says which row is stale.

**No `total` from the server.** The title must equal the sum of the visible pills. If the server sent its own total, a degraded source would make the title and the pills disagree — exactly the failure being designed around. The client sums the map it is rendering.

### Client

`src/components/use-nav-badges.js` — `useNavBadges()`, subscribing through the **same** `poll-store`, inheriting its refcount teardown, visibility gating and the 🔴 module-state-survives-sign-out eviction that file documents at length. No second caching mechanism.

**Merge, don't replace.** Each response merges into the existing map, so a degraded source shows its last good number rather than falling to `0`. A blip reads as slightly stale, never as a false all-clear — the same contract `usePolledCount` already honours for a non-ok response.

**Supporting change to `poll-store.js`.** Its fetcher hardcodes `j.data?.count || 0`, so it can only carry a single number. Move that extraction up into `usePolledCount` (where it belongs) and leave the store returning `j.data`, payload-agnostic. `usePolledCount`'s public contract is unchanged — still a number, still `0` while disabled. This is a shared module with its own test file; the regression risk is real and is pinned by test.

### Rendering

`nav-items.js` has **zero** `children:` entries — the HUBS collapse removed them all — so this is top-level rows only. [`Sidebar.jsx:230`](../../../src/components/Sidebar.jsx) becomes a map lookup instead of a hardcoded special case:

```jsx
badge={item.href === '/communications' ? messagesBadge : (navBadges[item.href] || 0)}
```

The pill itself is unchanged: `bg-amber-500/10 text-amber-700` (already satisfies the repo's chip-contrast rule), hidden at zero, `99+` cap, `data-testid="nav-badge"`.

One addition inside the code being touched: the pill gains an `aria-label` (`"7 items need your attention"`). Today a screen reader announces "Approvals 7", which could be a count of anything.

Tab title: `sum(mergedCounts) + messagesBadge`.

---

## Testing

| file | proves |
|---|---|
| `src/lib/nav-badges/registry.test.js` | `isVisible` for master / owner / manager / head_coach / staff; that `count` **delegates** rather than re-deriving (spy on `getPendingApprovalsCount`); `degraded` populated when a source throws |
| `src/app/api/nav-badges/route.test.js` | absent vs explicit `0` vs `degraded`; one throwing source degrades one row while the others still answer; 401 unauthenticated |
| `src/lib/invoices-inbox/count.test.js` | the extracted query returns the same rows the route returned before (`received` + `extracted` only) |
| `src/components/poll-store.test.js` | existing count consumers behave identically after the extraction moves up into the hook |
| `src/components/Sidebar.test.jsx` | correct row badges; a degraded response keeps the last good number instead of falling to `0`; title equals the sum of the visible pills |

🔴 **jsdom cannot see layout.** This estate has already shipped a toggle that did nothing behind a green suite. Badge *presence* is DOM and jsdom judges it fine, but whether the pill sits at the end of the row without overlapping the label it cannot. Verify the rendered sidebar in the browser preview before calling the work done — a green `npm test` is not sufficient evidence here.

## Rollout

Server + web only. No migration, no `shared/` change, no OTA. Single PR.

## Follow-ups (not in this build)

- Badges for Sales, Members, Operations, Team, Dashboard — one registry entry each, once someone defines what "actionable" means for that hub and provides a gated count query.
- Folding Messages into the aggregate endpoint would need `CommunicationsTabs` to read per-source detail (mail needs-reply and inbox needs-action are separate tabs) from the same payload. Worth doing only if a third consumer of those counts appears.
