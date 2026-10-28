# /corp — corporate promos (CORPPROMO) — design

Date: 2026-10-28 · Status: draft for Richard's approval

## Intent

A public page, `/corp`, that partner companies share with their staff. An
employee claims a free promo there. It is the Hatch Street leg of `/trial`
end to end, except **nothing is paid**: instead of un1t.online's hosted
checkout, the CRM puts the promo's credits straight onto the person's
un1t.online account. The first promo is **3 free classes at Hatch Street,
credits expiring after 7 days**. More promos will follow, so a promo is a
definition, not a page.

## Decided by Richard

- Same flow as `/trial` at Hatch Street, but free: no charge, no checkout.
- The grant is **3 credits, expiring in 7 days**, applied with un1t.online's
  `POST /credits/grant` (`CreditBatchCreateManualDto { userId, amount,
  expiresInDays }`; 200 body `{ success: true, data: GrantCreditsResponseDto }`
  carrying the batch `id`, `credit_ledger_id`, `remaining`, `expires_at`,
  `source`; permission `credits:create`; read from
  `https://api-dev.un1t.online/docs/swagger-ui-init.js`, prod docs 404).
- **Anyone with the link** may claim. No company code, no work-email check.
- **Only someone who has never trained at Hatch Street.** Everyone else is
  turned away before anything is written to un1t.online.
- Hatch Street only for this first promo.
- **The paid `/trial` and the free corp offer stack.** Claiming the promo
  does not stop anyone buying the paid trial, so the shared trial-eligibility
  code (`shapeTrialEligibility`, `grantTrial`) is NOT changed and a
  `promo_grant` row is not a "trial" to it.
- **An email OR a mobile number previously used for a free trial stops the
  fulfilment.** "Free trial" = the Hatch free trial (`op='trial'` ledger rows
  or a trial-product transaction), a TRIALREGRANT credit re-grant, or an
  earlier claim of any corp promo. Match on the normalised email and the
  normalised mobile (`waPhoneFromPhone`), across contacts in the org and
  un1t.online clients at Hatch.
- **Only Hatch Street history counts.** Training at another studio of the
  org does not disqualify.
- **On/off only.** No cap, no end date.
- This is a deliberate **second caller of `POST /credits/grant`**, past the
  TRIALREGRANT.1 lock (20 Oct 2026). Both guard tests
  (`tests/un1t-online-write-guard.test.js`,
  `tests/mia-no-charge-no-refund-guard.test.js`) and the CLAUDE.md
  invariant are widened to name exactly this one new primitive and its one
  caller, and nothing else.

## Goals

1. A visitor at `/corp` fills in the card (first name, last name, email,
   mobile, marketing consent, the un1t.online terms + waiver tick, as on
   `/trial` at Hatch) and either gets the credits or a clear answer why not.
2. Lead capture is the same as every other public form: contact found or
   created (org-unique email, `findOrCreateRaceContact`), lead source and tag
   for the promo, visit origin, attribution, consent recorded in
   `consent_log`, placed on Hatch's acquisition board, Meta `Lead` to Hatch's
   dataset.
3. The un1t.online account is found or created with `ensureUn1tAccount`
   (new accounts get the set-password email, as on `/trial`).
4. The credits are granted once per person per promo, ledgered in
   `un1t_write_events`, judged on the body, never blind-retried.
5. The person is told what they got and how to book: a done screen and a
   confirmation email (log in to the Hatch Street un1t.online app, 3 classes,
   use them by `expires_at`).
6. Anything unclear or refused reaches staff, the way `/trial` help cases do.

## Non-goals

- No payment, Revolut or un1t.online checkout of any kind.
- No company verification, company list, per-company reporting or codes
  (attribution can come from a `utm_campaign` on the shared link).
- No Stillorgan / Glofox leg.
- No booking from the page: the person books in the un1t.online app.
- No staff-facing promo editor for the grant itself.

## Anti-goals (a failure even if it "works")

- Granting credits twice to the same person for the same promo, including on
  a double-submit, a retry, or a death mid-request.
- Granting to anyone who has trained at Hatch, or whose email or mobile was
  already used for a free trial, including through a second un1t.online
  account.
- Treating an unreadable history or an unclear un1t.online answer as "fine,
  grant": an unreadable read refuses with "try again" (503), never grants.
- Telling someone "you're in" when the credits are not confirmed.
- Any other un1t.online write being opened up by this change.

## Who is turned away

Two checks, both at Hatch Street only, both before anything is written to
un1t.online. Each is run for every contact and un1t.online account the
person is (the identity union `trialEligibility` builds) PLUS anyone
matched by the submitted email or mobile.

**A. Free trial already used (Richard).** By email or by mobile: any Hatch
free trial (ledger `op='trial'` done/sent/unknown, or a trial-product
transaction in the mirror), any `trial_regrant`, any earlier corp promo
claim (done/sent/unknown). A match stops the claim (`ineligible`).

**B. Has trained at Hatch (my reading of "hasn't trained in Hatch
previously", check it).** For the person's own contacts/accounts: a Hatch
booking that is not cancelled (un1t.online mirror `un1t_bookings`, and the
CRM's own Hatch `class_bookings`/`bookings` rows from before October), or
any Hatch subscription/membership history (mirror, or the `contact_studios`
membership facts at Hatch, any status, including the old operator-export
rows). A match stops the claim. A paid pack or the paid `/trial` alone is
NOT a stop (they stack), unless it led to a booking.

My call: someone with a Hatch un1t.online account who never booked or
bought anything (an abandoned signup, an unpaid `/trial` checkout) counts
as new and may claim.

Reuse the reads in `src/lib/membership/reads/un1t-online.js` where they
fit; the email/phone match is a new read. Any failed read is "try again"
(503), never eligible. The mirror lags un1t.online by up to 15 minutes;
accepted, since our own ledger stops a double grant and the live credits
read below stops a grant onto an account already holding credits.

## The grant (my call on the mechanics)

A new primitive `grantPromoCredits` in `src/lib/un1t-online-write-ops.js`,
op `promo_grant`, built on the same `attemptWrite` pattern as
`regrantTrialCredits`:

- ledger key `promo_grant:<location>:<un1tUser>:<promoKey>`, also the
  idempotency-key header; policy `never` (never re-sent);
- the transport's `ENDPOINTS` entry for `/credits/grant` gains the op
  `promo_grant` (keys unchanged: `userId`, `amount`, `expiresInDays`);
- a prior row for this person and promo (by user or contact) settles it with
  nothing sent: done → already granted; a sent one in flight → retry; an
  unknown one → the live credits read decides, else staff;
- before sending: writes switched on for the studio, the token holds
  `credits:create`, and a live credits read shows **0 and not unlimited**
  (someone already holding credits is not new; refuse);
- done → granted, credits mirrored; unknown → the credits read decides;
  un1t.online refusal → staff card. Same outcome shape as `grantTrial`
  (`granted` / `ineligible` / `needs_staff` / `retry`).

Amount and expiry come from the promo definition, never the request body.

## Promos as definitions (my call)

A code registry (like `LEAD_CAMPAIGNS`), e.g. `CORP_PROMOS` in
`src/lib/corp-promos.js`: key (`hatch-3-free`), studio, credits (3),
expiry days (7), lead tag, lead source, whether it is live (on/off only). The page and the
route only ever pick from it, so a visitor cannot ask for a different
amount. The **customer-facing words** (headline, ticks, button, done text,
email copy) follow the "operator-editable copy" invariant: they live on a
block of the studio's landing row (edited at `/settings/landing-page`) with
defaults in code, the way `/trial` reads its `paid_trial` block.

`/corp` shows the one live promo; `/corp/<promoKey>` reaches a specific one
later. A promo that is not live shows "not available right now", never a 404.

## Records and staff view (my call)

A claim row per attempt, service-role only (mig: `REVOKE ALL … FROM anon,
authenticated`, RLS on, no policy), holding promo key, location, contact,
un1t user, status (`granted` / `ineligible` / `help_requested` / `failed`),
the ledger id and the batch `expires_at`. Builder may instead extend
`trial_purchases` with a promo key and a zero price if that gives staff the
existing Paid trials tab and help cards for free; pick whichever keeps the
paid flow's states honest. Either way staff see every claim and every case
that needs them somewhere they already look, and a help case alerts staff
as `/trial`'s does.

## Public plumbing (constraints)

- Page outside auth-gated segments, on **all four** allowlists (proxy
  `publicPaths`, `AppShell` `PUBLIC_PATHS`, `un1t-marketing` `allowedPaths`,
  `DB_BRAND_DEFAULTS.allowedPaths`) for the whole flow, pinned in
  `src/public-compliance-paths.test.jsx`. noindex.
- `POST /api/public/corp-claims` (name the builder's call): no auth,
  rate-limited per IP, Zod body, `{ success, data?, error? }`, registered in
  `openapi.js` and `check:route-guards`' `EXEMPT` as a public route.
- Every Supabase write checked (`no-unchecked-supabase-write` armed on the
  new files), Hatch's zone through `@/lib/location-time` for any date shown.
- Changelog entry file per PR.

## Left to the builder

- Exact table/column names, the route path, the email template key.
- Copy defaults (short, in the `/trial` voice).
- Whether the page reuses `PaidTrialFunnel` with a free mode or a new small
  component, as long as it looks like `/trial`.

## Before go-live (Richard)

- Confirm Hatch's un1t.online token carries `credits:create` (it does for
  the re-grant).
- Approve the copy on the landing block.
