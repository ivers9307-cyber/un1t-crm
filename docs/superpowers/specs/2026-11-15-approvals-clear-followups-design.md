# Approvals follow-ups: phone quiet clear, clear several at once, who and when

Date: 15 Nov 2026. Working name: APPROVALSQ.2. Follows APPROVALSQ.1 (#2361).
Richard asked for these three together as one PR. The calls below are mine
unless marked; he has not reviewed this document.

## 1. Who cleared it and when

- `GET /api/agent/membership-requests` (both queries) also returns
  `decided_by_name` for each decided row: the route reads `decided_by`, looks
  the names up in ONE `profiles` read by id with named columns (`id,
  full_name`), and never returns the id-to-profile row itself. A failed name
  read leaves `decided_by_name` null and is logged; it never fails the list.
- `/settings/customer-agent/requests` shows, on every decided row, the status
  label followed by "by <name>, <date time>" (or just the date when the name
  is unknown). A quietly cleared row reads "Cleared, customer not told · by
  Sarah, 14 Nov 2026, 16:20".
- The inbox card shows the same line on a cleared request.

## 2. Clear several at once (web, Customers view)

- A "Select" button on the Customers view puts a checkbox on every Mia card
  that can still be cleared (waiting or failed, no outcome yet). Paid trials,
  corporate promos and offer sales are never selectable.
- A bar shows "<n> selected", "Select all", "Clear, don't notify" and
  "Cancel".
- "Clear, don't notify" opens ONE confirm: how many will be cleared, an
  optional note applied to all, and, when any selected card is a waiting class
  or consultation booking, "Mia told <k> of these customers the team would
  confirm. Clearing sends them nothing."
- Confirming sends the existing PATCH (`status: 'declined', silent: true`)
  once per request, one after another. No new route: each request keeps the
  route's own permission check and race handling.
- When it finishes the bar reports "Cleared <a>." plus, when any failed,
  "<b> could not be cleared (already decided, or an error)." and the list
  reloads. A request that fails stays in the list.
- One run at a time; the confirm button cannot fire twice.

## 3. Phone

- The staff app's Customers tab: each Mia card (waiting and failed) gets a
  "Clear" action. It opens the existing bottom sheet in a clear mode: title
  "Clear, don't notify", the booking warning when it applies, an optional
  note, and a confirm. Nothing is sent from a single tap.
- `decideApproval(requestId, status, decisionNote, { silent })` passes
  `silent: true` through.
- The in-thread card (`ThreadApprovalCard`) shows a cleared request as
  "Cleared, customer not told", offers no "Send explanation" step for it, and
  offers the same clear on a pending request.
- Merging publishes an update to phones.

## Must not happen

- A clear from a single tap or click, anywhere.
- A bulk clear touching anything but Mia requests.
- Anything in this PR sending a message, or reaching Glofox or un1t.online.
- `profiles` rows or columns beyond the name reaching a browser or phone.
