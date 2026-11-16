# STAFFPAYLINK.1 — staff send a Hatch Street payment link on WhatsApp

Status: design approved by Richard (15 Nov 2026).

## Why

After a **phone call** with someone about joining or topping up at Hatch Street
(a un1t.online studio), staff want to send them a payment link on WhatsApp
from the contact's CRM profile, so the person can buy the membership or credit
pack themselves. Today this is done by hand.

Who receives it: **brand-new customers** (no un1t.online account yet) and
**existing members** upgrading or topping up. The WhatsApp message usually
starts a **fresh conversation** (no customer message in the last 24 hours), so
it must go as an approved Meta template.

## Goals

- From the contact profile's Hatch card: pick a product from a dropdown, see the
  message preview, press **Send on WhatsApp**.
- The customer taps **Pay now** and pays on un1t.online's own hosted checkout.
- A new customer accepts un1t.online's terms and waiver themselves on our page;
  we create their account from the profile's name, email and phone (they type
  nothing else).
- The CRM sees the payment and shows "Paid" on the card.

## Non-goals

- The free trial (it has its own grant path, never a checkout).
- Stillorgan / Glofox studios.
- The phone app (web only in v1; the parity linter gets a `WEB_ONLY_OK` entry).
- Sending the link by email (could follow later).
- Booking a class as part of the purchase, discounts, refunds.

## Anti-goals (a failure even if it "works")

- The CRM charging the card itself (`/purchases/charge`, `charge-custom`) — never.
  un1t.online takes the money on its hosted checkout, as for /trial and /offers.
- Staff accepting the terms on the customer's behalf.
- The link token or the checkout URL ever logged or stored in clear.
- A second payment for the same link (a customer who paid and taps again sees
  "all paid up", never a new checkout).

## Approaches considered

- **A (chosen by Richard):** the WhatsApp button opens a short page on the
  Hatch customer site; the account (if new) and the un1t.online checkout are
  made when the customer taps, so nothing goes stale and the customer accepts
  the terms themselves.
- **B (rejected):** make the account and the checkout at send time and put
  un1t.online's URL straight in the message. Needs staff to accept the terms for
  the customer, and the checkout can lapse before they tap.
- **C (rejected):** a template that just says "sign up at
  hatchstreet.un1t.online and pick X". No tracking; the customer hunts for the
  product.

## The flow (approved with Richard)

1. **Staff, contact profile → Hatch card → "Send a payment link".** Dropdown of
   the studio's sellable products: the `mia_purchase_offers` list (the same list
   Mia sells from, filtered by `isSellableUn1tProduct`). Preview of the exact
   message. **Send on WhatsApp**. Afterwards the card shows the latest link's
   status: sent / opened / paid / expired.
2. **Customer gets the WhatsApp message** with a **Pay now** URL button.
3. **They tap it** → `/<path>/<token>` on the studio's customer host.
   - New customer: one page — product, price, their name and email from the
     profile ("Not you? Reply to us on WhatsApp"), two ticks (un1t.online
     terms, liability waiver), **Continue to payment**.
   - Existing member: the same page without the ticks (one extra tap).
4. **un1t.online's hosted checkout** (Stripe). They pay.
5. **Back on our page** (`?paid=1`): "You're in, <first name>", app links, how
   to log in / set a password (the same help /trial buyers get).
6. Plain states: already paid → "You're all paid up"; link older than 7 days,
   revoked, or the product no longer sold → "This link has expired, reply to us
   on WhatsApp and we'll send a new one"; un1t.online unreachable → "Try again
   in a minute".

## How it is built

### Data — new table `staff_payment_links` (migration 841)

Service role only (`REVOKE ALL … FROM anon, authenticated`, RLS on, no policy).
Columns (builder may refine names): `id`, `location_id`, `organization_id`,
`contact_id`, `un1t_product_id`, `product_title`, `price_cents` (snapshot at
send), `token_hash` (sha256 hex, UNIQUE; the token itself is never stored),
`status` (`sent` | `opened` | `checkout_started` | `paid` | `expired` |
`revoked`), `un1t_user_id` (null until the account is found or created),
`terms_accepted_at`, `checkout_count`, `last_checkout_ledger_id`,
`paid_transaction_id`, `paid_at`, `whatsapp_message_id`, `created_by`,
`created_at`, `expires_at` (created + 7 days), `updated_at`.
One live link per contact per studio: sending a new one revokes the previous
live link (partial unique index on `(location_id, contact_id)` where status is
live). Mia's `mia_purchase_intents` is not reused: it requires `un1t_user_id`
up front (a new customer has none) and lives 23 hours.

### Staff route — `POST /api/contacts/[id]/un1t-payment-link` (+ `GET` for the card)

Modelled on `/api/contacts/[id]/cancellation-form` (CANCEL-FORM.4), which
already sends a single-use tokenised link on WhatsApp:
`getCurrentUser` → permission → `assertLocationAccessOr404` → contact's studio
must be `membership_source = 'un1t_online'` with un1t.online writes on.
Validate the offer id belongs to this studio and is sellable. Refuse with a
clear message if the contact has no email (account creation needs it) or no
WhatsApp number. Mint the token, insert the row, send:
- inside the 24h window → `sendCtaUrlMessage` (no template needed);
- outside → the studio's configured UTILITY template with a dynamic URL button
  whose URL must be rooted on our customer host (`templateUrlPrefixOk`), else
  409 `needs_template`.
Log the message on the contact's conversation (`getOrCreateConversation`, the
whatsapp_messages row, `manualTakeoverPatch` so Mia stays out of a thread staff
just opened), exactly as the cancellation-form route does.
Permission: a new web key `un1t_payment_links` (owner, manager, reception on by
default, like `un1t_comp_credits`) plus the existing `whatsapp` send permission.

### WhatsApp template (Richard submits to Meta)

Template name stored in `locations.settings.un1t_online.payment_link_template`
(operator-editable, per studio). Proposed text, category UTILITY:

> Hi {{1}}, it's UN1T Hatch Street. Here's the link for the {{2}} we talked
> about on the phone. Tap below to pay securely on un1t.online.
>
> Button "Pay now" → `https://<hatch customer host>/<path>/{{1}}`

`{{2}}` = product title + price label ("Foundation membership, €189 a month").
Consent: this is a service message the customer asked for on the call, so like
the cancellation form it is not gated on marketing consent; it is refused for a
contact who has opted out of WhatsApp at Hatch (STOP) or whose number is
undeliverable. A template Meta files as MARKETING is refused by the route.

### Public page + route — `/<path>/[token]` and `POST /api/public/<path>/[token]`

A public page outside the auth-gated segments, added to all four public-path
allowlists (proxy `publicPaths`, `AppShell` `PUBLIC_PATHS`, the brand
`allowedPaths`, `DB_BRAND_DEFAULTS.allowedPaths`), with
`src/public-compliance-paths.test.jsx` updated. Path name is the builder's call
(`/pay-link/` is taken by dunning); must not collide with landing-page slugs.
- GET resolves the token by hash; an unknown token 404s. First open stamps
  `opened`. Reads only (WhatsApp/link-preview crawlers must never cause a write
  beyond the open stamp).
- POST (Continue to payment): re-resolve; refuse expired/revoked/paid; for a
  new customer require both ticks; `ensureUn1tAccount` (finds by contact link,
  then same-email contact, then un1t.online email search; creates with the
  recorded terms; runs the set-password step); stamp `un1t_user_id`; before a
  checkout, a "has it been paid already?" check against the `un1t_transactions`
  mirror (the `un1tRetryGate` idea from the trial resume path); then
  `createCheckoutLink` with key `paylink:<id>:r<n>`, success
  `?paid=1` / cancel `?cancelled=1` on our host; redirect. Rate-limited.

### Seeing the payment

A new arm of the */2 `process-trial-purchases` cron (beside
`sweepUn1tOfferPurchases`): live links with a `un1t_user_id`, matched to a
mirrored `un1t_transactions` row for that user and product, amount above zero,
dated after the link was created → `paid` (CAS on the status as read). Links
past `expires_at` and unpaid → `expired` (still settled if a late payment
mirrors, like the offers sweep). Its own `cron_heartbeats` row (arm rule).
Staff see the status on the card; no push in v1.

## Calls made after the reviewer check (Claude's, for Richard to check)

- **Checkout URL storage.** "Never stored in clear" means: not on
  `staff_payment_links`, never logged, never rendered. `createCheckoutLink`
  keeps storing it on its own write ledger (`un1t_write_events`) as it does for
  /trial and /offers; the shared write op is not changed.
- **What counts as "paid" for a link:** a mirrored `un1t_transactions` row for
  that un1t.online user AND this link's product, dated after the link was
  created, amount above €0, not refunded, not a subscription renewal. A
  transaction with no product does not count. The trial path's "any credits or
  subscription = no new checkout" rule is NOT used (it would block every
  top-up).
- **Price or product changes between send and tap:** at tap the product is
  re-read from the `un1t_products` mirror. Still active and sellable → the page
  shows the **current** price (what un1t.online will actually charge), not the
  price at send. No longer active → the "expired, reply to us" page.
  Removing it from Mia's list alone does not kill a link already sent.
- **Black Friday overlap:** if the product is also a Black Friday offer
  product, the offers sweep records it as an off-page offer purchase too. That
  is right (the buyer is owed the offer bonus), so the offers code is untouched.

## Decided with Richard (15 Nov 2026, "looks good, proceed")

- **Existing members get one extra tap**: the same page without the ticks
  (product, current price, **Continue to payment**). Opening the link never
  writes to un1t.online; only the POST makes a checkout.
- **A member who already has a live membership**: the Hatch card warns staff
  ("<name> already has <plan>, live") before sending a recurring product, but
  does not block the send (upgrades are a main use).

## Left to the builder

Exact column names, the public path name, copy wording on the public page
(operator-editable per the invariant), the cron arm's batch size, test layout.
