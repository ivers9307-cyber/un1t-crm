# /trial and /corp: the /50plus look, the class before the details (CLASSFIRST.1)

**Date:** 2026-11-01
**Owner:** Richard Ivers
**Status:** built autonomously from Richard's one-line brief of 2026-11-01
("/trial & /corp need to align with the /50plus design and form layout
requesting the class 1st before requesting details"). Every call below
marked *(mine)* is the builder's and is open to reversal.

## Intent

/50plus converts because the first thing a visitor does is pick a morning:
three big date tiles, then four fields, then "You're booked in". /trial
(the paid 14 Day Reset at Stillorgan, The UN1T Trial at Hatch Street) and
/corp (three free Hatch classes for a corporate partner) still open on a
white frosted card over a photo and ask for name, email and phone before
anything concrete is on offer. Richard wants both pages to look like
/50plus and to ask for the class first.

A person who picks a class and then pays, or claims, must end up booked
into that class. Otherwise the page makes a promise the studio does not
keep. So this is not only a layout change: the chosen class travels with
the purchase or the claim, and once the credits are on the account the
CRM books it through the queue every other public booking already uses.

## What exists (verified in the code, 2026-11-01)

- One public route serves every page: `src/app/(public)/[slug]/[[...rest]]/page.js`.
  `layoutFor(offer_type)` picks `frosted` (paid_trial, class_funnel,
  promo_credits), `one_class` (/50plus) or `blocks`. The one_class layout is
  `CampaignHero` (video or poster, eyebrow, heading, sub-copy, the card as
  children; two columns from `lg`) + `ExpectStrip` + the content blocks, on
  a light tone, with no header CTA.
- The /50plus card (`CampaignFunnel`) is pale (`bg-lp-pale`, `rounded-3xl`),
  with a "Step 1 of 2" eyebrow, date tiles (`cadenceGroups`, three visible on
  a phone, "More dates (n)"), then the details step with a "You're booking"
  summary and a Change link. It lists classes through
  `GET /api/public/classes?page=&studio=` and books through
  `POST /api/public/class-booking`, which queues a `class_booking_requests`
  row for the process-class-bookings worker.
- `/trial` (`PaidTrialFunnel`) and `/corp` (`CorpPromoFunnel`) share the
  `trial-card.js` look (white card, underline inputs). PaidTrialFunnel is
  also the card inside a studio page's first hero (/stillorgan,
  /hatch-street: TRIALFIRST.1).
- `GET /api/public/classes` answers `classes: []` for a page whose offer is
  not a class (paid_trial, promo_credits).
- `POST /api/public/trial-purchases` and `POST /api/public/corp-claims` take
  no class. `trial_purchases` and `corp_promo_claims` have no class columns.
- The class-booking processors already book against an EXISTING balance:
  Glofox (`class-booking-processor.js`) reads the member's credits and books
  when `remaining > 0`; un1t.online (`un1t-online-booking-processor.js`)
  reads the live ledger and skips the trial when `balance >= 1`. Both file a
  staff card on a refusal and retry on a read that failed. A Stillorgan
  trial buyer holds the 14 Day Reset's credits right after the Glofox grant;
  a Hatch buyer or /corp claimant holds un1t.online credits right after the
  settle or the promo grant.
- Two gates in those processors would mis-handle a funded buyer with an
  EMPTY balance: PAIDTRIALONLY.1 closes a new person's row with the paid
  trial reply (a website row is simply closed and logged), and the Glofox
  `needs_credit_grant` card's approve buys a FREE trial.

## Goals

1. /trial and /corp render the one_class layout: the hero (a coach video or
   poster, else the page's hero photo) with the card beside it on desktop and
   under it on a phone, the expect strip, then the page's blocks, light tone.
2. The card asks for the class first. /trial: choose the studio (only when
   the page offers more than one and none is preselected), pick a class,
   then details and payment. /corp: pick a class, then details and claim.
3. The chosen class is validated server-side against the studio's visible
   timetable and stored on the purchase or claim row (the server's name and
   start, never the client's).
4. When the credits land (Stillorgan: the Glofox plan grant; Hatch: the
   un1t.online settle; /corp: the promo grant) a `class_booking_requests`
   row is queued for that class, marked as funded by the purchase or claim.
   The existing processors book it and send the existing confirmation.
5. A funded row whose balance reads empty goes to a staff card with its own
   reason; it is never closed with the paid-trial reply and never offered a
   free trial.
6. Every new word (step titles, the class line on the done screen, the
   expect cards, empty-timetable texts) and the hero media are
   operator-editable on the page's offer block with defaults.
7. A timetable the server could not read, or an empty one, never stops a
   sale or a claim: the card says so in the operator's words and offers to
   continue without a class *(mine)*.

## Non-goals

- No class allow-list on these pages: the studio's hidden-class deny-list
  governs, as it does for /start. (/50plus keeps its allow-list.) *(mine;
  cheap to add later as a studio-owned `class_keywords` key.)*
- The studio pages (/stillorgan, /hatch-street) keep the blocks layout.
  Their hero card IS PaidTrialFunnel, so it gains the class step too; that
  is accepted, not designed around. *(mine)*
- /start (class_funnel) keeps the frosted layout.
- The confirmation emails and the Approvals cards do not yet name the
  chosen class (follow-up).
- No new WhatsApp template; the existing class confirmation is used.

## Anti-goals

- A buyer pays and is never booked, silently. Every path after the grant
  either books, files a card, or logs at error level.
- A class the visitor could not see (hidden keyword, full, another studio)
  can be booked by a forged request.
- The checkout or the grant fails because the timetable read failed.
- A free trial is granted to someone who just paid for one, or on top of
  promo credits.
- A hard-coded headline, class line or card text that needs a PR to change.
- Dark, cramped, small type on the card (the /50plus rules).

## Constraints (CLAUDE.md, binding)

- Service-role routes, rate-limited, studio resolved from the live page
  (`resolvePublicPageRequest`); display-safe class data only (PUBCAP.1).
- The booking route's rule, kept here: validate the chosen `event_id`
  against the SAME read the picker used.
- A new column on `trial_purchases`, `corp_promo_claims` or
  `class_booking_requests` is on a service-role table (RLS on, no client
  grant), so it needs no grant decision; `check:select-columns` must see it
  in a migration before the code reads it. The migration is applied before
  the code deploys.
- No new un1t.online write primitive and no new caller of `grantTrial`,
  `grantPromoCredits` or `book`: the booking rides the existing queue and
  its processors (`tests/un1t-online-write-guard.test.js`).
- `enabled=true` / silent-failure rules: the queue insert after a grant is
  best-effort and logs structurally; a lost insert never undoes the grant.
- Every `<button>` in a form typed; status text on light cards uses black
  alpha or the -700 ramp; no em-dashes in customer copy.

## The design

### 1. Layout

`LAYOUT_BY_OFFER`: `paid_trial` and `promo_credits` become `one_class`
(campaign pages only; `layoutFor(_, 'studio')` is still `blocks`).

The route's `offerElementFor` returns, for both, `{ kind: 'one_class', cta,
hero, expect, offer }`. `hero` and `expect` come from one resolver,
`oneClassPresentation(block, { heroImageUrl })` in a new module
`src/lib/class-first-funnel.js`, which reads any of the three offer blocks:

- campaign_funnel: exactly `campaignFunnelCopy` as today;
- paid_trial / corp_promo: `video_url`, `poster_url`, `video_focus`,
  `sound_default`, `sound_label` (new page-owned keys, same literals as the
  campaign block) with the page's hero block image as the poster when the
  block has neither; eyebrow / heading / subhead from the block's existing
  keys; `expect_eyebrow`, `expect_heading`, `expect_cards` (new, defaults
  below).

The editor's preview region (`EditOfferLayout` → `OneClassRegion`) uses the
same resolver, so the hero and strip of a /trial or /corp page are edited in
place exactly as /50plus's are. The card's own words stay in the left
panel for these two (as the frosted layout did); only the campaign card's
four words are edited in place, as today.

Anchors: the trial card keeps `id="trial"`, the corp card `id="corp"`; the
footer CTA and the header keep their targets.

### 2. The card

`trial-card.js` adopts the /50plus recipe *(mine)*: pale rounded card,
white bordered inputs with rounded corners, the black pill button, so
PaidTrialFunnel, CorpPromoFunnel, TrialStudioPicker, TrialTermsTick and
the embedded checkout's light tone all move together.

A new client component `ClassPickStep` (`src/components/landing-page/
ClassPickStep.jsx`) is the date-tile step lifted out of CampaignFunnel:
the list fetch (`campaignFunnelClassesUrl`), the tiles, the three-visible
rule, loading / not-configured / unavailable / empty texts, the CTA. It
takes `{ page, publicPath, campaign, copy, chosen, onPick, onContinue,
allowSkip, skipLabel, showClassName, stepLabel }`. CampaignFunnel is
refactored onto it with no behaviour change (its tests pass unchanged).
Tiles on /trial and /corp show the class name (one studio lists many
classes); /50plus's do not.

**PaidTrialFunnel steps:** `choose` (as today) → `pick` → `form` →
`payment` / redirect → `confirming` → `done`; `refused` and `help_sent`
unchanged. The form step shows the "You're booking" summary with Change
(to `pick`), then the price panel (compact), the four fields, consent,
terms. A buyer back from a checkout (resume) never sees the picker. The
done screen adds the class line when a class was chosen.

**CorpPromoFunnel steps:** `pick` → `form` → result. Same summary, same
done class line.

When the list is unavailable or empty, both cards show the operator's text
and a typed button "Continue without picking a class" *(mine)*; the POST
then carries no `event_id` and the done screen shows no class line.

### 3. The classes list

`GET /api/public/classes?page=<slug>&studio=<path>` for a `paid_trial` or
`promo_credits` page lists the studio's visible timetable over 14 days
(`readPublicClasses(db, locationId, 14, { blocks })`: Glofox at Stillorgan,
the synced un1t_events at Hatch) and answers `{ classes, terms, campaign:
{ configured: true, timetable_unavailable } }`, the shape the pick step
already reads.

### 4. The POSTs

`POST /api/public/trial-purchases` and `POST /api/public/corp-claims` take
an optional `event_id` (≤64 chars). With one, after the studio is resolved
and before any row or money: `readPublicClasses` for that studio; a read
that failed → 503 `timetable_unavailable` (the card keeps the details and
shows the text); an id not in the list → 400 `class_unavailable` (the card
returns to the picker with the details kept and reloads the list). The
match's `name` and `starts_at` are stored as `class_event_id`,
`class_name`, `class_starts_at` on the purchase or claim row.

### 5. Fulfilment

New module `src/lib/class-first-booking.js`:
`queueFundedClassBooking(db, { fundedBy: 'trial_purchase' | 'corp_promo',
fundedById, locationId, contactId, pageId, eventId, className, startsAt,
customer, terms })` inserts a `class_booking_requests` row (status
`queued`, no trial pair, `funded_by`, `funded_by_id`, the terms acceptance
copied from the source row) and nudges QStash
(`publishQueuePush`, dedup `class-booking-<id>`). A 23505 is "already
queued". Any other failure logs at error with ids and returns
`{ queued: false }`; the caller's grant is never affected.

Called, best-effort and after the granted stamp, from:
- `trial-purchase-processor.js` (Stillorgan, after the Glofox plan is on);
- `trial-purchase-un1t-settle.js` `settleRow` (Hatch, after the CAS stamp);
- `corp-promo-claim.js` (after the granted stamp).
Only when the row carries a `class_event_id`.

Processor guards for a funded row (`request.funded_by` set):
- Glofox: where the balance read says nothing to book with, route to
  review with reason `funded_no_balance` instead of the paid-trial reply or
  `needs_credit_grant`. The mint path is unreachable (the buyer's contact
  carries `glofox_member_id`), but the same guard sits before it too.
- un1t.online: `trialMode: 'funded'`: no credits and no membership → a card
  `funded_no_balance`; never `grantTrial`, never the paid-trial reply.
- `agent-request-why.js` gets the reason's words.

### 6. Data (migration 799)

```
trial_purchases:        class_event_id text, class_name text, class_starts_at timestamptz
corp_promo_claims:      class_event_id text, class_name text, class_starts_at timestamptz
class_booking_requests: funded_by text CHECK (funded_by IN ('trial_purchase','corp_promo')), funded_by_id uuid
```
All three tables are service-role only; no grant changes. Comments name
CLASSFIRST.1.

### 7. Copy defaults (operator-editable, on the block)

paid_trial (new keys): `pick_title` "Pick your first class", `pick_body`
"Choose a session for your first visit. You pay once, then we book you
in.", `details_title` "Last step", `details_body` "We just need these to
set you up.", `no_classes_text` "No classes are open to book in the next
two weeks. Buy your trial and we will help you book your first one.",
`timetable_unavailable_text` "We could not check the timetable just now.
You can still start your trial and book your first class after.",
`skip_class_label` "Continue without picking a class", `done_class_body`
"Your first class: {class}, {day} at {time}. We will confirm it shortly.",
`expect_eyebrow` "What to expect", `expect_heading` "Your first two weeks",
`expect_cards`: A coach beside you / Every session scaled / Book in minutes.

corp_promo (new keys): the same step keys with corp wording ("Pick your
first class", "Choose a session for your first visit. Your free classes go
on your account and we book you in."), `done_class_body` "Your first class:
{class}, {day} at {time}. We will confirm it by email.", expect strip
"What to expect" / "Three classes, on us" with three cards.

Both: `video_url`, `poster_url` (null), `video_focus` 'top',
`sound_default` 'on', `sound_label` 'Tap for sound'.

### 8. Editor

`PaidTrialEdit` and `CorpPromoEdit` (LandingPageSettingsForm) gain the hero
media fields (extracted from `CampaignFunnelEdit` into `HeroMediaFields`),
the expect-cards editor (extracted into `ExpectCardsFields`) and the new
step words. `CLIENT_WITHHELD_KEYS` is unchanged (every new key is page copy
or media).

## Build order

1. Migration 799 (apply first).
2. `class-first-funnel.js` (defaults, `oneClassPresentation`, the class
   line formatter) + tests.
3. `ClassPickStep` extracted; CampaignFunnel refactored; its tests green.
4. `trial-card.js` recipe; PaidTrialFunnel and CorpPromoFunnel class-first;
   their tests updated.
5. Classes route; the two POST routes; tests.
6. `class-first-booking.js`; the three grant hooks; processor guards;
   `agent-request-why`; tests.
7. `layoutFor`, the page route, EditOfferLayout, LandingPageSettingsForm.
8. CI mirror, `next build`, browser check of /trial, /corp, /50plus.
