# Charity day: a donation section on the event page

Design, 24 Oct 2026. Richard's decisions are marked "Richard"; everything else is the designer's call unless it says "builder".

## Why

UN1T Dublin runs a charity event every year. This year it is the MS Ireland x UN1T Dublin Charity Day, Saturday 21 November 2026 at Stillorgan (`/event/stillorgan-nov21-0900`, already set up and published): teams of 2 or 4, seven waves from 08:00 to 12:30, 20 team spots, €50 a head matched by a corporate partner. The team side already works end to end in the CRM: wave picker, per-seat capture, Revolut checkout, confirmation email, race-day panel.

What is missing is the other half of a charity day: people who are not racing but want to give. Today there is nowhere on the page to do that, so money that would come in by card at the moment someone reads the page is lost, or arrives as cash on the day and has to be reconciled by hand.

## What Richard asked for (Richard)

1. A charity page to collect donations.
2. The charity events are events as well, so the page has two sections: a donation section, and a team event registration with a few waves.
3. Donations go into UN1T's own Revolut account. UN1T matches them, with no cap, and sends the total on to the charity. The page never sends a donor to the charity's own fundraising site.
4. The 21 November event page is the reference for what the event side looks like.
5. The two options sit side by side under the hero with an "OR" between them (from the mockups, 24 Oct).
6. The team side offers a "find me a team" option for people who do not have one, listed first among the team-size choices.

## Goals

- Someone reading the event page can give any amount by card in under a minute and gets a receipt.
- The team registration with waves stays exactly as it is.
- Every euro, from entries and from donations, is in one place for the hand-over to the charity: a list, a total, a CSV.
- Next year's charity day needs no developer: an operator switches the donation section on for an event and edits every word and amount.
- Donation money lands in the same account the event's entries land in, under the same provider rules.

## Non-goals

- No donor wall or public list of names. Donations are private to the donor and the staff.
- No recurring or monthly giving. One payment per donation.
- No button that moves money back. A donation is refunded, if ever, in the Revolut (or Stripe) dashboard by a person. The CRM only records it (see Money): Stripe reports a refund, Revolut never does, so for Revolut a staff member records it by hand.
- No automatic cut-off. Donations stay open until the operator switches the section off (after the hand-over to the charity, say). Nothing closes them on the event date or when registration closes.
- No tax-relief paperwork (CHY3 and the like). The donor gives to UN1T Dublin, not to the charity, so there is nothing to certify. The receipt says so.
- No per-team fundraising pages, no sponsor-a-team.
- No automatic matchmaking of solos. Staff place them by hand from the Teams page (section 6b); the page only collects the "find me a team" intent and the payment.
- No `orders` ledger row for a donation in this change. The `orders` table holds only race entries and car deposits today; offers, class bookings and trial purchases never joined it. Adding the four at once is a separate piece of work.
- No donations through the host portal (`/host/events/[id]/edit`) in this change: the charity settings are edited in the operator CRM only. The money still goes to the host's connected account if the event is a host event (see Money).

## Anti-goals (a failure even if it works)

- Taking a donation the page can never confirm: a checkout handed out with no row behind it, or a paid order no path ever marks paid.
- Telling a donor "thank you" and never sending the receipt, or sending it twice to half the donors and never to the rest.
- A raised total that counts the same money twice (an entry and a donation, or a refunded donation).
- A donation that goes to a different account from the event's entries.
- Any customer-facing word that lives only in code.

## Constraints the builder must respect

**The event page.** `/event/[slug]` is `src/app/event/[slug]/page.js` rendering `src/components/RaceSignupWidget.jsx` (1,194 lines; kind-aware through `KIND_COPY`). It is already on all four public-path allowlists (`src/proxy.js`, `AppShell`, `src/lib/brands.js`, `src/lib/tenant-domains-edge.js`), as are `/api/public/` and `/api/webhooks/`. Nothing in this design adds a public path. The public events read (`src/app/api/public/events/[slug]/route.js`) deliberately never exposes capacity numbers; the charity totals below are a separate, opt-in exposure.

**The operator event pages.** There is no `/events/[id]` detail page with tabs: `src/app/(members)/events/[id]/` holds `edit/` and `teams/`, and the list at `src/app/(members)/events/page.js` links each row to Public, Teams (or Attendees), Check in, Race day, QR and Edit. The donations list below is a new page in that family, reached from a new row link.

**Money.** Entry fees go through `createRacePayment` (`src/lib/race-payments.js`): `resolvePaymentProvider(host)` (`src/lib/event-hosts.js`) picks `revolut` for UN1T's own events (the shared UN1T merchant) and `stripe_connect` for a third-party host's event (their connected account, `hostCanTakePayments`), and `paymentsFor(provider).createPayment(...)` (`src/lib/payments/index.js`) opens the order. The paid trial (`src/lib/trial-purchase-payments.js`, `POST /api/public/trial-purchases`, `GET /api/public/trial-purchases/[id]`) is the closest shape to a donation: a row inserted `awaiting_payment`, a provider order stamped on it, an inline checkout (`src/components/landing-page/ClassFunnelCheckout.jsx`, which takes a `statusPath`), a status route that re-checks the provider under a rate cap so the page finishes before the webhook lands, and a separate signed Revolut webhook route per domain (`src/app/api/webhooks/revolut/{race-payments,class-bookings,offer-payments}`), each with its own `REVOLUT_*_WEBHOOK_SECRET` falling back to the shared one, deduped through `recordWebhookEvent` with its own `WEBHOOK_PROVIDERS` key. Those keys are bound by a DB CHECK on `webhook_events.provider` (mig 505 added `revolut_offer`), so a new key needs a migration line. The Stripe side is one route, `src/app/api/webhooks/stripe/route.js`, which the builder extends for the donation domain the way it handles the existing domains; its `charge.refunded` handling resolves only `race_payments` today and needs a `donations` lookup too. `createPayment` needs a `returnUrl` even for an embedded Revolut checkout. `ClassFunnelCheckout` stops polling the moment the Revolut SDK reports success, so the thank-you state must keep polling the status route until the server has recorded `paid` (as `PaidTrialFunnel`'s done step does); otherwise, with the webhook URL not yet registered, nothing server-side would ever mark the donation paid.

**Revolut never reports a refund.** There is no refund webhook and no `refunded` order state: a refund mints a NEW order of type `refund` and the original stays `completed` (`src/app/api/webhooks/revolut/route.js` records this), and `paymentsFor('revolut').getPayment` only lowercases the order state. So a Revolut refund can only reach the CRM by a person recording it.

**Contacts and consent.** A public buyer becomes a contact through `findOrCreateRaceContact` (`src/lib/race-contact-linking.js`), never a blind insert (`contacts_email_org_unique`, mig 712). Marketing consent is written only through the consent helpers that log to `consent_log` (`src/lib/marketing-consent.js`), the way the signup widget's tick does. The receipt is ADMINISTRATIVE (transactional) and sent regardless of marketing consent. The email identity is the event's (`resolveEventCommsLocation`, as `race-confirmations.js` uses). A send-once stamp is written AFTER the send: there is no lease column, and a duplicate receipt beats a lost one (CLAUDE.md, BAREWRITE).

**Data rules.** A new table is closed to every client session (mig 677 default; state `REVOKE ALL … FROM anon, authenticated`), RLS on with no policy, service role only. `race_events` has had no client privilege since mig 682 (the `race_events_location_scoped` policy is gone), so the new columns need no grant, only the `-- column-grant: withheld` note. Every `.select()` column must exist in a migration (`check:select-columns`). Every write destructures `error`. `check:location-scoping` wants the donate route and the staff list scoped by the event's location; the public status poll is exempted there on the basis that it carries no donor PII, so it must return none (no name, no email).

**Timezones.** A donation's `paid_at` is an instant; the staff list renders it in the event location's zone through `@/lib/location-time`.

## The design

### 1. The page

The charity page IS the event page. An event with the charity section switched on renders, top to bottom (Richard, from the mockup on 24 Oct):

1. The existing hero (event name, date, studio, status pill).
2. **A "raised so far" strip** under the hero, when the operator has switched the total on: the matched total, a progress bar when a goal is set, donor and team counts.
3. **The two options side by side, with an "OR" between them.** Left, **Donate**: heading, a line about where the money goes, the amount chips, name and email, the optional message, the consent tick, the Donate button and the match line. Right, **Register your team**: the existing signup card (wave picker, team name, team size, seats, promo code, consent, pay), unchanged inside. A vertical rule with an "OR" badge separates the two so a visitor reads them as alternatives.
4. **About the day**: the event description, full width, below the cards.

The hero's call to action and the existing mobile sticky action bar keep pointing at registration. The donate card has its own button. On a phone the cards stack, Donate first, with the OR rule turning horizontal between them.

An event with the charity section switched off renders exactly as today: no band, no extra API fields, no new copy.

### 2. The donation flow

**Amount.** Chips with the operator's preset amounts (default €10, €25, €50, €100) and, when the operator allows it, an "Other" chip that opens a number field. The server enforces the operator's minimum and maximum (defaults €5 and €5,000) against the cents it receives; the client only mirrors them. The amount the server charges is the amount the client sent, validated against the event's own settings, never a price looked up from a client-named product.

**Details.** Name (required), email (required), an optional message (280 characters, shown to staff only), and the marketing opt-in tick with the same consent copy the signup widget uses, off by default. No phone, no address.

**Pay.** Donate opens the embedded checkout in the card (`ClassFunnelCheckout` with `statusPath = '/api/public/donations'`), the same widget the paid trial uses. On completion the card becomes the thank-you state: the thank-you title and body (operator copy; the default says "Your €25 becomes €50 for MS Ireland" when a match is on, and "Thank you for your €25 donation to MS Ireland" when it is not) and a line saying a receipt is on its way. The raised total on the band re-reads after a paid donation.

**Return.** `createPayment` gets `returnUrl = /event/[slug]?donation=<id>`. The page, on that query, mounts the card in its confirming state and polls the status route (the offers and trial pattern), so a provider that redirects (Stripe) comes back to a page that finishes the story. `&cancelled=1` reopens the form with the amount kept.

**Rate limit.** The donate route is capped per IP like the register route (the builder picks the same numbers). The status poll is capped per donation like the trial poll (20 per 5 minutes).

### 3. Money

A donation is charged through the same provider as the event's entries: `resolvePaymentProvider(host)` and `paymentsFor(provider)`, with the host's `connectedAccountId` for a Stripe Connect host event, `applicationFeeCents: 0`. The statement description is "{brand}: Donation to {charity name}" where brand is the event location's `getLocationBranding` company name. The idempotency key is the donation id.

Statuses on the row: `awaiting_payment → paid | failed | expired`, and `paid → refunded`. For Stripe, `refunded` comes from the `charge.refunded` webhook. For Revolut it comes from a person: the donations list has a **Mark as refunded** action (manager+) that records a refund already made in the Revolut dashboard, stamping `refunded_at` and who recorded it. It moves no money. A refunded donation leaves the totals.

`markDonationPaymentStatus` is idempotent: a paid row stays paid, a terminal failure stays terminal, and either path that learns of the payment (the signed webhook, or the status route's provider re-check) may call it. The once-only side effects (contact, tag, consent, receipt) are NOT keyed on which call flipped the row: each is keyed on its own null stamp (`contact_id`, `receipt_email_sent_at`) and attempted on every observation of `paid`, so a receipt that failed to send after the flip is retried by the next webhook delivery or poll rather than lost (the BAREWRITE lesson). A duplicate beats a loss.

A Revolut-paid donation is confirmed by `POST /api/webhooks/revolut/donations`: signature verified against `REVOLUT_DONATION_WEBHOOK_SECRET`, falling back to `REVOLUT_WEBHOOK_SECRET` until Richard registers the new URL in the Revolut dashboard (an operator step, after deploy; the page works before it through the status route's re-check). Deduped through `recordWebhookEvent` with a new `WEBHOOK_PROVIDERS.REVOLUT_DONATION`. Returns 200 for anything it does not recognise. A Stripe-paid donation is confirmed by the existing Stripe webhook route, which the builder teaches to route a `domain: 'un1t_donation'` order to `markDonationPaymentStatus`.

### 4. Totals and matching

The operator sets a **match multiplier** on the event (1 = no match; 2 = doubled) and a **match label** ("Matched by our corporate partner"). There is no cap on the match (Richard), so the multiplier applies to every euro. The multiplier is snapshotted onto each donation row at the moment it is paid, so changing it later never rewrites history; the public total is computed from the snapshots.

`raised_cents` = sum over paid, unrefunded donations of `amount_cents × match_multiplier`, plus, when the operator ticks **include entries**, the sum of the event's completed `race_payments` amounts × the event's current multiplier. One pure function, `computeCharityTotals({ donations, entries, multiplier, includeEntries })`, unit-tested, owns this. The public events read adds it under `charity` only when the section is on and **show total** is ticked; the count of donors goes with it. A goal (optional) turns the total into a progress bar.

### 5. Receipt and contact

When a donation becomes paid, once:

1. The donor becomes a contact at the event's location through `findOrCreateRaceContact` (name and email; a miss at this studio resolves across the organisation the way the signup does). A failed contact step is logged and never blocks the receipt.
2. A timeline note on the contact: "Donated €25 to MS Ireland (MS Ireland x UN1T Dublin Charity Day)". The contact gets the tag `donor` through the existing tag helpers.
3. The marketing tick, when set, is recorded through the consent helper with `consent_log`, source `donation`.
4. The receipt email, ADMINISTRATIVE, from the event's comms identity: subject and intro operator-editable; body states the amount, the match line when a match is on, that UN1T Dublin passes every donation, matched, to the charity after the event, and that this is not a charity tax receipt. `receipt_email_sent_at` is stamped after the send.

Everything the donor reads (the band heading and blurb, chip labels, the consent line, the thank-you title and body, the receipt subject and intro, the match label) is a field on the event's charity settings with a default; defaults live in one module (`src/lib/charity-donations.js`) and a resolver merges the saved settings over them. The receipt follows the event emails' own pattern of an editable subject and intro over a fixed body (the gap receipt in `race-confirmations.js`, edited through `EventEmailFields` with `showTemplate={false}`), not an `email_templates` row.

### 6. Operator side

**Event form** (`RaceEventForm`, any kind): a "Charity day" section with: switch on; charity name; donate heading and blurb; preset amounts (comma-separated euros); allow other amount, minimum, maximum; match multiplier and match label; goal (optional); show total; include entries in the total; thank-you title and body; receipt subject and intro. Saved on the event through the existing `PUT /api/events/[id]` with a Zod schema for the whole group. Validation: at least one preset or custom allowed; minimum ≤ maximum; multiplier 1 to 5.

**Donations page** (`/events/[id]/donations`, a sibling of `/events/[id]/teams`), reached from a "Donations" link on the event's row in `/events`, shown when the section is on or any donation exists: date (event zone), donor name, email, amount, matched amount, status, message, receipt sent; totals above the list (donations, matched, entries, grand total); **Export CSV** for the hand-over to the charity; **Mark as refunded** per paid row (record only, see Money). Gated on the existing `races` permission like the teams page; the routes do `assertLocationAccess` on the event's location.

### 6b. Find me a team

A second piece of work on the same page, independent of donations: it ships as its own PR after the donations PR, and nothing in the donations PR depends on it.

**On the page.** When the operator switches it on for an event, the team card's size choice gains a third option, "Find me a team" (label operator-editable), shown FIRST, before the allowed team sizes (Richard), whatever those are (the 21 November event allows 2 and 4 only; this option does not require 1 to be an allowed size). Choosing it hides the team name and the teammate fields and keeps the wave picker, the entrant's own details (name, email, mobile), the promo code and the consent tick. A line under the choice explains it (operator copy; default: "No team? No problem. Book your place and we'll put you with a team in your wave. We'll email you once you're placed."). The button reads "Register and pay €50.00" for one place: the per-head pricing and the member check apply to one person exactly as they do to a captain.

**What it creates.** A registration for a team of one, through the same register route and the same payment path as any team, with `looking_for_team = true` on the `race_registrations` row and the team name synthesised from the entrant ("Sarah Byrne (looking for a team)"). The confirmation email is the normal one with one extra paragraph (operator copy) saying they will be placed and emailed.

**Capacity.** In `teams` capacity mode an unplaced solo does NOT count against the wave's capacity (a pooled solo is not a team on the course yet); in `people` mode it counts as one person as today. `loadForMode` and the public `is_full` both exclude unplaced solos in `teams` mode. Placing a solo into a team never changes the wave's team count; pairing solos into a new team adds one team and is checked with `wouldFit` (staff may override with a warning, since they are the ones running the day).

**Staff side** (`/events/[id]/teams`): a "Looking for a team" group at the top of the page listing unplaced solos with wave, name, email, mobile, paid, and two actions:

- **Place in team**: pick a team in the same wave (teams in other waves are listed too, marked). The entrant is added to that team's `team_members`, the solo registration becomes `status = 'placed'` with `placed_into_registration_id` set, and its payment row stays attached to it (money is never re-pointed). The team's `size` grows by one; allowed sizes are not enforced here (a team of 3 on the day is staff's call). The placed person is emailed (operator copy: "You've been placed with team {name}, {wave}").
- **Pair up**: select two or more solos in one wave and form a new team: a `teams` row named by staff (default "Team {first names}"), the first selected as captain, one new `confirmed` registration in that wave, each solo registration `placed` into it. Each paired person is emailed the same placement email.

`placed` joins `cancelled` and `no_show` as a non-live status: it leaves `LIVE_REGISTRATION_STATUSES`' reads, the control board, check-in and the counts, and a placed row is never cancelled or moved again. `race_payments` on a placed registration still count as that event's revenue (the staff totals and the charity "include entries" sum read payments, not registrations).

**Data.** `race_registrations` gains `looking_for_team boolean not null default false`, `placed_into_registration_id uuid null → race_registrations ON DELETE SET NULL`, `placed_at timestamptz null`, `placed_by uuid null → profiles`; the status CHECK gains `'placed'`. `race_events.find_team` jsonb holds `{ enabled, label, blurb, confirmation_paragraph, placed_subject, placed_intro }`.

**API.** The register route accepts `find_team: true` (then `team_size` is 1 and `team_name` and `members` are omitted); `GET /api/public/events/[slug]` exposes `find_team: { enabled, label, blurb }`; `POST /api/registrations/[id]/place` (manager+, `assertLocationAccess`) with `{ team_registration_id }`; `POST /api/events/[id]/pair-solos` with `{ registration_ids, team_name, wave_id }`. The public widget's `KIND_COPY` only offers the option for `race` kind events (other kinds have no teams).

**Tests.** Register route: find-team entry with sizes `[2,4]` accepted, members refused, priced for one; capacity exclusion in `teams` mode and inclusion in `people` mode; place and pair routes (wrong wave warning, cross-event refusal, a placed row cannot be placed twice, payments untouched); the teams page's group; the widget's third option and hidden fields.

### 7. Data

**`race_events`** gains `charity_enabled boolean not null default false` and `charity jsonb` (the settings group above, validated by Zod on write; `null` means defaults). The migration grants nothing new to clients.

**`donations`** (new; service role only):

| column | type | note |
|---|---|---|
| id | uuid pk | |
| race_event_id | uuid not null → race_events, ON DELETE RESTRICT | an event with money on it is soft-deleted (`active=false`), never dropped |
| location_id | uuid not null → locations | denormalised from the event for scoping |
| contact_id | uuid null → contacts, SET NULL | set once the contact step runs |
| donor_name, donor_email | text not null | |
| message | text null | ≤ 280 |
| amount_cents | int not null | |
| currency | text not null default 'EUR' | the event's `payment_currency` |
| match_multiplier | numeric(3,1) not null default 1 | snapshot at paid |
| status | text not null | `awaiting_payment, paid, failed, expired, refunded` (CHECK) |
| payment_provider, payment_provider_ref, payment_checkout_token, payment_checkout_url, connected_account_id | text null | as `trial_purchases` |
| paid_at, refunded_at, receipt_email_sent_at | timestamptz null | |
| refunded_by | uuid null → profiles, SET NULL | who recorded a Revolut refund; null for a Stripe-reported one |
| marketing_opt_in | boolean not null default false | |
| attribution | jsonb null | visit origin, as the trial |
| created_at, updated_at | timestamptz | `update_updated_at` trigger |

Indexes: `(race_event_id, status)`, partial on `payment_provider_ref`, `(contact_id)`. No cron, so no heartbeat row.

### 8. API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/public/events/[slug]` | public | gains `charity: { enabled, name, heading, blurb, presets_cents, custom_allowed, min_cents, max_cents, match_multiplier, match_label, goal_cents, show_total, raised_cents?, donation_count?, consent_label, thank_you_title, thank_you_body }` when enabled; absent otherwise |
| `POST /api/public/events/[slug]/donate` | public, rate-limited | validate, insert `awaiting_payment`, open the provider order, return `{ donation: { id, amount_cents, currency, checkout: { provider, token, url, connectedAccountId } } }` |
| `GET /api/public/donations/[id]` | public, rate-capped re-check | `{ id, status, amount_cents, currency, match_multiplier, checkout }` for the poll and the confirming state; no donor PII |
| `POST /api/webhooks/revolut/donations` | Revolut signature | mark paid/failed/expired; run the stamp-keyed side effects |
| `GET /api/events/[id]/donations` | manager+, `assertLocationAccess` | list + totals; `?format=csv` streams the export |
| `POST /api/events/[id]/donations/[donationId]/refunded` | manager+, `assertLocationAccess` | record a refund made in the provider dashboard (404 off-location) |

All registered in `src/lib/openapi.js`; the public ones in `check:route-guards`' `EXEMPT` map.

### 9. Tests the change ships with

- `src/lib/charity-donations.test.js`: defaults and copy resolution, `computeCharityTotals` (match snapshots, refunded excluded, entries in/out, empty), settings validation.
- `src/lib/donation-payments.test.js`: create persists refs or throws; `markDonationPaymentStatus` idempotent across paid, failed, repeated webhooks; the side effects run once when their stamps are set and again when a stamp is still null (a failed receipt is retried, a sent one is not).
- Mark-as-refunded route: paid → refunded with `refunded_by`; a second call is a no-op; the row leaves `computeCharityTotals`.
- Route tests for the donate POST (amount outside bounds, section off, closed event still accepts donations, rate limit), the status GET (re-check path), the Revolut webhook (bad signature, unknown order, replay), the staff list (404 off-location, CSV).
- `RaceSignupWidget` tests: band absent when off; chips, custom amount, thank-you state, `?donation=` confirming state.
- `RaceEventForm` test: the section round-trips through save.
- The migration's privilege self-check (no client grant on `donations`).

## Left to the builder

- The component split inside `RaceSignupWidget` (a `DonateBand` sibling is likely right; the widget is already long).
- The exact Zod schemas, CSV column order, and rate-limit numbers.
- How the Stripe webhook route dispatches by domain today, and the smallest extension that routes the donation domain.
- Copy defaults, within the receipt's required statements above.

## Calls the designer made (check these while reading)

- The charity page is the event page itself, not a separate URL or a landing-page-builder page. `landing_page_settings` is one row per location (location_id is the primary key), so a second operator-built page per studio would need that table reworked; the event already carries the hero, copy, waves and payment rail.
- Donations are allowed while registration is closed or full: giving does not depend on racing.
- No `orders` row, no donor wall, no refund button, no host-portal editing in v1.
- Match multiplier snapshotted per donation at the moment it is paid.
- The event description moves below the two cards (it sat beside the signup card before; two cards now take that width).
- A Revolut refund is recorded by a staff member, not detected; a Stripe one is detected.
- Donations have no cut-off beyond the operator's switch.
