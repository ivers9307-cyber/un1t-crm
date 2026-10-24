# /trial: choose your studio, a trial-history check at Stillorgan, un1t.online checkout at Hatch Street

Design, 24 Oct 2026. Richard's decisions are marked "Richard"; everything else is the designer's call unless it says "builder".

## Why

On 24 Oct 2026 Caroline Bourke paid €39 on `/trial` for the UN1T 14 Day Reset at Stillorgan. Revolut took the money, the CRM asked Glofox to put the plan on her account, and Glofox refused with `THIS_MEMBERSHIP_CAN_ONLY_BE_PURCHASES_ONCE`: she had claimed the free UN1T Trial at Stillorgan on 17 Oct and attended two classes. The purchase sat in `needs_review`, she was told nothing, and Richard only heard about it from her. The first live purchase (Richard's own test on 21 Oct) failed the same way for the same reason.

Two things follow. A person who has already had a trial at Stillorgan must find that out BEFORE paying, not after. And Hatch Street, whose memberships live in un1t.online rather than Glofox, cannot sell the paid trial from this page at all today: the page is hard-wired to Stillorgan.

## What Richard asked for (Richard)

1. A "choose your studio" box on the purchase page: Hatch Street or Stillorgan Village.
2. Stillorgan: if the customer has had a trial in the past they are told they cannot redeem this one. The message carries an "I need help" button. Pressing it files a card on the Approvals page so somebody reviews the situation by hand and contacts the customer.
3. Hatch Street: let them buy even if they have had a membership or trial before. The purchase grants them "The UN1T Trial" in un1t.online: the €39 product, 14 days.

## Goals

- Nobody pays for a trial the CRM already knows Glofox will refuse.
- A refused Stillorgan customer gets a clear next step and lands in front of staff within the same minute.
- A Hatch Street customer can buy the 14-day trial from the same Meta-ad page and ends up with the product on their un1t.online account without staff touching it.
- Every word the customer reads stays operator-editable (CLAUDE.md: customer-facing copy must be editable).

## Non-goals

- No refunds, automatic or otherwise. The post-payment failure path at Stillorgan (`needs_review` + the Paid trials tab + the ops alert) stays as the backstop for anything the pre-check misses.
- No change to the free class-booking funnel (`/start`) at either studio.
- No new Glofox product, no change to the Glofox plan's own buy-once rule.
- No un1t.online credit grants and no un1t.online admin charges for this product (see Constraints).

## Anti-goals (a failure even if it works)

- Taking money at Stillorgan from someone the CRM could have told "no".
- Telling someone "you've had a trial" when the CRM only failed to look (a read error must never read as "had a trial").
- Taking the €39 twice at Hatch Street: once by the CRM and once by un1t.online.
- A Hatch purchase that un1t.online completed but the CRM never noticed (no Purchase conversion, no card, no record).

## Constraints the builder must respect

**un1t.online (Hatch Street).** The integration's standing rules (`docs/superpowers/specs/2026-10-17-un1t-online-write-back-design.md`, pinned by `tests/un1t-online-write-guard.test.js` and `tests/mia-no-charge-no-refund-guard.test.js`):
- `POST /purchases/charge` is called only for a live €0 product, inside `grantTrial`. Never for a paid product.
- `POST /credits/grant` is called only by the one-off trial re-grant. Never for a sale.
- A paid product is bought through un1t.online's hosted checkout (`createCheckoutLink` in `src/lib/un1t-online-write-ops.js`): un1t.online takes the money and puts the product on the account itself. The success and cancel URLs must be on the studio's customer site host (`isCustomerUrl`), so the customer lands on un1t.online's site after paying, not back on `/trial`.
- A checkout needs a un1t.online user: `ensureUn1tAccount` (`src/lib/un1t-online-account.js`) finds or creates one, and a create needs the customer's recorded acceptance of un1t.online's terms and liability waiver (`src/lib/un1t-online-legal.js`), the way the `/start` funnel at Hatch collects it. Its contract: `{ kind: 'existing'|'created', un1tUserId, executingContactId }`, `{ kind: 'card', reason }`, or `{ kind: 'retry', code }` (budget or throttle), and it reads `terms_accepted_at`, `terms_source`, `terms_version` off the request row.
- The success and cancel URLs of a checkout must be `https` on the studio's customer host (`isCustomerUrl`), which `resolveCustomerBaseUrl` resolves to the UN1T Dublin site (the tenant host), with any path allowed. So the buyer CAN be returned to `/trial`.
- Every un1t.online write row carries an `origin` constrained by mig 744's CHECK (`staff, funnel, approval, mia, test_account`); a new origin needs a migration.
- A created account has a random, never-stored password; the funnel's `runSetPasswordStep` (our explanation email, then un1t.online's reset code) is how the person gets in, unless `settings.un1t_online.un1t_sends_welcome` / `un1t_welcome_sets_login` say un1t.online does it.
- Every un1t.online request spends the studio's shared write budget (30 per minute, shared with Mia and the funnel).
- Hatch's writes are on in prod (`settings.un1t_online.writes_enabled = true`). The mirror (`un1t_transactions`, `un1t_products`, `un1t_clients`) refreshes every 15 minutes (`un1t-online-sync`).
- un1t.online sends its own receipt and booking emails; the CRM sends none for a un1t.online purchase.

**Glofox (Stillorgan).** The 14 Day Reset (`membership 620bdab4df0f8054814cd7be`, plan `1644944026897`) is a buy-once plan and Glofox refuses it to a member who has had a trial. The CRM cannot read Glofox's own rule; it reads its own mirror of the member.

**The page.** `/trial` exists (`src/app/trial/page.js`, `src/components/landing-page/PaidTrialFunnel.jsx`, `POST /api/public/trial-purchases`), is allowlisted on all four public-path lists, and is driven by Stillorgan's `paid_trial` landing block (`src/lib/paid-trial.js`). Hatch Street's landing row (`public_path 'hatch-street'`) has no `paid_trial` block yet.

**Money.** Revolut is Stillorgan's provider. `trial_purchases` (mig 762) is the one table for this page's purchases; its statuses are `awaiting_payment | queued | processing | granted | needs_review | failed | payment_failed`.

## The design

### 1. Choose your studio

The card opens with the studio choice above the details form: two large options, Hatch Street and Stillorgan Village. Each studio's option label, product name, price, duration and ticks come from that studio's own `paid_trial` landing block (`stillorgan` and `hatch-street` rows), so both are edited at `/settings/landing-page`. The default label is the studio's name; Richard's wording for Stillorgan is "Stillorgan Village", so the Stillorgan block's label is set to that.

`?studio=hatch` or `?studio=stillorgan` on the URL preselects an option (for ads that already name a studio). A studio whose block is missing or not sellable is shown as "not available online" and cannot be chosen; the page never 404s for paid traffic.

The POST carries the chosen studio; the server resolves the landing row and location from it, never from the client's say-so about price or product.

### 2. Stillorgan: the trial-history check, before any money

When the studio is Stillorgan, after the lead is captured and before the Revolut checkout link is made, the server decides whether this person has had a trial at Stillorgan. The contact is the one `findOrCreateRaceContact` matched: by email at the studio, then by email across the organisation. **No phone matching** (designer's call): a shared household number would land the check, and the help card's reasons, on a different person, which is the anti-goal; a returning trialer who types a new email is caught by the post-payment backstop instead.

"Had a trial" is any of, on that contact (designer's reading of Richard's "had a trial in the past": trial signals only, not past paying memberships, which Glofox has not been seen to refuse):
- a `glofox_trial_claims` row at Stillorgan for the contact's `glofox_member_id`;
- `contacts.glofox_membership_status` of `trial` or `no_sale_trial`, or a `glofox_membership_plan` whose name contains "trial" (case-insensitive);
- a `glofox_push_events` row at Stillorgan for the contact that created the account with the trial attached;
- a `trial_purchases` row for the contact at Stillorgan with status `granted`.

A brand-new contact (nothing matched) is eligible. **A failed read is neither**: the POST answers 503 "try again in a moment", the way an unreadable landing row does today; it never says "you've had a trial" and never takes money.

Not eligible: no `trial_purchases` row is inserted and no checkout is made. The response carries `code: 'trial_used'` and the studio's operator-editable `trial_used_text` (default: "It looks like you've already had a trial with us at Stillorgan, so the 14 Day Reset can't be redeemed on this account. If that's not right, or you'd like to talk about your options, tap I need help and the team will be in touch.").

The post-payment refusal path (Glofox says no after Revolut paid) is unchanged and remains the backstop.

### 3. "I need help"

The refused customer sees `trial_used_text` and one button, "I need help" (label editable). Pressing it:
- `POST /api/public/trial-purchases/help` with the same identity fields and the studio. Rate-limited like the purchase POST. The server re-matches the contact (never trusts a contact id from the browser).
- Inserts a `trial_purchases` row with status `help_requested`, `payment_status` null, `amount_cents` the product price (for the card's subtitle), and `last_error` set to the eligibility reasons found (for example `trial_used: glofox_trial_claim, membership_status=trial`).
- Sends the same ops alert as a failed grant, with the subject "Trial help request".
- Shows the customer the studio's operator-editable `help_sent_text` (default: "Thanks. The team at UN1T Stillorgan will be in touch shortly.").

On the Approvals page the Paid trials tab (provider `trial_purchases`, `src/lib/approvals/providers/trial-purchases.js`) lists `help_requested` rows alongside the `needs_review` ones, as a card headed "Needs a call" with the reasons, the contact's details, Open contact, and one action, **Mark handled**, which sets status `handled` (no email to the customer: staff contact them by hand). The tab's count includes them. Retry and Mark granted do not appear on a help card. The provider and the review route today require `payment_status = 'paid'`; a help row has none, so both learn the second kind. A Hatch Street refusal (section 4) files the same kind of row.

### 4. Hatch Street: un1t.online's checkout, no history check

When the studio is Hatch Street there is no trial-history check: a past trial, no trial, or an unused free trial may all buy (Richard). The one refusal is an **active membership** (Richard): on the matched contact (email only, as at Stillorgan), an active un1t.online subscription or membership at Hatch in the mirror (`un1t_subscriptions` / `contact_memberships` in `MEMBERSHIP_ACTIVE_STATUSES`, the set `src/lib/un1t-online-map.js` already defines). A match refuses before any un1t.online call, with the Hatch block's operator-editable `active_member_text` (default: "It looks like you already have an active membership at UN1T Hatch Street, which already covers your classes. If that's not right, tap I need help and the team will be in touch.") and the same "I need help" button and card as Stillorgan's (section 3). A failed read is 503 "try again", never a refusal. The flow after the lead is captured, all in the one POST (the browser is waiting to be redirected):
1. The form for Hatch includes un1t.online's terms and liability-waiver acceptance, exactly as `/start` collects it at Hatch (`un1tTermsPayload` / `readUn1tLegalDocs`), because a new un1t.online account needs it; the POST refuses `terms_required` without it, gated on the studio's `writes_enabled` (not `funnel_enabled`: this is not the funnel). The acceptance is recorded on the purchase row (`terms_accepted_at`, `terms_source 'website'`, `terms_version`), which is what `ensureUn1tAccount` reads.
2. A `trial_purchases` row is inserted first, with `payment_provider 'un1t_online'`, status `awaiting_payment`, the Hatch block's product name and duration, the mirrored price, and the un1t.online product id in a new column `un1t_product_id` (`membership_id`/`plan_code` become nullable: they are Glofox's).
3. `ensureUn1tAccount` finds or creates the un1t.online client (own link, same-email sibling, API walk, else create), origin `web_trial`. The un1t user id is stamped on the row (`un1t_user_id`, which the sweeper matches on).
4. `createCheckoutLink` for the block's `un1t_product_id`, origin `web_trial`, idempotency key `trial_purchase:<row id>`, success URL `https://<customer host>/trial?purchase=<id>&studio=hatch`, cancel URL the same with `&cancelled=1`. The write-events ledger id is stored on the row; the checkout URL is returned to the browser once and never stored or logged on the trial row (the ledger's own rule).
5. The browser goes to the un1t.online checkout. After paying, un1t.online returns the buyer to `/trial?purchase=<id>&studio=hatch`, which shows the confirming state off the public status route, as the Stillorgan redirect flow does today. The public state for a Hatch row: `pending` until the sweeper settles it, then `granted`. The confirming copy for Hatch says the purchase is being confirmed and un1t.online will email the receipt; it never says "it's on your account" before the row is `granted`.
6. `origin 'web_trial'` is new: a migration widens mig 744's CHECK on `un1t_write_events.origin`, and the guard tests that pin the ledger are updated (designer's call: staff reading the ledger should see a web sale as a web sale, not as the funnel).

Settling: the existing `process-trial-purchases` cron sweeps `awaiting_payment` rows with provider `un1t_online` and marks one `granted` when the mirror shows a `un1t_transactions` purchase for that `un1t_user_id` at Hatch dated after the row was created, amount above zero and not a subscription renewal (the `purchasesSince` rule in `src/lib/agent/purchase-settle.js`). The product is a one-off (`un1t_products.type 'one_time'`), so "charged once, nothing renews" stays true on the card. On granted it sends the Meta Purchase conversion (value, currency, order id = the row id, event id `trialpurchase-<id>`, as Stillorgan does), and, for an account the CRM created (`kind 'created'`), runs the funnel's set-password step so the buyer can get into the account that holds the product (skipped when un1t.online sends its own welcome, per the studio's settings). No other email. A row still unpaid 24 hours plus a 45-minute grace after creation becomes `expired`, silently (the grace is `EXPIRY_GRACE_MS`'s reason: a payment just before the deadline that the 15-minute sync has not shown yet is still a purchase). Nothing is ever charged by the CRM for a Hatch purchase.

Retry outcomes: a budget or throttle answer from `ensureUn1tAccount` or `createCheckoutLink` (`kind 'retry'`, or a retryable write result) marks the row `failed` with the code and answers 503 "try again in a moment"; the customer's next attempt is a new row. The purchase POST's rate limit stays as it is (8 per 15 minutes per landing path and IP).

Refusals: a refused account create (`kind 'card'`), a refused checkout (including un1t.online's own "already purchased" limit if the product carries one), or an unclear answer files the row as `help_requested` (not `needs_review`: nothing was paid, so the Paid trials tab's Retry and Mark granted do not apply) with the refusal code in `last_error`, sends the ops alert, and shows the customer the Hatch block's `help_sent_text` (default: "Thanks, the team at UN1T Hatch Street will be in touch to set up your trial."). The customer is never told "you've had a trial" at Hatch.

### 5. The Hatch Street block

A `paid_trial` block on the `hatch-street` landing row with: label, product name ("The UN1T Trial"), duration 14 days, ticks, `trial_used_text` (unused at Hatch but kept for symmetry), `help_sent_text`, and `un1t_product_id = 674d62bf-4d4b-4231-b1ba-d53543657bea`. Its price is NOT typed: for a un1t.online studio the price is read off `un1t_products` for that id (un1t.online owns the price; a mismatch would be a lie on the card). `paidTrialConfigFromBlocks` stays pure: it grows a second shape, and the caller passes the mirrored product in. A block is sellable when it has either a Glofox `membership_id` + `plan_code` and a typed price, or a `un1t_product_id` whose mirrored product is active with a positive price. The settings editor at `/settings/landing-page` shows the right fields for the studio's `membership_source`.

Richard: the product is 14 days. The mirror shows it as a one-off (`type 'one_time'`) with a one-month billing interval; the page shows the block's duration (14 days), and the product's real validity is whatever un1t.online is configured to, which Richard checks in un1t.online.

The page's own chrome stops being Stillorgan's: the title and description come from the organisation chrome ("The UN1T Trial — UN1T Dublin" shape, from `resolveOrgChrome`), the header logo is the organisation's, and the hero image stays as it is. Studio-specific words live only on the two blocks.

### 6. Meta events

Server-side (CAPI) Lead, InitiateCheckout and Purchase go to the chosen studio's own dataset, as `sendWebsiteConversion` does today. Browser-side, `/trial` keeps loading only the site pixel (`src/lib/meta-pixel-paths.js`), so a Hatch buyer's browser events land in the UN1T Web dataset while the server events land in Hatch's, with no browser pairing there (designer's call: loading Hatch's pixel on `/trial` would also put every Stillorgan buyer's browser events in Hatch's dataset, and a pixel that loads after the studio is chosen is a change to the consent-gated loader that this build does not need; Richard can ask for it if Hatch's ad set needs browser-paired events). Purchase fires at Stillorgan on grant (today) and at Hatch on settle (new); the browser Purchase on the `/trial?purchase=` return shares the `trialpurchase-<id>` event id with the server's, as today. A refused Stillorgan customer fires Lead only.

### 7. `/start` is retired behind a redirect to `/trial` (Richard)

The free class-booking funnel's campaign is finished at both studios. `/start`, `/start/stillorgan` and `/start/hatch-street` answer a redirect to `/trial`, carrying the studio from the path as `?studio=stillorgan` / `?studio=hatch` so an old ad link lands on the right option, and keeping the query string (UTM parameters, `fbclid`) so attribution survives. Nothing is deleted: the funnel's pages, routes, blocks and settings stay, so it can be switched back on when it is needed again. The redirect lives in one place (the `/start` page files, or `legacy-redirects.js`, builder's choice) with a comment saying why and how to reverse it. The `class_funnel` block on the `/hatch-street` landing page is a separate surface and is not touched by this.

Because the free funnel is retired, the Hatch `trial_product_id` setting that points at the €39 product (open question 1 below) needs no change now; it is noted for whenever `/start` returns.

### 8. Escaping in the staff alert and the buyer emails

`alertStaff` in `src/lib/trial-purchase-processor.js` builds its HTML by interpolating `customer_name`, `customer_email`, `customer_phone`, `product_name` and the Glofox reason text as typed, and `src/lib/trial-purchase-emails.js` does the same with the buyer's names. Everything on this page is typed by an anonymous visitor, so a name like `<img src=x onerror=…>` reaches a staff inbox as markup. Every interpolated value in both files is HTML-escaped (one small `escapeHtml` helper, or the repo's existing one if there is one), and the help request's alert (section 3) goes through the same escaped builder. Flagged by the automated security review on 24 Oct 2026.

## Left to the builder

- Component structure of the studio picker and how the card swaps product copy; the mobile layout.
- The exact eligibility query shape and its tests (one fixture per signal, plus the read-failure case).
- Migration: new statuses (`help_requested`, `handled`, `expired`), `payment_provider 'un1t_online'`, the `un1t_product_id`, `un1t_user_id`, `terms_accepted_at`, `terms_source`, `terms_version` and write-events ledger id columns, nullable `membership_id`/`plan_code`, an index for the un1t sweeper; and the widened `un1t_write_events.origin` CHECK.
- Where the un1t sweeper lives and its page size (under the 1,000-row cap).
- Rate limits for the help endpoint.
- The Approvals card component for the help request (`TrialPurchaseReviewCard.jsx` grows a second mode or gets a sibling).
- OpenAPI registration, the public-paths test, the changelog entry.

## Open questions for Richard

1. Answered (Richard, 24 Oct): `/start` is a finished campaign at both studios; hide it behind a redirect to `/trial` (section 7). The Hatch `trial_product_id` setting, which points the free funnel at the €39 product (`674d62bf…`) while the €0 three-credit product is `f2454b17-39c0-46ca-a6e0-af40a0c7cede`, stays as it is for now and must be repointed before `/start` is ever switched back on.
2. Answered (Richard, 24 Oct): at Hatch Street an active membership is refused (with "I need help"); a past trial, no trial, or an unused trial may all buy. Section 4.
