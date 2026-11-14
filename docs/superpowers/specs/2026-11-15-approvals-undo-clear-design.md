# Undo for a quiet clear

Date: 15 Nov 2026. Working name: APPROVALSQ.5. Richard queued this ("an undo
for a quiet clear"); the detail is mine and he has not reviewed it.

## Why

"Clear, don't notify" closes a Mia request for good. A mis-click, or the wrong
card ticked in a bulk clear, cannot be taken back: the request is `declined`
and every re-decision answers 409.

## What

For two minutes after a quiet clear, the person who cleared it can undo it.
The request goes back exactly as it was: `pending` if it was waiting, `failed`
(with its retry still offered) if it was a failed one. Nothing is sent to the
customer by a clear or by its undo.

### Server

`PATCH /api/agent/membership-requests/[id]`:

- The quiet clear additionally stores what it overwrote:
  `details.cleared.previous = { decided_by, decided_at, decision_note }`
  (all three as they were on the row before the clear; null for a pending
  row). The row read at the top of the route must select those columns.
- A new body `{ undo_clear: true }` (no `status`; the schema accepts either
  the existing decision body or this one, never both):
  - allowed only when the row is `declined`, has `details.cleared.silent`,
    was cleared by the caller (`decided_by` = the caller's id) and
    `decided_at` is at most 120 seconds ago; otherwise 409 with a plain
    reason ("This clear can no longer be undone.");
  - one compare-and-set update filtered on `id`, `status = 'declined'` and
    the row's `decided_at`: sets `status` to `details.cleared.from_status`,
    restores `decided_by`, `decided_at`, `decision_note` from
    `details.cleared.previous`, and removes `details.cleared`; a zero-row
    update is a 409;
  - sends nothing, reads nothing else, and returns
    `{ success: true, request, undone: true }`.
- The same permission check as the rest of the route applies before it.
- Mia and the MCP tools must never send `undo_clear` (extend
  `tests/agent-silent-clear-guard.test.js`).

### Web

- The Mia card on `/approvals`: after a quiet clear the outcome line reads
  "Cleared. The customer was not told." with an "Undo" button beside it for
  120 seconds, counting from the response. Undo restores the card to its
  buttons (waiting or failed, as it was) and the count goes back up by one.
  When the window has passed the button goes away. A failed undo shows the
  route's reason.
- Bulk clear: the result notice ("Cleared 6.") carries "Undo" for 120
  seconds. It sends the undo for each cleared id, one after another, then
  reloads; it reports "Restored <a>." and, if any failed, "<b> could not be
  restored."
- The cleared cards stay on the page for those two minutes (the Team list
  already keeps decided cards across reloads; the Customers list does the
  same for cleared Mia cards) so the Undo is still there after the focus
  reload.
- The inbox card and the requests history page get the same Undo on a card
  cleared in the current visit.

The phone is not changed in this PR.

## Must not happen

- An undo by anyone but the person who cleared it, or after the window.
- An undo of a normal decline (the customer was told; it cannot be untold).
- An undo putting a request into any state but the one it was cleared from.
- Anything sent to the customer, Glofox or un1t.online.
