# Approvals: one customer queue, and clearing without telling the customer

Date: 14 Nov 2026. Working name: APPROVALSQ.1.

## Why

Richard clears Mia's hand-offs and failed membership or trial requests on
`/approvals` and finds it disjointed: the same kind of job is split over
several tabs, each with its own card and buttons, and some cards cannot be
cleared at all. He also wants to clear a request without the customer being
messaged ("Decline with no notification").

What the code does today:

- `/approvals` is up to 14 tabs, one per provider in
  `src/lib/approvals/registry.js`. Four of them are customer work: Agent
  requests, Paid trials, Corporate promos (each with its own card component)
  and Offer sales (a link out to `/offer-sales`).
- A failed Mia request offers only "Fixed it — retry". The PATCH route
  (`src/app/api/agent/membership-requests/[id]/route.js`) refuses a decline on
  anything but `pending`, so the card stays until the class starts or 48 hours
  pass (`retryOffered`, `src/lib/agent/request-recovery.js`).
- Every decline of a request with a conversation sends the decline notice
  in-thread (route line ~908, "a decline is never silence"), and an
  email-delivered pause or cancellation decline is emailed.
- The phone app already groups this work as a "Customers" tab
  (`mobile/lib/approvals.js`); the web does not.

## Goals

1. On the web, all customer items at the active studio are one list with one
   card layout and one button row.
2. Any Mia request that is waiting or failed can be cleared without a
   message to the customer.
3. The list can reach zero.

## Not in this round

- The staff and finance tabs (time off, swaps, rosters, invoices, expenses,
  issues, Hyrox, host events). They stay as tabs, unchanged. Folding them into
  the same list is a later round.
- Showing more than the active studio at once.
- Selecting several cards and clearing them together.
- New permissions. Each card keeps the permission its tab has today.

## Must not happen

- A quiet clear must never send anything: no WhatsApp, no email, no push to
  the customer, and nothing to Glofox or un1t.online.
- A quiet clear must never be the default or sit where Decline sits today. A
  mis-click that leaves a customer waiting is the failure this could cause.
- The existing "decline and tell them" behaviour must not change.
- Counts must stay honest: the sidebar badge, the dashboard queue and the
  phone widget count the same rows as before, minus cleared ones.

## Approaches considered

- **A. Button only.** Add the quiet clear to Mia cards, keep the tabs. Small,
  fixes the stuck cards, leaves the page feeling like four pages.
- **B. One customer queue (chosen by Richard, 14 Nov).** Merge the four
  customer tabs into one list on the web, one card layout, quiet clear
  included. Staff and finance tabs untouched.
- **C. Everything in one list.** All 14 categories decided in place. The end
  state, but 11 categories only link out today and each needs its own in-place
  actions. Later round.

## Design

### The page

`/approvals` gets two top-level views, matching the phone:

- **Customers** (default when it has anything): one list.
- **Team and money**: today's remaining tabs, exactly as now.

```
Approvals                                         7 pending   [refresh]
[ Customers 5 ]  [ Team and money 2 ]

Show: (All 5) (Mia requests 3) (Paid trials 1) (Corporate promos 0) (Offer sales 1)

NEEDS FIXING
┌──────────────────────────────────────────────────────────────────────┐
│ MIA · Book class · FAILED     Jane Murphy          Submitted 13 Nov  │
│ HIIT · Sat 15 Nov 09:00                                              │
│ What went wrong: no credits left on the account.                     │
│ jane@…  087…                                Open conversation · History │
│ [Fixed it, retry]   [Decline and tell them]   [Clear, don't notify]  │
└──────────────────────────────────────────────────────────────────────┘
WAITING
┌──────────────────────────────────────────────────────────────────────┐
│ PAID TRIAL · GRANT FAILED     Tom Byrne   €39.00        Paid 12 Nov  │
│ …                                                                    │
│ [Retry grant]   [Mark granted in Glofox]   [Mark granted, no email]  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Order.** "Needs fixing" first (failed Mia executions), then everything
  else. Within each group: items with a class or event start time, soonest
  first; then the rest, oldest first. (Builder's call to reuse the phone's
  `sortByUrgency` rule if it fits.)
- **Filter chips** narrow the one list; they are not separate pages. A chip
  whose provider the viewer cannot see is not shown.
- **One card shell.** A shared layout component: header line (source chip,
  kind, state chip, name, date, amount when there is one), summary, the
  "why" line, contact details, links, outcome line, then the button row.
  `AgentRequestDecideCard`, `TrialPurchaseReviewCard` and `CorpPromoClaimCard`
  are rebuilt on it, keeping every fact and warning each shows today.
- **Offer sales** gets a card in the list with "Mark fulfilled" (the existing
  `POST /api/offer-purchases/[id]/fulfil`) and a link to `/offer-sales`.
- **Button row, same order on every card:** the main action first (Approve,
  Retry, Mark granted, Mark handled, Mark fulfilled), then "Decline and tell
  them" where a decline exists, then "Clear, don't notify" where it applies,
  set apart at the end and styled as the quietest button.
- After any action the card shows its outcome line and drops out on the next
  refresh, as today.
- The data comes from the existing `/api/approvals/pending`; the page merges
  the four providers' items client-side. The registry and its counts do not
  change shape.

### Clear, don't notify

On a **Mia request** (`agent_membership_requests`):

- Offered when the row is `pending` or `failed`. The route accepts it on any
  `failed` row, not only the ones the list still shows for retry: it is a
  deliberate staff action and sends nothing.
- Not offered on a row stuck at `approved` mid-execution. That booking may
  have gone through, so recording a decline blind would be wrong; those rows
  keep retry only and stay on `/settings/customer-agent/requests` as today.
  (My call, after the reviewer's check.)
- Pressing it opens a small confirm with an optional note. If the request is
  a waiting class or consultation booking, the confirm says: "Mia told this
  customer the team would confirm. Clearing sends them nothing."
- The PATCH route accepts `{ status: 'declined', silent: true }`. It claims
  the row atomically on its current status (same compare-and-set as the
  retry claims, so two people cannot both act), writes `declined`, the
  decider, the time, the note, and `details.cleared = { silent: true,
  from_status }`, and skips every send. A decline today does no other
  bookkeeping (it leaves any linked `class_booking_requests` row as it is),
  and the quiet clear does the same. It returns `customer_notified: { sent: false, reason: 'cleared' }`.
- No new status and no migration: it is a decline that told nobody, and
  everything that already reads `declined` keeps working. (My call. A
  separate `dismissed` status would need a constraint change and a sweep of
  every reader for no gain Richard asked for.)
- History (`/settings/customer-agent/requests`) and the inbox card show it as
  "Cleared, customer not told" with who and when.
- The same button is added to the request cards on
  `/settings/customer-agent/requests` and the inbox approval card
  (`ApprovalActionCard`), since they share the route. A plain decline of a
  failed row stays refused: on a failed row the only two choices are retry or
  quiet clear, because a decline notice days later is noise (the existing
  rule).
- On the inbox card a quiet clear skips the decline draft prefilled into the
  composer and the AI follow-up suggestion that a normal decline fetches.
- Who may do it: whoever may decline that request today (the route's
  `approvals_agent_requests` gate).

On a **paid trial whose grant needs a hand** (`trial_purchases` at
`needs_review`, money taken) — decided by Richard, 14 Nov: "sorted by hand".

- The quiet button on this card is **"Mark granted, no email"**. It is for
  when staff have put the plan on in Glofox themselves and do not want the
  confirmation email sent.
- `POST /api/trial-purchases/[id]/review` accepts
  `{ action: 'resolve', notify: false }`. It does exactly what `resolve` does
  today (status `granted`, `granted_at`, the grant record) and skips
  `sendTrialPurchaseEmail`. The response says `emailed: false`.
- Because the row lands on `granted`, the buyer keeps their place on the €39
  board, cannot buy the trial again, and their own status page shows the
  trial as granted. Nothing else that reads the row changes.
- There is no "clear without granting" for a paid trial in this round. A
  refunded or abandoned purchase is a separate case to design if it comes up.

Paid-trial help cards and corporate promo cards already clear quietly with
"Mark handled"; they keep that as their main action and get no extra button.
Offer sales keeps "Mark fulfilled" only; that route emails the buyer that
their purchase is ready, so the button says so.

### Phone

Second PR, after the web one is live:

- The Customers tab's decline sheet for a Mia request gets a second choice,
  "Clear, don't notify", sending the same `silent: true`.
- Failed cards on the phone get the same quiet clear beside retry.
- Paid trials, corporate promos and offer sales still have no phone surface.

This PR touches `mobile/` and `shared/`, so merging it publishes an update to
phones.

## Constraints the builder must respect

- Service-role routes: keep the location check on every route touched.
- `check:guardrails`: destructure `error` on every write; typed buttons inside
  forms; `-700` text on chips.
- Register the changed request bodies in `src/lib/openapi.js`.
- Mia must not be able to send `silent: true`; it is a staff-session field on
  the PATCH route only.
- Tests: the route (quiet clear from pending and failed; refused on a stuck row; sends nothing;
  loses a race cleanly), the merged list's order and filters, each card's
  button row, and that a quiet-cleared row leaves the count.

## Left to the builder

- Component and file names, and whether the shell is one component with slots
  or a small set of parts.
- Exact wording of chips and outcome lines, in plain language.

## Calls made here that Richard has not confirmed

1. Quiet clear is stored as a decline with a "cleared" marker, not a new
   status.
2. (Settled by Richard: a paid trial gets "Mark granted, no email".)
3. A failed Mia row offers retry or quiet clear, never a notified decline.
4. Offer sales joins the list with "Mark fulfilled" in place.
5. Phone follows as a second PR.
