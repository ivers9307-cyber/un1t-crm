# NAV-BADGE.1 — the Approvals sidebar badge, scoped to the viewer's level

**Date:** 2026-09-08
**Status:** design approved, implementation not started
**Operator ask (Richard, 8 Sep):** *"I want it back for any sidebar item that has an actionable item for me and my level, and the same should apply for the head coach and their outstanding approvals for their level, and owner and manager."*

---

## Background

`HOME.3` retired eight per-item sidebar badges at once — invoices, approvals, churn/lead radar, issues, WhatsApp, email tickets, host events — on the reasoning that each was a separate poller duplicating a count the needs-attention queue on `/dashboard/today` already computes. It deleted the per-source count routes (`/api/approvals/count`, `/api/issues/count`, `/api/churn-radar/count`, `/api/lead-radar/count`, `/api/hosts/pending-events/count`) and left one poller against `/api/home-queue/count` driving only the browser tab title.

`MAIL-BADGE.1` (2 Sep) restored exactly one row — Messages — deliberately narrow: one row, two pollers, reading the hub's *own* endpoints so the sidebar and the tab strip can never disagree.

Today `Sidebar.jsx:230` hardcodes `badge={item.href === '/communications' ? messagesBadge : 0}`. Every other row is structurally incapable of showing a number, including Approvals, which at the time of writing has seven pending items (five time-off, two contractor invoices).

## Goals

1. The Approvals row shows a number when there is work **that viewer** can act on.
2. The scoping is per-role and per-location without restating any role logic — a head coach sees time off, shift swaps and hyrox sessions; an owner additionally sees contractor invoices, FTE expenses and rosters; master sees everything. All of it at the caller's **active location**, `host_events` excepted (see "What the scoping actually is").
3. Request cost does not regress against `HOME.3`.

## Non-goals

- **No badge on `/money`.** See "Why Money is out" — the invoices queue is already inside the Approvals count.
- Badges for Sales, Members, Operations, Team, Dashboard. None has a count query today; each would need a new query **and** a new role gate, and every new gate is a fresh chance to show someone a number that isn't theirs.
- **No badge registry, no aggregate map endpoint, no `poll-store` refactor.** With one source those are scaffolding for a second row that does not exist; build them when a real second source can shape them.
- Any change to Messages. See "Why Messages is untouched".
- New permission keys, migrations, or `shared/` changes. **No OTA.**

---

## Decisions taken during design

### A badge points at the surface that will *show* the item

A pending time-off request is reviewed on `/approvals` but belongs conceptually to the Team hub. It badges **Approvals**, because that is the page that will render it.

`home-queue.js` names the failure this avoids: *"a badge that reads lower than the queue actually holding is the 'click it, find nothing behind it' trap this estate has hit before."* The inverse is the same trap — a badge on a row whose page does not surface the item.

Consequence: all eleven approvals providers roll up into the single `/approvals` number.

### What the scoping actually is

Recorded because the first draft of this spec got it wrong twice, and the wrong version is intuitive enough to be written again:

- **Head coaches do not approve rosters.** `shared/permissions.js:452` sets `approvals_rosters: false` for `head_coach` — "head coach approves schedule items only". Their set is time off, shift swaps, hyrox sessions (plus agent requests and offer purchases). Owner and master hold rosters.
- **It is the ACTIVE location, not every location you hold a role at.** `registry.js`'s `APPROVALS-LOCATION-SCOPE` block says so explicitly, and marks `scheduleApproverLocationIds` (which does return every such location) as *kept for back-compat*. Ten of the eleven providers resolve `viewerActiveLocationId(user)` and filter `.eq('location_id', activeId)`. **`host_events` is the one org-wide provider.**
- **The pre-query gate is `isProviderVisible`**, which is `hasPermission(user, p.permissionKey)` plus `bundlesDenyCategory` — not a per-provider `isVisible()` hook. Only three providers (`invoices-queue`, `issues`, `host-events`) define one of those.

None of this is restated in the new endpoint. It is written down here so the next person does not have to rediscover it, and so a comment claiming otherwise gets caught in review.

### Why Money is out

The spec originally badged `/money` with the invoices queue. That was wrong, and finding out why is the most durable thing this design produced.

`invoices_queue` is **already an approvals provider** (`invoicesQueueProvider`, "Bookkeeper queue", `BOOKKEEPER-APPROVALS.1`), so it is already inside the Approvals count. A `/money` badge would have counted the same rows a second time — under a *different definition*:

| | `invoicesQueueProvider` | `/api/invoices-inbox/unread-count` |
|---|---|---|
| statuses | `received`, `quality_approved`, `extracted`, `data_approved` | `received`, `extracted` |
| permission | `bookkeeper` | `invoices_inbox` |
| scope | master: all locations; owner: their locations | active location only |

Two counters disagreeing about the same rows is exactly the failure this design set out to prevent. **Those two definitions already disagree with each other on `main` today** — that is a pre-existing inconsistency, left alone here rather than wired into the sidebar where it would become visible and load-bearing. Logged as a follow-up.

Related, and worth knowing before someone adds the next row: every provider carries its own `reviewBase` (`/invoices`, `/schedule/time-off`, `/issues`, …), so each item is reviewable in *two* places — inline on `/approvals`, or its source page. "Where it's reviewed" is therefore not a unique answer, and any future row that wants to badge a provider's source page must subtract it from the Approvals count rather than count it twice.

### Why Messages is untouched

`poll-store.js` dedupes **per URL**: `Sidebar.jsx` and `CommunicationsTabs.jsx` deliberately read the same two URLs (`/api/email/mail/count?scope=all`, `/api/whatsapp/unread-count`) so their numbers can never disagree, and the store collapses N readers of a URL into one visibility-gated request per cadence. Changing that gains nothing here and risks the guarantee.

### The tab title becomes the sum of the visible badges

Today `(N) Repset · …` is fed by `/api/home-queue/count` (approvals + mail needs-reply + inbox needs-action). It becomes `approvalsCount + messagesBadge` — the two numbers actually on screen — so the title and the pills can never disagree.

This is a small semantic change: the inbox half moves from `home-queue`'s `countInboxNeedsAction` to the sidebar's existing `/api/whatsapp/unread-count`. That is the point — the title now sums what is rendered rather than a parallel derivation of it.

`/api/home-queue/count` is **not** deleted, but be accurate about why: `/dashboard/today` is a server component calling `assembleHomeQueue(db, user)` directly and has never called that route. Once the sidebar stops polling it the route has **no callers in the app at all**. It stays because it is a published, OpenAPI-registered endpoint, not because something needs it — and that is worth writing down so nobody later "restores" a consumer it never had.

---

## Architecture

### Request cost

```
before:  home-queue/count  +  mail/count  +  whatsapp/unread-count   = 3 URLs
after:   approvals/count   +  mail/count  +  whatsapp/unread-count   = 3 URLs
```

Flat. `HOME.3`'s objection was eight pollers; this is a one-for-one swap.

### `GET /api/approvals/count`

Restores the route `HOME.3` deleted. Delegates to `getPendingApprovalsCount(db, user)` and answers the `{ success, data: { count } }` envelope that `poll-store.js`'s `fetchCount` already consumes — so no client-side machinery changes at all.

```js
export const GET = withAuth(
  { permission: null, location: false },
  async ({ user, db }) => {
    const count = await getPendingApprovalsCount(db, user)
    return NextResponse.json({ success: true, data: { count } })
  }
)
```

Same posture as its sibling `home-queue/count`: any authenticated session may call it, and a user with no approver authority gets a small answer cheaply — `getPendingApprovalsCount` applies each provider's own `isVisible` **before** running its query, so a staff session runs almost nothing.

**The gate is not restated here, and that is the whole point.** `getPendingApprovalsCount` fans out over the eleven providers applying **each provider's own** `isVisible` and role scoping. The badge is definitionally what the `/approvals` page will show, because it is the same function the page's own count uses. Head coach, manager, owner and master scoping all come for free and cannot drift.

Register in `src/lib/openapi.js` like every other route.

### Client

One additional `usePolledCount` in `Sidebar.jsx`. No new hook, no `poll-store` change.

```js
const approvalsBadge = usePolledCount({
  enabled: !!user,
  url: '/api/approvals/count',
})
```

**`enabled: !!user`, not a permission check.** A client-side `hasPermission` gate would be checking a *different* key than the eleven providers check (`approvals_inbox`, the nav row's key, versus each provider's own `approvals_*`), so it could hide a badge for work the caller really has. The endpoint self-gates and answers 0 cheaply — `isProviderVisible` runs before any query, so a staff session makes zero database calls.

The `homeQueueCount` poller is removed from `Sidebar.jsx` — the title no longer needs it.

### Rendering

`nav-items.js` has **zero** `children:` entries — the HUBS collapse removed them all — so this is top-level rows only. `Sidebar.jsx:230` becomes a lookup instead of a hardcoded special case:

```jsx
badge={NAV_BADGES[item.href] ?? 0}
// where NAV_BADGES = { '/communications': messagesBadge, '/approvals': approvalsBadge }
```

The pill itself is unchanged: `bg-amber-500/10 text-amber-700` (already satisfies the repo's chip-contrast rule), hidden at zero, `99+` cap, `data-testid="nav-badge"`.

One addition inside the code being touched: the pill gains an `aria-label` (`"7 items need your attention"`). Today a screen reader announces "Approvals 7", which could be a count of anything.

Tab title: `approvalsBadge + messagesBadge`.

---

## Testing

| file | proves |
|---|---|
| `src/app/api/approvals/count/route.test.js` | 401 unauthenticated; delegates to `getPendingApprovalsCount` with the service-role client and the user; returns the `{ success, data: { count } }` envelope |
| `src/components/Sidebar.test.jsx` | the Approvals row badges independently of Messages; **two** rows can badge at once (the existing tests use singular `getByTestId('nav-badge')` and will throw once a second pill renders — they must move to `getAllByTestId`); title equals the sum of the visible pills; zero renders no pill; `99+` cap |

🔴 **jsdom cannot see layout.** This estate has already shipped a toggle that did nothing behind a green suite. Badge *presence* is DOM and jsdom judges it fine, but whether two pills sit correctly at the ends of their rows without overlapping their labels it cannot. Verify the rendered sidebar in the browser preview before calling the work done — a green `npm test` is not sufficient evidence here.

## Rollout

Server + web only. No migration, no `shared/` change, no OTA. Single PR.

## Known limitations

- **A failing approvals provider silently lowers the badge.** `getPendingApprovalsCount` sums with `Promise.allSettled` and scores a rejected provider as `0`, so one broken provider under-counts with no signal. This is pre-existing and unchanged — it is exactly the number the browser tab title already shows today. Fixing it means giving that function a `{ count, degraded }` contract, which also touches `home-queue.js`; out of scope here, logged below.

## Follow-ups (not in this build)

- Reconcile the two invoices-queue definitions (`invoicesQueueProvider`'s four statuses / `bookkeeper` vs `/api/invoices-inbox/unread-count`'s two / `invoices_inbox`). They disagree on `main` today.
- `/api/invoices-inbox/unread-count`'s header still claims it drives *"the red badge on the sidebar /invoices item"* — a badge `HOME.3` deleted, on a row `HUBS.2c` folded into `/money`. Stale comment on a live endpoint.
- Give `getPendingApprovalsCount` a `{ count, degraded }` contract so a failing provider degrades visibly instead of under-counting.
- Badges for Sales, Members, Operations, Team, Dashboard — each needs a gated count query first, and must subtract from Approvals anything it double-counts.
