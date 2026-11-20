# RAFFLE.1 — digital raffle for a charity event

Date: 2026-11-20. Status: approved 2026-11-20 — Richard chose "build the
minimum today" for the charity day on Sat 21 Nov 2026 (see Phasing).

## Phasing (Richard, 20 Nov)

The charity day is 21 Nov 2026, the day after this design, so it ships in two
parts.

**Phase 1 (for 21 Nov):** create the raffle on the event (name, price);
Sell (search name/email/phone, guest with name + email, quantity, cash/card,
atomic numbering); ticket email; sales list with totals and void (managers);
Draw with prize names, winners list, "not claimed" (managers) and a
full-screen view. A paper roll stays at the till as a backup.

**Phase 2 (after):** Raffle tickets card on the contact profile, CSV export,
resend button, editable email subject/intro (Phase 1 uses fixed default copy
plus the event's branding), the line on the donations page, "this email
belongs to a contact — link?" at guest entry, sales-closed switch.

**Settled after the builder check (my calls):** raffle money is its own total
and is never added to or matched with donations; anyone with `races` at the
event's studio sells and draws, only `MANAGER_ROLES` void a sale or mark a
draw not claimed; contact search covers contacts at studios the staff member
can access (the existing contacts-list rule), not the whole organisation; the
draw is pressed on the device showing the TV view (no realtime sync); a guest
with no `contact_id` is gated on Postmark suppressions for their address only.

## Intent

At the charity day, raffle tickets are sold in person. Today that means paper
stubs and a drum. Instead, a staff member takes the money as usual, then on a
tablet picks the buyer, chooses how many tickets and submits. The buyer is
emailed their ticket numbers. At draw time the app picks a ticket at random and
shows the number and the name, prize by prize, and keeps the list of winners.

The first use is the **MS Ireland X UN1T Dublin Charity Day** (Stillorgan,
`race_events`, `charity_enabled = true`). The feature hangs off charity events
in general, so a later event can run a raffle too.

## Goals

- Sell tickets fast at a till on a tablet browser: find the buyer, pick a
  quantity, record how they paid, submit.
- Find the buyer by **name, email or phone** in one search box.
- A buyer who is already a CRM contact has the tickets **linked to their
  profile**, so staff can look them up later.
- A buyer who is not in the CRM is a **guest**: name and email only, stored
  with the raffle sale. **No contact is created.**
- Every buyer gets an email listing their ticket numbers.
- Several prizes, drawn one at a time, fairly and at random, with a recorded
  list of winners.
- A full-screen draw view that can go on the gym TV.
- Raffle takings visible on the event beside its donations.

## Non-goals

- Taking payment. Money is taken in person (cash or the card terminal) as
  today; the CRM only records which.
- Online ticket sales on the public event page.
- The staff phone app.
- Anything to do with the lottery permit; the charity handles that.

## Anti-goals (a failure even if it works)

- **The raffle must not touch sales.** A sale never creates a contact, never
  changes a contact's pipeline stage, tags, lead source or any field that
  routes, triggers sequences, provisions Glofox, sends a "New lead" push or
  starts a trial. The only link to a profile is the sale's `contact_id`.
- A guest never becomes a contact, lead or audience member. Their email is
  used only for their ticket email.
- A draw that is not genuinely random, can pick a voided or already-drawn
  ticket, or can be quietly redone.
- Two tablets selling at once handing out the same ticket number.

## Constraints (from CLAUDE.md and docs/rules)

- New `/api` routes use `withAuth`; they run on the service role, so every
  query is scoped in code. The event's studio is judged with
  `assertLocationAccessOr404` and `hasPermissionForLocation(user,
  event.location_id, 'races')`, the same gate as
  `/api/events/[id]/donations`. A detail route answers 404, never 403.
- New tables are service-role only: RLS on, `revoke all` from anon,
  authenticated and public, no policy (as `donations`, mig 765).
- Migration applied with Supabase MCP to `iyvtbjjxdggiadzwwvdj` before the
  code deploys; security advisor afterwards. Next free number at the time of
  writing is 863; check after syncing main.
- The ticket email is administrative: gate it with
  `checkTransactionalConsent` (bounced/complained only; unsubscribing from
  marketing does not stop it). Send through `sendTransactionalEmail`,
  branded with `getLocationBranding` / `resolveEventEmail`, send-once like
  `src/lib/donation-receipt.js`.
- Customer-facing copy is operator-editable: the email subject and intro are
  raffle settings with sensible defaults.
- `.ilike()` values go through `escapeLikePattern()`; writes are checked
  (`checkedWrite()` or destructured `error`).
- Every non-submit `<button>` in a form has `type="button"`.
- UI from `@/components/ui`, light-theme `un1t-*` tokens.

## Approaches considered

1. **A Raffle tab on the charity event (chosen by Richard).** Sell, Tickets and
   Draw screens under the event, opened in the tablet's browser. Reuses the
   event's studio, `races` permission and email branding, and puts the
   takings next to the donations. Works for any future event.
2. **A separate Raffles page.** Same screens on their own menu item. Loses the
   event's permissions and studio setup, and the takings sit apart from the
   donation totals.
3. **In the staff phone app.** Ruled out: the app cannot reuse `src/lib`
   email and lookup code, every change ships as an OTA, and a tablet browser
   does the job.

## What was decided

### Finding the buyer (Richard)

One search box matching name, email or phone. Results show name, phone and
email so staff pick the right person. If nobody matches, **Add as guest**:
name and email (both required). The guest is stored on the sale only.

### Linking to existing contacts (Richard)

A sale for an existing contact stores `contact_id` and nothing on the contact
changes. The contact profile gains a read-only **Raffle tickets** card listing
each raffle, its ticket numbers and any win.

### Email (Richard)

On submit the buyer gets an email with their ticket numbers. Address: the
guest's email, or the contact's email on file. *(My call:)* if an existing
contact has no email, staff can type one at the till; it is stored on the sale
only and is not written to the contact.

### Draws (Richard)

- Several prizes.
- A drawn ticket is out of later draws.
- The same person can win again with a different ticket.
- Each draw is recorded with its prize name, giving a list of winners.

### Behaviour that is my call (Richard can correct)

- **One raffle per event**, created from the event's raffle tab with a name,
  a ticket price (cents) and the email subject/intro. Sales can be switched
  off ("Sales closed") without deleting anything.
- **Ticket numbers** are sequential per raffle from 1 and shown padded
  (#001). Numbers are assigned atomically in the database (a single
  `security definer` function, service-role only, that locks the raffle row
  and hands out the next block), so two tablets can sell at once.
- **The sale** records quantity, total (price × quantity, snapshotted),
  payment method (`cash` | `card`), who sold it and when.
- **Voiding** a sale (a mistake at the till) needs a reason and voids all its
  tickets. A sale with a drawn ticket cannot be voided. Voided tickets keep
  their numbers (no reuse) and drop out of the draw and the totals.
- **The draw** picks one ticket uniformly at random, server-side, with
  `crypto.randomInt`, from the raffle's tickets that are not voided and not
  already drawn. It records the prize name, ticket, who drew it and when.
  A draw is never deleted. If a winner can't be reached or declines, staff
  mark that draw **not claimed** (with a note) and draw again for the same
  prize; the unclaimed ticket stays out.
- **Contact search** covers contacts at the studios the staff member can
  access (the contacts-list rule; see "Settled after the builder check"). Up
  to 20 results. Phone matches on digits, ignoring spaces and the +353/0 prefix.
- **Takings** on the event: total raised, number of tickets, cash and card
  split, shown on the raffle tab and as one line on the event's donations
  page. A CSV export of sales for the charity hand-over, like the donations
  CSV.
- **Resend email** button per sale; the email's status (sent, suppressed,
  failed) shows on the sale.
- **Draw screen** is a full-screen page for a signed-in staff device (e.g. a
  laptop connected to the TV, or the tablet cast to it): big ticket number,
  buyer's first name and last initial, prize name. It is not a public page.

## Screens

```
Raffle — MS Ireland X UN1T Dublin Charity Day        €5 a ticket · Sales open
[ Sell ]  [ Tickets ]  [ Draw ]

SELL
  Search name, email or phone  [ sarah            ]
    Sarah Byrne   087 123 4567   sarah@…     [Select]
    Sarah Kelly   —              s.kelly@…   [Select]
    [ + Add as guest ]
  Tickets  [ − ]  3  [ + ]      = €15
  Paid by  ( Cash ) ( Card )
  [ Sell 3 tickets ]   → "Done: #041–#043 sent to sarah@…"

TICKETS
  Search…    Raised €1,240 · 248 tickets · cash €700 / card €540   [CSV]
  #041–#043  Sarah Byrne  card  10:42  sent      [Resend] [Void]

DRAW
  Prize [ Hamper from …      ]  [ Draw ]
  Winners: 1. Hamper — #117 Mark D.   2. Voucher — #009 Aoife K. (not claimed) …
```

## Data (outline; the builder finalises)

- `raffles`: id, race_event_id (unique), location_id, name, ticket_price_cents,
  currency, sales_open, email_subject, email_intro, next_ticket_number,
  created_by, timestamps.
- `raffle_sales`: id, raffle_id, location_id, contact_id (nullable), buyer_name,
  buyer_email, quantity, total_cents, payment_method, sold_by, voided_at,
  voided_by, void_reason, email_status, email_sent_at, created_at.
- `raffle_tickets`: id, raffle_id, sale_id, ticket_number (unique per raffle),
  voided (or derived from the sale).
- `raffle_draws`: id, raffle_id, prize_name, ticket_id, drawn_by, drawn_at,
  unclaimed_at, unclaimed_note.

All service-role only. The sale is written in one database call (the numbering
function inserts the sale and its tickets together), and the email is sent
afterwards; a failed email never fails the sale.

## Left to the builder

- Exact table, column and route names; whether tickets carry their own
  voided flag or derive it from the sale.
- Where the Raffle tab link sits on the event pages (next to Donations).
- Email layout, within the event email shell.
- Test plan; at minimum: numbering under concurrent sales, draw never picks a
  voided or drawn ticket, a sale never writes to `contacts`, the access gate
  (another studio's event is a 404), and the email consent gate.

## RAFFLE.3 — online sales on the event page (Richard, 20 Nov)

For people who can't come on the day. The charity day raffle is drawn **Mon
23 Nov 2026 at 2pm**; online sales close **1:30pm Monday** (30 minutes before),
so there is the weekend to sell.

- **Event page:** a Raffle card beside the donate card when the raffle's
  "Online sales" switch is on: the same option buttons as the till (online
  purchases capped at 50 tickets), name and email, then the card checkout
  the donations use (ClassFunnelCheckout). After the closing time the card
  says sales have closed.
- **Payment:** Revolut only (UN1T events; a third-party host event shows no
  card). A new `raffle_orders` row per checkout (awaiting_payment → paid |
  failed | expired). Tickets are numbered only once the payment is confirmed,
  by `issue_raffle_order_tickets(order)` (idempotent, ignores the sales
  switch: the money was taken), at the amount actually paid. The confirmation
  comes from the status poll, the existing Revolut donations webhook (which
  already receives every order event; unknown donation refs fall through to
  raffle orders) and a new `raffle_order` reconcile domain.
- **Email:** the same ticket email, sent once (a compare-and-set claim on the
  order), listing every number.
- **No contacts.** Unlike donations, a paid raffle order never links or creates
  a contact, tag, consent or timeline event.
- **Staff:** online sales show in Sales as "Online · card"; online winners show
  their email in the winners list. Refunds are done in Revolut and the sale is
  voided in the CRM (Phase 2 may join these up).
- **Settings:** an Online sales switch and a closing date + time (the studio's
  clock, `@/lib/location-time`).
