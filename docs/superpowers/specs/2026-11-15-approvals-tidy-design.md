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
together so none disagrees with its neighbour. The four customer cards on
`/approvals` (Mia, paid trial, corporate promo, offer sale) convert too. The zone reaches each component
as a prop from its parent; a missing zone falls back to the platform zone
through the existing helper, never a hard-coded zone name.

## 2. Quiet trial grant at Hatch — dropped

Built, reviewed, then removed. "Mark granted, no confirmation email" is only
offered on a paid trial whose grant needed a hand, and only the Glofox
(Stillorgan) processor produces those. A Hatch purchase is settled off
un1t.online's records and never reaches that card, so there is nothing at
Hatch for the welcome sweep to skip. If Hatch ever gets a paid review card,
this comes back with it.

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
