# Approvals tidy-up: studio-clock times, Hatch quiet grant, card polish, support names

Date: 15 Nov 2026. Working name: APPROVALSQ.3. Follows #2361 and #2362.
Richard asked for these four together as one PR. The calls below are mine; he
has not reviewed this document.

## 1. Times on the studio's clock

Every date and time shown on `/settings/customer-agent/requests`
(`AgentRequestsClient.jsx`) and on the inbox approval card
(`ApprovalActionCard.jsx`) renders in the studio's zone, not the browser's:
`formatInZone` from `shared/zoned-time` with the active studio's `timezone`
(already in `CLIENT_LOCATION_COLUMNS`). All stamps in both files convert
together so none disagrees with its neighbour. The zone reaches each component
as a prop from its parent; a missing zone falls back to the platform zone
through the existing helper, never a hard-coded zone name.

## 2. Quiet trial grant at Hatch

"Mark granted, no confirmation email" stamps
`grant.confirmation_email = 'skipped_by_staff'` on the `trial_purchases` row.
The Stillorgan sweep already skips such buyers. The un1t.online sweep
(`src/lib/un1t-paid-trial-purchases.js`) now does too: before offering, it
reads the studio's `trial_purchases` rows granted inside the window that carry
the marker and skips those contacts (counted as `skipped_by_staff`). A failed
read of that list makes the run not ok and offers nobody that tick; the next
tick retries inside the 48 hour window, so no welcome is lost and none is sent
against staff's wishes.

## 3. Card polish

- Offer sale card: the price shows once (top right), not again in the summary.
- Mia card and inbox card: the decline note and the clear note are separate
  fields, so text typed in one does not appear in the other.
- Mia card: the main line (class and time, or the request summary) is back to
  normal text size and colour, as before the shared layout.

## 4. Platform and support names

`decided_by_name` shows "Support" when the decider's profile role is `master`,
unless the person viewing is themselves a master, who sees the real name.
Everyone else's name shows as before. The route reads `id, full_name, role`
and never returns the role.
