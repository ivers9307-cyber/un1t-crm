# NEWSTART.1: /newstart, 3 free classes at Stillorgan

Date: 5 Nov 2026. Status: design, awaiting Richard's approval.

## Intent

Richard wants a page at `/newstart`, the same idea as `/corp`, for UN1T
Stillorgan. He'll hand the link to a partner company or group. Anyone with the
link can claim **3 free classes, used within 7 days**. They pick their first
class on the page and it is booked for them.

`/corp` runs only at Hatch Street because it grants credits through
un1t.online (`grantPromoCredits`). Stillorgan is on Glofox. So the real work is
teaching the /corp promo mechanism to grant through Glofox, by putting a €0
Glofox plan on the person's account. The page itself is then a
`landing_pages` row like `/corp`.

## Decisions Richard made (5 Nov 2026)

- **Audience:** anyone with the link. The page is generic ("New Start") and
  never names the partner.
- **Who is turned away:** current Stillorgan members only. Someone who trained
  at Stillorgan before, or had a free or paid trial there, CAN claim.
- **Once per person:** one `/newstart` claim per person, matched on email or
  mobile across the organisation (the `/corp` person match).
- **The offer:** 3 classes, use within 7 days, free.
- **The Glofox plan:** a NEW dedicated €0 plan ("New Start", 3 classes,
  1 week) that Richard creates in Glofox, so these signups are distinct from
  The Elites Trial (/50plus). Not The Elites Trial.
- **Next step for the person:** pick a class on the page (CLASSFIRST.1), and
  the CRM books it once the plan is on their account.
- **Traffic:** a partner company or group, not paid ads. The Meta Lead still
  fires (harmless, same as /corp).
- **Someone already holding a live Glofox plan or credits** at Stillorgan
  (a free trial, the €39 Reset, a pack, anything live): take their details,
  do NOT buy the plan, send a card to the team to sort by hand. The page
  shows the block's `help_text`.
- **Board:** a claimant lands on Stillorgan's free trial board (the main
  board's trial column), like a free trialist. Not the Programmes board.
- **Later trials:** a granted New Start claim COUNTS as their free trial
  (/start and the free-trial grant refuse them afterwards), but they CAN
  still buy the €39 Reset at /trial.

## Goals

1. `/newstart` is live for Stillorgan with the /corp look, copy editable in
   `/settings/landing-page`.
2. A claim finds or creates the person's Glofox account, puts the New Start
   plan on it (`payment_method: 'complimentary'`, as PAIDTRIAL.4), books the
   class they picked, and emails them.
3. Anything Glofox refuses or leaves in doubt becomes a card for the team
   (the existing corp promo approvals card), never a silent loss and never a
   second purchase.
4. `/corp` at Hatch behaves exactly as today.

## Non-goals

- No payment of any kind.
- No partner-specific pages, codes or tracking beyond the tag and UTM fields
  the claim already records.
- No change to The Elites Trial, /50plus, /trial or the free trial plan.
- No un1t.online changes.

## Anti-goals (a failure even if it "works")

- Buying the Glofox plan twice for one person (a retried POST, a double
  submit, a re-run after a crash).
- Telling someone "you're in" when the plan did not land.
- A current member getting free credits.
- Any change in behaviour for /corp at Hatch.
- Putting the person on the retired Waitlist board.

## Constraints (from CLAUDE.md, binding)

- Glofox writes: `purchaseGlofoxMembership` is judged on the body
  (`interpretPurchaseResult`), never re-sent after a 5xx (a 5xx or no reply
  is `outcome_unknown`). Write the grant **ahead**: a
  `{ stage: 'purchasing' }` marker on the claim row before the purchase, the
  outcome after. A marker with no outcome on a later run means "may have gone
  through": file help, never buy again. This is the trial-purchase processor's
  pattern (`src/lib/trial-purchase-processor.js` steps 4-5): copy it.
- Account: `findOrCreateGlofoxMember` with `attachTrial: false`. A
  `needs_review` from it, a failed search or a failed link write goes to the
  team with the reason. Its one-time password is never stored, logged or
  shown on the page.
- A Glofox lookup is per-LOCATION but email is unique per ORGANISATION: the
  contact capture already uses `findOrCreateRaceContact` with
  `restrictToOrg: true`; keep it.
- Placement at Stillorgan goes through the PIPE3 router
  (`placeContactNow` / `ensureDealForContact`), NOT `placeWaitlistEntry`.
- Service-role routes: the public route takes the studio, credits, plan and
  expiry from the registry and the page row, never the body.
- Copy is operator-editable: every new user-facing string is a field on the
  `corp_promo` block with a default.
- A new column on `corp_promo_claims` needs a migration (next free number is
  810 on `origin/main` today; check after any main sync). It is service-role
  only; state `REVOKE ALL ... FROM anon, authenticated` if a new relation is
  added. `check:select-columns` must see the new columns.
- Every write is checked (`no-unchecked-supabase-write`); arm the new module's
  path in `eslint.guardrails.config.mjs`.
- Logs carry ids and codes only, never the email or phone.

## The design

### 1. The promo registry (`src/lib/corp-promos.js`)

Add a `platform` field to each promo (`'un1t_online'` for the existing
Hatch promo) and a new entry:

```
'stillorgan-newstart': {
  key: 'stillorgan-newstart', studio: 'stillorgan', publicPath: 'stillorgan',
  platform: 'glofox', credits: 3, expiresInDays: 7,
  glofoxMembershipId: '<set once Richard creates the plan>',
  glofoxPlanCode: '<set once Richard creates the plan>',
  tag: 'stillorgan-newstart', leadSource: 'corp_promo', live: false,
}
```

It ships `live: false` with the ids empty. A follow-up commit (or the same PR,
if Richard creates the plan first) fills the ids and sets `live: true`. The
claim route refuses a Glofox promo with no plan ids even if it is marked live.

The registry also needs a `name` for the editor dropdown
(`studio-offer-fields.jsx` reads `p.name || p.key`), e.g. "New Start
(Stillorgan)". The dropdown should list only the promos whose studio matches
the page's studio, so an editor cannot put the Hatch promo on a Stillorgan
page or the other way round. The route already refuses a mismatch
(`promo.publicPath !== r.publicPath`).

### 2. The claim route (`POST /api/public/corp-claims`)

Keep one route. After the promo and studio resolve, branch on
`promo.platform`. Today's un1t.online path stays byte-for-byte the same.

For `glofox`:
- Gate: Glofox credentials at the location (`glofoxCredentialsForLocation`),
  instead of `un1tWriteSettingsFrom(...).writesEnabled`. None → the block's
  `unavailable_text`.
- Terms: the Stillorgan terms tick that /trial uses at Stillorgan (read how
  the /trial page and `src/lib/landing-pages.js` `studioTermsCopy` word it
  for a Glofox studio). NOT `un1tTermsPayload`/`readUn1tLegalDocs`.
- Lead capture, consent, tag, Meta Lead: unchanged. Deal placement: the
  PIPE3 router (`placeContactNow`), not `placeWaitlistEntry`.
- Active member: a Stillorgan check (an active `contact_studios`
  `membership_status`, and the contact's Glofox membership status the way
  Stillorgan code already judges "active member" elsewhere; the builder finds
  the existing helper rather than inventing one). A failed read is 503, never
  a refusal.
- Eligibility: ONLY "already claimed": any `corp_promo_claims` row for this
  promo key, for any contact that is this person (the `/corp` person match:
  submitted contact + same email + same WhatsApp-normalised mobile in the
  organisation), with status `processing`, `granted` or `help_requested`.
  Prior training and prior trials do NOT refuse. A failed read is 503.
- Insert the `corp_promo_claims` row (status `processing`), then call the
  Glofox fulfilment module.

### 3. Glofox fulfilment (`src/lib/corp-promo-claim-glofox.js`, new)

Mirrors `trial-purchase-processor.js` for one claim:

1. Account: a contact already linked to a Glofox member at Stillorgan is used
   as is; otherwise `findOrCreateGlofoxMember` (email, then phone, then
   register; `attachTrial: false`, `phoneMatchPolicy: 'review'`, so a
   mobile-only match on a stranger goes to the team rather than minting a
   second account). `needs_review` / failure → help.
1b. Live plan check (Richard's decision): for an account that already
   existed, read its live memberships and credits from Glofox
   (`fetchMembershipResult` / `fetchUserCreditsResult`). Any live plan or any
   credit balance → help with reason `live_plan`, no purchase. A failed read
   is unknown, never "nothing live" (CLAUDE.md): help with reason
   `glofox_read_failed`, no purchase. A newly registered account skips this.
2. Write-ahead grant marker on the claim row, guarded so a second runner
   cannot also buy.
3. `purchaseGlofoxMembership(membershipId, planCode)` with
   `payment_method: 'complimentary'`. Ok → stamp the outcome (granted, member
   id, credits). Refused → help with Glofox's code. Unknown → help with
   "check the member's €0 invoice before granting by hand".
4. Side effects, each best-effort and independent: the confirmation email,
   the funded class booking (`queueFundedClassBooking`, `FUNDED_BY.corpPromo`;
   the Glofox class-booking processor already reads `funded_by`).
5. Help = row `help_requested` + `sendOpsAlert` + the existing approvals card,
   exactly as the un1t path.

Return shape matches `fulfilCorpPromoClaim` so the route answers the page the
same way (`granted`, `help_filed`, `ineligible`, `unavailable`).

### 3b. Claims that die halfway

Claims run inside the web request; there is no queue. So:
- A re-submit that finds this person's claim still `processing` and older
  than 10 minutes answers `help_text`, never `already_claimed_text` (which
  would tell them classes are on an account that may have nothing).
- A sweeper moves any `processing` Glofox claim older than 15 minutes to
  `help_requested` (reason `stalled`, with "check the member's €0 invoice"
  when a purchasing marker is present) and files the card + ops alert. It
  rides an existing every-few-minutes cron as an ARM with its own
  `cron_heartbeats` row and `stampHeartbeat` (CLAUDE.md, Crons). It never
  buys anything.

### 3c. Board and trial history

- Board: the PIPE3 router must place a granted claimant in the free trial
  board's trial column. How the classifier reads them depends on how the
  Glofox sync reads the New Start plan (a Glofox trial-type plan reads as
  `trial`; an ordinary plan may read as `MEMBER`, which would also make the
  active-member check refuse them later and inflate member counts). The
  builder verifies against the real synced plan and, if it reads as a
  member, adds a rule so the New Start plan is read as a trial. Richard
  should create it as a trial-type plan if Glofox offers that (rollout).
- Free trial: `stillorganTrialHistory` (`src/lib/trial-eligibility.js`) is
  shared by the free-trial path AND the €39 /trial pre-check, which refuses a
  buyer with any trial history (TRIALSTUDIO). A granted `stillorgan-newstart`
  claim (or a New Start plan on the account) must count for the free trial
  but NOT for the €39 Reset. The builder splits the reason so the /trial
  pre-check ignores it, with tests for both paths. The plan name must not
  match `/trial/i` (it would trip `membership_plan_trial`), hence
  "New Start", not "New Start Trial"; and if the sync reads them as
  `glofox_membership_status = trial` the €39 check must still let them buy:
  test that case.

### 4. Data (migration 810 or next free)

`corp_promo_claims` gains what the Glofox path records:
`glofox_member_id text`, `grant jsonb` (the write-ahead marker and outcome,
same shape as `trial_purchases.grant`). Check `trial_purchases` for the exact
column names and reuse them. The existing `un1t_*` columns stay for Hatch.
Comment both new columns. No client grant.

### 5. Copy and email

The block defaults talk about un1t.online ("Book in the un1t.online app",
"a code to set your password"). For a Glofox promo the defaults must say the
Glofox/UN1T app and how a new member logs in, the way the Stillorgan /trial
confirmation email does today (`src/lib/trial-purchase-emails.js`). Add
Glofox defaults (a second default set keyed by platform) rather than changing
Hatch's words.

Expiry: the plan's 7 days may start at the first booking (Glofox
`starts_on: FIRST_BOOKING_DATE`), so the date is not known at claim time. The
Glofox default copy says "use them within 7 days of your first class" and
does not print `{expires_on}`. If Richard creates the plan to start on
purchase, the copy can say a date; the builder reads the plan's `starts_on`
from `glofox_memberships` once it exists.

### 6. The approvals card

`CorpPromoClaimCard.jsx` shows un1t.online wording and ids. Make it show the
Glofox member id and the grant outcome for a Glofox claim. Same provider,
same tab.

### 7. The page

`/newstart` is a `landing_pages` row: kind `campaign`, `offer_type`
`promo_credits`, primary location Stillorgan, with a `corp_promo` block whose
`promo_key` is `stillorgan-newstart`. Create it after the code deploys, in the
editor at `/settings/landing-page` (preferred, so it is Richard's own page)
or by a data step. Add `newstart` to `PUBLIC_PAGE_SLUGS_FALLBACK`
(`src/lib/public-pages-edge.js`) so a database blip does not send visitors to
the login page.

## Rollout order

1. Richard creates the €0 "New Start" plan in Glofox (3 classes, 1 week,
   private, not sold in the app shop, trial-type if offered, name without
   the word "trial", and **complimentary allowed as a payment method**,
   or every purchase is refused) and sends the membership id and plan
   code (or the CRM's Glofox sync picks it up and we read it from
   `glofox_memberships`).
2. Migration applied, then the PR merges.
3. Ids filled in the registry, `live: true`.
4. Page created in the editor and checked end to end with a test claim on a
   staff email (the €0 invoice shows in Glofox, the class books), then the
   link goes to the partner.

## Left to the builder

- Exact module boundaries, test layout, names of internal helpers.
- Whether the platform branch lives in the route or a small dispatcher in
  `src/lib/`.
- Which existing Stillorgan "active member" helper to reuse.

## Calls I made (not Richard's)

- Extend /corp's mechanism rather than build a separate one.
- Plan ids live in the registry (code), not an editor picker: a new private
  Glofox plan may not appear in the synced catalogue until someone holds it.
- Lead source stays `corp_promo`; the `stillorgan-newstart` tag tells the
  claims apart.
- The page does not name the partner.
- `newstart` goes in the public-slug fallback list.
- A mobile-only match on a stranger's Glofox account goes to the team
  (`phoneMatchPolicy: 'review'`), not a second account.
- Stalled claims: a 10-minute re-submit rule plus a sweeper arm on an
  existing cron, with its own heartbeat row.
- A failed Glofox read of someone's live plans files a card rather than
  telling them to try again.
