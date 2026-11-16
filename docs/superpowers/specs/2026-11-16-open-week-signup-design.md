# OPENWEEK.1 — Open week signup page (both studios)

Date: 2026-11-16. Status: draft for Richard's approval.

## Intent

UN1T is running an open week at Stillorgan and Hatch Street. Anyone can come and
try the studio. We need one public signup page where a visitor picks a studio,
picks the open week classes they want, gives their details once, and comes away
**booked into every class they picked**, in the studio's real booking system
(Glofox at Stillorgan, un1t.online at Hatch), so the bookings show in the app and
count against class capacity.

## Goals

- One link for ads and social: `/openweek`, studio picker first.
- Visitor books several classes in one go, from the open week dates only.
- Real bookings in Glofox / un1t.online, made automatically after signup.
- One confirmation listing the classes booked.
- Staff see the signups (claims list + the usual Approvals card when a booking fails).
- Every signup becomes a contact with consent recorded, like /corp and /newstart.

## Non-goals

- No payment. No upsell or checkout in this flow.
- No new booking engine: the existing class-booking queue does the booking.
- No Mia involvement beyond what a booking confirmation already triggers.

## Anti-goals (a failure even if it "works")

- **Handing out credits.** Richard: "I don't want to assign them credits." The
  visitor must never be left holding free credits they can spend outside the
  week, and the page never talks about credits.
- Booking current members (they already have classes).
- A signup that says "you're booked" when a booking actually failed.

## Constraints found in the code

- Neither platform books without an entitlement. Glofox refuses with
  `YOU_HAVE_NO_CREDITS_LEFT`; un1t.online would need `bypassCredit`, which is
  banned (CLAUDE.md, UN1TWRITE). So "no credits" means **no credits the visitor
  ever sees or can spend**, not literally zero entitlement.
- un1t.online credit grants exist only in `grantPromoCredits`, called only from
  `src/lib/corp-promo-claim.js` (pinned by `tests/un1t-online-write-guard.test.js`
  and `tests/mia-no-charge-no-refund-guard.test.js`). Reusing the promo claim
  keeps us inside that rule: no new caller.
- Glofox promo plans are fixed (a plan has a set number of credits or a set
  duration). We cannot vary the grant per person at Stillorgan.
- The current Hatch promo eligibility refuses anyone who has trained at Hatch or
  had a free trial there (CORPPROMO.1, Richard 28 Oct). Open week overrides that:
  **anyone except current members** (Richard, 16 Nov).
- The Stillorgan (Glofox) promo eligibility already refuses only current members,
  plus repeat/in-progress claims. That matches open week as-is.

## Approaches considered

- **A. Book every picked class, with exactly matching entitlement added behind
  the scenes (CHOSEN by Richard, 16 Nov).** Reuses the /corp + /newstart promo
  claim and the CLASSFIRST.1 funded-booking queue; extends both from one class to
  several. Real bookings, app visibility, correct capacity.
- B. CRM-only guest list, staff check people in at the door. Simple, but the
  booking systems don't know, so classes overbook and visitors can't see or
  cancel in the app.
- C. Staff book everyone by hand. Doesn't scale; at Hatch it needs the banned
  override.

## Design

### Data

New migration (next free number; 839 is the latest today):

- `corp_promos` gains:
  - `kind text NOT NULL DEFAULT 'promo' CHECK (kind IN ('promo','open_week'))`
  - `window_starts_on date`, `window_ends_on date` (studio-local dates; required
    when `kind = 'open_week'`, CHECK)
  - `max_classes integer CHECK (max_classes BETWEEN 1 AND 20)` (required for
    open week; 5 for this one)
  - `max_per_day integer CHECK (max_per_day BETWEEN 1 AND 5)` (1 for this one)
- New child table `corp_promo_claim_classes` (one row per picked class):
  `id`, `claim_id → corp_promo_claims ON DELETE CASCADE`, `location_id`,
  `class_event_id text`, `class_name text`, `class_starts_at timestamptz`,
  `created_at`; `UNIQUE (claim_id, class_event_id)`. Service-role only
  (`REVOKE ALL … FROM anon, authenticated`, RLS on, no policy). The existing
  single `class_event_id` columns on `corp_promo_claims` stay for /corp and
  /newstart.
- Heartbeat/cron: none new.

### Eligibility

- `kind = 'open_week'` at a **un1t.online** studio: refuse `active_member`
  (an active `contact_studios` membership at the studio, or an active un1t.online
  membership on the account at fulfilment), `already_claimed`, `help_pending`,
  `in_progress`. Prior training and prior free trials **do not refuse**.
  Someone already holding un1t.online credits is refused by `grantPromoCredits`
  (`holds_credits`, `un1t-online-write-ops.js` step 4) with no card. *(My call:
  keep that; the open week copy tells them "you already have classes on your
  account, book them in the app".)*
- `kind = 'open_week'` at a **Glofox** studio: the existing
  `glofoxCorpPromoEligibility` unchanged.
- One open week claim per person per studio (existing one-live-claim rule).

### Entitlement

- **Hatch (un1t.online):** grant **exactly the number of classes picked**.
  un1t.online's `/credits/grant` takes only `expiresInDays` (transport allowlist,
  `un1t-online-write.js`), so the expiry is whole days from the grant: *(my call)*
  the smallest day count that covers the end of 30 Nov on the studio clock, so it
  may run up to a day past the window but never ends before the last class.
  This changes Richard's recorded CORPPROMO.1 rule ("credits and expiry from the
  promo definition, 3 for 7 days") for open week only, and the two pinned guard
  tests with it; no new caller of `/credits/grant`.
  Then book each class. Credits are used up by the bookings; nothing is left over.
  `grantPromoCredits` gains `credits`/`expiresAt` arguments from the caller
  (validated against `max_classes` and the window), still called only from
  `corp-promo-claim.js`.
- **Stillorgan (Glofox):** a new €0 Glofox plan, "Open Week", made by Richard in
  Glofox and bound on the studio's open week `corp_promos` row. Plan type is
  Richard's call (see Open questions). The flow buys it once, then books each
  class.

### Page

- A `landing_pages` row `/openweek` (kind campaign) with both studios attached
  (`landing_page_studios`), a `corp_promo` block per studio naming its open week
  promo. Copy is operator-editable in the editor (defaults below), per CLAUDE.md
  "customer-facing copy must be operator-editable".
- Flow: studio → classes → details → done.
  - **Class step:** the existing ClassPickStep (day-first), **multi-select**,
    limited to classes inside the promo's window, capped at `max_classes`, with
    a running "3 classes picked" line. Full classes shown as full, not pickable.
  - **Details step:** name, email, mobile, optional marketing consent, terms
    (same fields as /newstart).
  - **Done:** "You're booked" with the list of classes, plus "check your email".
- Copy defaults (editable): heading "Open Week at {studio_name}", subhead
  "Come and try a coach-led class, on us. Pick your classes for the week and
  we'll book you in.", CTA "Book my classes", refusal text for current members
  ("You're already a member, so just book in the app as usual").

### Claim route

- `POST /api/public/corp-claims` accepts `classes: [eventId…]` (max `max_classes`)
  for an open week promo; each id re-judged server-side against the studio's own
  timetable read and the window (never trusted from the client). The single
  `class_event_id` path stays for other promos.

### Booking

- After the grant, queue **one `class_booking_requests` row per class** through
  `queueFundedClassBooking` (`funded_by = 'corp_promo'`), the same worker,
  retries and `funded_no_balance` staff card as today.
- A booking that fails (class filled meanwhile, platform refusal) becomes the
  existing staff card; the visitor's email says "we're confirming X, the team will
  be in touch" for anything not yet booked rather than claiming it is booked.

### Hatch visitors already holding credits

*(My call, not asked)* still refused by `grantPromoCredits` (`holds_credits`),
with copy pointing them to book in the app. Unlike Stillorgan, adding credits on
top of theirs would let un1t.online spend either set, so we can't keep their own
untouched.

### Changing picks

*(My call)* One claim per person per studio, no "add classes" path. After
signing up they manage bookings in the app like anyone else.

### Confirmation

- One email per claim listing the picked classes (date, time, class name) and how
  to log in to the app. Built on `corp-promo-emails.js`. Sent after the grant;
  phrased "you're booked into" only for classes whose booking landed by send time,
  otherwise "we're booking you into". In practice the worker has not run yet, so it
  reads "we're booking you into" with the list. *(My call: send once after the
  grant, and keep the booking worker's own per-class confirmation, which is the
  "you're booked" message for each class.)*

### Staff surface

- Open week claims show where /corp and /newstart claims already show, with the
  list of classes. No new permission (uses the existing promo settings permission).
- Settings: the promo form gains the kind, window dates and max classes.

### Pipeline / attribution

- Same as /newstart: contact created/attached, `lead_source` from the promo row,
  tag `<studio>-open-week`, placed on the studio's free-trial board by the
  existing router. *(My call: treat open week like the free trial for pipeline
  placement.)*

## Decided by Richard

- Approach A (16 Nov).
- Anyone except current members; prior trialists and past attendees are welcome (16 Nov).
- Visitors book their classes for the week all at once; no credits handed out (16 Nov).
- Open week is 23–30 Nov 2026 at both studios; only those classes can be booked (16 Nov).
- One class per day, five classes at most per person (16 Nov).
- A spare class (a failed booking, or one they cancel) may be used on another day
  of open week; that is acceptable (16 Nov). So Stillorgan uses a **5-class €0
  Glofox "Open Week" plan ending 30 Nov**, and "nothing left over" is a goal, not
  a guarantee.
- At Stillorgan, a non-member on a Glofox trial, a class pack or ClassPass is
  **booked anyway**: the Open Week plan is bought and their picks booked; their
  own plan is left alone (16 Nov). This replaces the fulfilment step that sends
  `LIVE_PLAN_STATUSES` to a staff card, for open week only. *(Builder: if Glofox
  refuses the purchase or the booking draws on their own pack instead, fall back
  to the staff card; confirm with one live test before launch.)*
- **Open week counts as the person's free trial** (16 Nov): afterwards they are
  refused by /corp, /newstart and the free-trial offers at that studio. At Hatch
  this already follows from the `promo_grant` ledger row (`FREE_TRIAL_OPS`); at
  Stillorgan the open week claim must be read as a used free trial by the same
  checks /newstart's claim is.

## Open questions (Richard's)

1. ~~Open week dates~~ Decided (Richard, 16 Nov): **Mon 23 Nov to Mon 30 Nov 2026 inclusive, both studios**; only classes in that window are bookable. Hard deadline: the page must be live well before 23 Nov (ideally by Wed 18 Nov to allow promotion), so the build must fit in about two days.
2. ~~Max classes~~ Decided (Richard, 16 Nov): **at most one class per day, and at most 5 classes in total** per person. Both enforced on the page (picking a second class on a day replaces the first; a 6th pick is refused) and re-checked on the server by the class's studio-local date. Stored as `max_classes = 5` plus `max_per_day = 1` on the promo row.
3. ~~Stillorgan Glofox plan~~ Decided: 5-class plan ending 30 Nov (see above). Was: **(a)** a time-based "unlimited for the open week"
   €0 plan (books whatever they pick, but they could book more in the app during
   the week), or **(b)** a class-pack plan with `max_classes` credits ending with
   the week (someone who picks fewer is left with spare credits for the week).
   Glofox can't vary the count per person.

## Left to the builder

- Exact migration number, column names, the ClassPickStep multi-select UI.
- Test plan following the existing corp-promo test files.
- Whether the existing claims list needs a filter for open week.
