# Checkout not finished: the abandoned-checkout follow-up

Design agreed with Richard on 1 Nov 2026 and checked against the code by a
builder review the same day. Builder: plan from this document; the "left to
the builder" section says what you decide yourself.

## Intent and why

Since the Karl Meta ad went live (22 Oct 2026), 8 real people reached the
Revolut card step for the Stillorgan €39 14 Day Reset. They opened 12
checkouts. 3 paid (one on her fourth try). 5 left without paying and nothing
happened next: REVPAY.7's 30-minute `expire_pending_after` turns the abandoned
order into Revolut `failed`, the reconcile cron writes `payment_failed`, the
acquisition classifier files the person under Dormant, and nobody messages
them. Before 26 Oct the same drop stayed `awaiting_payment` for ever (Kiran,
24 Oct). Hatch's un1t.online checkout has the same hole: 5 `expired` rows since
September, 1 granted.

These people typed their name, email and phone and tried to pay. Richard wants
them followed up: a WhatsApp asking if they need a hand finishing the purchase,
after the first drop as well as later ones, and especially when they do not
come back on their own. It must cover every page that sells something, not
one ad.

## Goals

- Every unpaid checkout opened from a landing page gets a follow-up unless the
  person pays first.
- The follow-up is WhatsApp first (the studio's number, Garrett's voice at
  Stillorgan), with an email a day later as the second touch.
- Operators can change the wording, the timing, the channel order, or switch
  it off per studio without a deploy.
- Paying, on that checkout or a later one, stops the follow-up with nothing
  sent.

## Non-goals

- No change to pipeline placement (the Dormant filing is PIPE3's business).
- No new staff tab. The WhatsApp thread and the contact timeline are the staff
  view.
- No payment link in the WhatsApp. The card step is what failed; a human reply
  is the point.
- Race entries and donations are not in scope.

## Anti-goals (a failure even if it technically works)

- A message to someone who has paid. The exit must beat the first step, and
  the Hatch delay must outlast the mirror's lag.
- A WhatsApp outside the studio's quiet hours, or from the wrong studio's
  number.
- A checkout that fails because the follow-up could not be enrolled. The
  enrolment is best-effort and never on the request's critical path.
- A second WhatsApp to the same person because they tried again while the
  first follow-up was still running, or within the cooldown after it ended.

## What is covered

Three checkout rows, every studio, every page they are sold from:

| Row | Opened by | Paid when | Unpaid end state today |
|---|---|---|---|
| `trial_purchases` (paid trial, Revolut at Stillorgan, un1t.online hosted checkout at Hatch) | `POST /api/public/trial-purchases` | `markTrialPurchasePaymentStatus` state `completed` (reached by the webhook, the reconcile cron AND the public status poll, so one hook inside it covers all three); Hatch: `settleUn1tTrialPurchases` stamps `granted` off the `un1t_transactions` mirror | Revolut: `payment_failed` ~30 min after open; un1t: `expired` after the checkout's 24 h plus sync lag |
| `class_booking_requests` with a payment (paid intro class on a class-funnel page) | `POST /api/public/class-booking`, the `paid` branch (`awaiting_payment`) | `markClassBookingPaymentStatus` state `completed` | `payment_failed` |
| `offer_purchases` (sale offers, `/offers/<slug>`) | `POST /api/public/offers/[slug]/checkout` | `markOfferPurchaseState` reaches `completed` / the paid handler in `offer-purchase-paid.js` | state stays `created`; Revolut order fails after 30 min |

Volume today is almost all trials (offers and paid intros have had no checkout
since September), but the three share one mechanism.

## Mechanism (decided)

**A sequence trigger, not a bespoke sender.** New `trigger_type`
`checkout_abandoned` on `email_sequences`. Enrolment happens the moment a
checkout is OPENED (the provider order exists and the row is inserted), not
when it fails: "did they come back" is then simply "were they still enrolled
when the first step came due". The 1-hour wait is the WhatsApp step's OWN
delay (`delay_hours: 1`): a fresh enrolment fires its first step at once
whatever a leading wait step says (only `un1t_account_created` honours a
start-step delay, `enrol.js:215-246`), so there is no leading wait step.

**Enrol.** A new module `src/lib/checkout-followup.js` exports
`enrolCheckoutFollowUp(db, { contactId, locationId, domain, rowId, rowCreatedAt, pagePath })`
and `exitCheckoutFollowUp(db, { contactId, locationId, reason })`. Enrol:

1. refuses when the contact already holds a paid row of any of the three
   kinds at that studio with `paid_at >= rowCreatedAt` (a fast payment can
   settle before the deferred enrolment runs);
2. reads the studio's active `checkout_abandoned` sequences (same shape as
   `triggerSequencesForUn1tAccountCreated`), checks the audience filter;
3. calls `enrolContacts` with `sourceType: 'checkout_abandoned'`,
   `sourceRef: '<domain>:<rowId>'`, `allowReenrol: true`, and
   `metadata: { domain, row_id, checkout_created_at: rowCreatedAt, page_path }`.

It is called from the three public routes after the provider order and row
exist, inside its own `try/catch`, after the response is decided
(fire-and-forget: the checkout token goes back to the buyer whatever happens
here). A failed enrolment is `logError`, never a 500.

**Exit.** `exitCheckoutFollowUp` marks every `active`/`paused` enrolment of a
`checkout_abandoned` sequence for that contact at that studio `exited` with
`exit_reason: 'purchase_completed'` (through `setEnrollmentStatus`). It is
called on every paid transition of the three rows: inside
`markTrialPurchasePaymentStatus` on `completed`, in the Hatch settle's
`granted` stamp, inside `markClassBookingPaymentStatus` on `completed`, and in
the offer paid handler. Same best-effort rule: a failed exit is `logError`.

**Goal (belt and braces).** The seeded sequence carries a goal the scheduler
checks before every step: "this contact has a paid row of any of the three
kinds at the sequence's studio with `paid_at >= metadata.checkout_created_at`,
OR an active membership at that studio (`contact_studios.membership_status =
'active'`) that began at or after it". The anchor is the CHECKOUT's creation
time, never `enrolled_at` (the row always predates the enrolment). `isGoalMet`
takes no location today (`scheduler.js:255`): pass `sequence.location_id` and
the enrolment metadata into it for this predicate. A free class booking is
not "came back": they still have not paid. Staff already in touch exit the
person by hand (existing manual exit).

**One running follow-up per person per studio, 7-day cooldown.** A second
checkout while an enrolment is active is a no-op (`enrolContacts` dedupe). A
checkout opened after the previous enrolment ended re-enrols through
`allowReenrol` (dunning's pattern, `cooldown.js` `planReenrolments`): the
seeded sequence sets `re_enrolment_cooldown_days: 7`, and the new `sourceRef`
differs because the row id does. So a person gets at most one WhatsApp a week
from this, however many times they try. (My call; Richard can change the
number in the sequence settings.)

**Transactional lane.** Add `'checkout_abandoned'` to
`TRANSACTIONAL_SOURCE_TYPES` in `src/lib/sequences/steps.js`. What that lane
actually does (verified): WhatsApp with a UTILITY template skips only the
marketing-consent half and keeps "on this studio's list", opted-out/blocked/
undeliverable and the no-`wa_phone` skip; email skips the marketing-consent
check and keeps "on this studio's list", bounced/complained and repeat-bounce
suppression, and sends on the broadcast stream with an unsubscribe footer
(`steps.js:236-262, 316-340`). The engine deliberately does not read
`*_administrative` (`transactional-consent.js` explains why). Whether the
email step should ALSO require marketing consent is Richard's call (see Open).

**Template category.** Publishing a `checkout_abandoned` sequence requires the
WhatsApp step's template to be APPROVED **and** UTILITY (extend
`graph/validate.js`; the gallery install already refuses an unapproved name).
If Meta later recategorises the template as MARKETING, the existing send-time
rule applies (the marketing gate), the skip is recorded, and the email step
still goes. Meta may well file a purchase-recovery message as marketing on
first submission: the submitted text avoids any offer or urgency for that
reason, and if it is still refused as UTILITY the operator can run the
sequence email-only until a UTILITY wording passes.

**Quiet hours.** Seed NO `send_window`: the scheduler applies the studio's
`send_quiet_hours` (default 21:00–08:00) only when a sequence has no window of
its own (`scheduler.js:155-185, 668-680`). Nothing more to build.

**Default steps (seeded in `src/lib/sequence-templates.js`, one template
"Checkout not finished", installed per studio).**

1. WhatsApp, `delay_hours: 1` at a Revolut studio and `delay_hours: 3` at a
   un1t.online studio (Hatch's hosted checkout lives 24 h and a payment
   reaches the CRM up to ~20 min after it is made, so 1 h would message a
   payer); the studio's approved UTILITY template (operator picks it;
   `{{1}}` = first name). Seed the Hatch install with the longer delay by
   reading the studio's `membership_source`.
2. Email, `delay_days: 1`: subject "Did something go wrong?" and a short plain
   body in the studio's branding with one button back to the page the checkout
   was opened from (`{{checkout_page_url}}`), fallback the studio's `/trial`
   page.
3. End.

Switching it on at a studio = create the template, pick it, publish. Switching
off = pause the sequence.

**Template copy for Garrett to submit at Stillorgan** (UTILITY, one body
variable, no offer, no urgency):

> Hi {{1}}, Garrett from UN1T Stillorgan here. It looks like your purchase on
> our website didn't go through. Nothing was charged. If you'd like a hand
> sorting it, just reply here and I'll get you set up.

Hatch needs its own copy on the shared number (templates are per studio,
unique per WABA): same text with "UN1T Hatch Street" and the Hatch sender.

**Merge field.** `{{checkout_page_url}}` renders from the enrolment's
`metadata.page_path`, absolute on the studio's customer host. Sources:
`trial_purchases.landing_path` (already stored), the class-booking page's slug
via `page_id`, the offer's `/offers/<slug>`. The offers route builds links from
an allowlisted request Origin, not `resolveCustomerBaseUrl`: use the same rule
the sending studio's other customer links use, and check the chosen host's
path allowlist carries `/offers/` (a tenant host can rewrite it to `/welcome`).
If enrolment-metadata merge fields do not exist yet, add the smallest general
mechanism, not a one-off.

**Offers.** `offer_purchases.contact_id` exists (mig 503) but is filled only at
paid time by `linkOrCreateContactForPurchase` (`src/lib/sale-offers.js:104`,
find-or-create within the organisation, `lead_source: 'offer_sale'`). Call that
same helper at CHECKOUT time instead, stamp `contact_id` then, and enrol. Also
write the studio consent row the way the trial and class-booking routes do
(`applyFormMarketingConsent`, mirroring whatever the offers form asks), or an
org contact based at another studio is skipped as "not on this studio's list"
on both steps. My call: a person who typed their details and tried to pay is a
lead.

**Staff visibility.** The engine already writes timeline activities for sends
and skips; the WhatsApp lands in the studio inbox thread. Add one timeline
note at enrolment ("Opened a checkout for <product>; follow-up queued") so a
staff member reading the contact sees why the WhatsApp went. Replies: see
Open.

## Constraints the builder must keep (from CLAUDE.md)

- Customer copy is operator-editable: everything the buyer reads lives in the
  sequence steps and the Meta template, with defaults in `sequence-templates.js`.
- WhatsApp sends go through the studio's switched-on number; a
  `WhatsAppNumberMissingError` on this path is a recorded skip, never a throw
  that kills the scheduler tick (`tests/whatsapp-config-callers.test.js` needs
  a row if a new caller of a resolver is added).
- Every Supabase write destructures `error`; a lost bookkeeping write is logged
  structurally and never fails the checkout or the scheduler.
- `check:select-columns`, `check:rpc-names`, `check:route-guards`,
  `check:location-scoping` and the full CI mirror must pass. No migration is
  expected; if one turns out to be needed it is forward-only, applied before
  the code deploys, with an explicit grant decision (service role only here).
- Register the new trigger type everywhere the existing ones are listed:
  `graph/schema.js`, `graph/view.js`, `SequenceSettings.jsx`,
  `AutomationPerformance.jsx`, `AutomationsFlowList.jsx`, and the
  `TRANSACTIONAL_SOURCE_TYPES` test.
- One changelog entry `docs/changelog/entries/<PR>.md` after `gh pr create`.
- Tests first (vitest, mocked supabase) for: enrol on open, refuse when
  already paid, exit on paid from each of the four hooks, no-op on a second
  open while active, re-enrol after the cooldown and not before, goal anchored
  on the checkout time, UTILITY-only publish validation, offer contact
  resolve-or-create at checkout, the Hatch delay.

## Left to the builder

- Exact call sites and ordering inside the three public routes and the four
  paid transitions.
- The goal predicate's name and where its data read lives.
- The email body wording beyond the subject and the single button.
- Whether the seeded template is code-only or needs a `sequence_templates`
  row (follow whatever `un1t_account_created`'s template did).

## Open until Richard says otherwise

Asked on 1 Nov 2026; answers to be folded in here:

1. Who answers a reply: Mia (she auto-replies on every inbound unless the
   conversation is paused, `agent/auto-reply.js:492-505`) or Garrett? If
   Garrett, the send pauses Mia on that conversation and marks it for staff.
2. Does the email step require marketing consent (the form's tick), or go to
   everyone who checked out, with the unsubscribe footer?
3. Backfill: message the people who already dropped (5 at Stillorgan since 22
   Oct, 5 expired at Hatch), or future checkouts only?
4. Hatch: does un1t.online already chase its own abandoned checkouts? If so,
   leave Hatch out.
