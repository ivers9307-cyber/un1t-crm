# Approvals: Team and money as one list, decided in place

Date: 15 Nov 2026. Working name: APPROVALSQ.4. Richard approved the split
below on 15 Nov ("Yes, build it"); the detail is mine.

## What changes

The Team and money view on `/approvals` stops being a strip of tabs with rows
that link out. It becomes one list, like Customers: every pending item from
the ten team providers, oldest first, with filter chips in place of tabs, on
the shared card layout (`CustomerCardShell`).

## Decided in place (six)

Each card calls the SAME route, with the same body, as the page that decides
it today. No route's behaviour changes.

| Provider key | Approve | Decline | Extra |
|---|---|---|---|
| `fte_expenses` | POST `/api/expenses/[id]/approve` | POST `/api/expenses/[id]/decline` `{ reason }`, reason required | |
| `host_events` | POST `/api/events/[id]/review` `{ action: 'approve' }` | same route `{ action: 'reject', reason }`, reason required | card shows venue and price |
| `time_off_cancellations` | POST `/api/schedule/time-off/[id]/cancel-request` `{ decision: 'approve', note }` | same route `{ decision: 'reject', note }`, note optional | approve button reads "Cancel their leave"; decline reads "Keep their leave" |
| `contractor_invoices` | POST `/api/invoices/[id]/approve` | POST `/api/invoices/[id]/decline` `{ reason }`, reason required | the roster-versus-invoice check is loaded and shown on the card before Approve is enabled |
| `time_off` | PUT `/api/schedule/time-off/[id]` `{ status: 'approved' }` | same route `{ status: 'rejected', review_note }`, note optional | when approve returns clashes: "Keep them rostered" or "Unassign them" (POST `/[id]/unassign-clashes` `{ assignment_ids }`) |
| `shift_swaps` | PUT `/api/schedule/swaps/[id]` `{ status: 'approved' }` | same route `{ status: 'rejected', review_note }`, note optional | a 409 with code `swap_conflicts` offers "Approve anyway", re-sent with `confirm_conflicts: true` |

Rules for all six:

- Decline always opens a small panel (reason or note, Confirm, Back); it never
  fires from one click. Approve is one click, except "Cancel their leave",
  which asks "Cancel this approved leave?" first because it gives days back.
- One request per press. The route's own error text is shown on failure, and
  the card stays so the person can retry.
- After a decision the card shows what happened and leaves on the next
  reload, as the customer cards do; the badge drops at once.
- Every card keeps a link to its own page ("Open in <page>").

## Kept as a link (four)

`invoices_queue`, `rosters`, `issues`, `hyrox_sessions` appear in the same
list as cards with one button, "Open", going to the item's page. Deciding
them needs what only that page shows (Xero fields and VAT, per-month budget
figures and a publish to every coach, claim/resolve with photos, the workout
itself).

## Bug fixed on the way

`POST /api/events/[id]/review` checks only the global `user.role`, while the
provider shows host events to someone who is manager or owner at a studio by
per-location role. Such a person sees the item and is refused. The route's
check is brought in line with the provider's visibility rule (same roles,
judged the same way), and nothing wider.

## Must not happen

- Any change to what an existing decide route accepts or does (beyond the
  host-events permission fix).
- A decline from a single click, or two requests from one press.
- A contractor invoice approved before its roster check has loaded.
- A card for a provider the viewer cannot see (the list renders only what
  `/api/approvals/pending` returned).
- The phone app changing. This is web only.
