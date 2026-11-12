# Black Friday per-studio offer pages: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/offers/stillorgan` and `/offers/hatch-street`, each selling that studio's Black Friday offers from 23 Nov to 30 Nov 2026. Stillorgan pays through Revolut. Hatch memberships and packs pay through un1t.online's hosted checkout, and every Hatch purchase of a Black Friday product (on the page or off it) lands in staff's Offer sales list.

**Architecture:** `sale_offers` gains a per-studio slug and an optional `un1t_product_id`. The checkout route picks the rail by that column. The `offers` pages become `[studio]` and `[studio]/[slug]` routes, configured by a small studio map plus copy from `locations.settings.offers_page` (with defaults). Hatch purchases are recorded in `offer_purchases` (`payment_provider = 'un1t_online'`) by a new sweep that reads the `un1t_transactions` mirror. The sweep runs as an arm of the `un1t-online-sync` cron, with its own heartbeat row. Paid rows then flow into the existing Offer sales page and the Approvals tab unchanged.

**Tech Stack:** Next.js 16 App Router (server components), Supabase (service role), vitest, Revolut (existing), un1t.online write layer (existing `ensureUn1tAccount` / `createCheckoutLink` / `runSetPasswordStep`).

**Spec:** `docs/superpowers/specs/2026-11-12-black-friday-offers-design.md`

## Global Constraints

- Studio keys and location slugs: `stillorgan` → `un1t-stillorgan`; `hatch-street` → `un1t-hatch-street`.
- Sale window instants: open `2026-11-23T00:00:00Z`, close `2026-11-30T23:59:59Z`. Cyber Monday gifts open `2026-11-30T00:00:00Z`.
- No was-price and no "€100" discount copy anywhere on `/offers`.
- `OFFER_SALE_TAG` = `'offer-sale-bf-2026'`.
- New un1t.online ledger origin: `'web_offer'`. The only un1t.online write calls are `ensureUn1tAccount`, `createCheckoutLink` and `runSetPasswordStep`. Never `/purchases/charge` and never `/credits/grant`.
- Hatch customer host is `un1t-group.repset.ie` (its `tenant_domains` row already allows `/offers`). The un1t.online success and cancel URLs come from `resolveCustomerBaseUrl(db, hatchLocationId)` + `/offers/hatch-street/<slug>?purchase=<id>`.
- No `'Europe/Dublin'` literal. Display dates through `formatSaleDeadline(…, { zone })` and `displayZoneFor`.
- Every supabase write is awaited and its `error` destructured. Zero-row CAS updates are judged by `.select('id')` length.
- Migrations go through the Supabase MCP on `iyvtbjjxdggiadzwwvdj`. Run `get_advisors` (security) after DDL. The schema migration is applied before deploy. The heartbeat and data migrations are applied after deploy.
- Next free migration number is **827** (re-check after any `git merge origin/main`).
- CI mirror (CLAUDE.md, all thirteen) plus `npm run build` must pass before the PR.

## Review Focus

1. **A un1t.online transaction for a Black Friday product dated outside the window, with no page row,** must NOT be listed. Pinned by `sweep ignores off-window off-page transactions` (Task 5).
2. **The same transaction seen on two sync runs** must give exactly one `offer_purchases` row. Pinned by `sweep is idempotent across runs` (Task 5) and the unique index (Task 1).
3. **A Hatch membership row with no `un1t_product_id`** (the 1-month before Richard's product exists) must never fall through to Revolut. Pinned by `hatch membership without product is refused` (Task 4).
4. **The Revolut reconcile and dispute paths must ignore `un1t_online` rows** (their `revolut_order_id` is NULL). Pinned by `reconcile skips un1t_online rows` (Task 4).
5. **An old link `/offers/30-class-pack?purchase=<id>`** (a Revolut return from a pre-deploy order) must land on `/offers/stillorgan/30-class-pack?purchase=<id>`. Pinned by `legacy slug redirects with purchase` (Task 3).

---

### Task 1: Schema migration (827)

**Files:**
- Create: `supabase/migrations/827_black_friday_offers.sql`
- Create: `tests/black-friday-offers-migration.test.js`

**Interfaces:**
- Produces columns:
  - `sale_offers.un1t_product_id text NULL`
  - `sale_offers.fine_print text NOT NULL DEFAULT ''`
  - `offer_purchases.payment_provider text NOT NULL DEFAULT 'revolut' CHECK (payment_provider IN ('revolut','un1t_online'))`
  - `offer_purchases.origin text NOT NULL DEFAULT 'page' CHECK (origin IN ('page','off_page'))`
  - `offer_purchases.un1t_user_id text`, `un1t_product_id text`, `un1t_transaction_id text`
  - `offer_purchases.last_error text`
  - `offer_purchases.terms_accepted_at timestamptz`, `terms_source text`, `terms_version text`
- Constraints: drop `sale_offers_slug_key` and add `UNIQUE (location_id, slug)`. `offer_purchases.revolut_order_id` loses NOT NULL (unique kept). `UNIQUE (location_id, un1t_transaction_id)`. CHECK that a `revolut` row has `revolut_order_id`.
- `un1t_write_events_origin_check` admits `'web_offer'` and keeps every origin in mig 787's list. A `DO` self-check raises if any listed origin is missing (copy mig 787 lines 130-146).

- [ ] **Step 1: Write the failing test.** `tests/black-friday-offers-migration.test.js` reads the SQL file text and asserts:
  - it contains `UNIQUE (location_id, slug)`;
  - it contains `DROP NOT NULL` on `revolut_order_id`;
  - the origin list contains each of `'staff','funnel','approval','mia','test_account','web_trial','fee_run','corp_promo','web_offer'`;
  - it contains `un1t_transaction_id` in a unique constraint with `location_id`;
  - it does not contain `GRANT` to `anon`.
- [ ] **Step 2:** Run `npx vitest run tests/black-friday-offers-migration.test.js`. Expected: FAIL (file missing).
- [ ] **Step 3:** Write the migration. Add a header comment naming BLACKFRIDAY.1, and `COMMENT ON COLUMN` for each new column.
- [ ] **Step 4:** Run the test. Expected: PASS. Then run `npm run check:select-columns` and `npm run check:rls-restrictive`. Expected: clean.
- [ ] **Step 5:** Apply via the Supabase MCP `apply_migration` (name `827_black_friday_offers`). Verify with `execute_sql`: `select conname from pg_constraint where conrelid='public.sale_offers'::regclass` shows the composite unique. Then run `get_advisors` type security and expect no new findings.
- [ ] **Step 6:** Commit: `BLACKFRIDAY.1 — sale_offers per-studio slugs, un1t.online purchase columns (mig 827)`.

### Task 2: Studio config, storefront rules and copy

**Files:**
- Create: `src/lib/offer-studios.js`, `src/lib/offer-studios.test.js`
- Modify: `src/lib/sale-offers.js` (add `offerIsUpcoming`, change `OFFER_SALE_TAG`), `src/lib/sale-offers.test.js`
- Modify: `src/lib/offers-storefront.js` (studio-aware hero), `src/lib/offers-storefront.test.js` (create if absent)
- Delete: `src/lib/offers-home.js`. Every importer moves to `offer-studios.js`. Run `git grep offers-home` to find them.

**Interfaces:**
- Produces, in `offer-studios.js`:
  - `OFFER_STUDIOS: Record<string, { key: string, locationSlug: string, label: string }>` with exactly `stillorgan` and `hatch-street`
  - `studioForKey(key: string): object | null`
  - `studioForLocationSlug(slug: string): object | null`
  - `async resolveOfferStudio(db, key): Promise<{ studio, location: { id, slug, name, organization_id, membership_source, settings } } | null>`. It returns null for an unknown key or a missing row, and throws on a DB error.
  - `offersPageCopy(location): { marquee, line1, line2, blurb, legalLine, infoBlocks: Array<{ title: string, lines: string[] }> }`. It reads `location.settings.offers_page`, and each missing field falls back to `DEFAULT_OFFERS_PAGE_COPY`.
- Produces, in `sale-offers.js`: `offerIsUpcoming(offer, now = new Date()): boolean` (active and `starts_at` > now).
- Produces, in `offers-storefront.js`: `heroFor(offers, copy)`. A timed sale (any membership or class_pack among open or upcoming) uses `copy`. Gift-only uses `GIFT_HERO` with the studio label. `storefrontTitle(categories, studioLabel)`.

`DEFAULT_OFFERS_PAGE_COPY` (exact, from the brief):
- marquee: `'BLACK FRIDAY HEAD START · '`; line1: `'BLACK FRIDAY'`; line2: `'HEAD START'`
- blurb: `'Bonus time and classes on every membership and pack.'`
- legalLine: `''` (Stillorgan's row in Task 8 sets `'CHAMP CHAMP FITNESS LIMITED, DUBLIN, IRELAND'`)
- infoBlocks:
  1. `Current members`: "Bring a friend: the friend gets a free Reset + Black Friday pricing" · "Free HYROX SIM or UN1TY entry for each friend who joins" · "Most friends brought in wins 3 months free"
  2. `Former members`: "Rejoin for the €99 first month, plus Black Friday bonuses" · "Bring a friend free for 1 month" · "Talk to the team at the desk or reply to our email to rejoin"
  3. `Black Friday Open Week`: "23–29 Nov at the studio" · "Come and try a class, and bring a friend"

- [ ] **Step 1: Failing tests.**
  - `studioForKey('hatch-street').locationSlug === 'un1t-hatch-street'`; `studioForKey('nope') === null`.
  - `offersPageCopy({ settings: {} }).line2 === 'HEAD START'`.
  - `offersPageCopy({ settings: { offers_page: { blurb: 'X' } } }).blurb === 'X'`, and its infoBlocks are still the defaults.
  - `offerIsUpcoming({ active: true, starts_at: '2026-11-23T00:00:00Z' }, new Date('2026-11-22T23:59:59Z')) === true`, and `false` at `2026-11-23T00:00:00Z`.
  - `OFFER_SALE_TAG === 'offer-sale-bf-2026'`.
  - `heroFor([{ category: 'gift_card' }], copy).line1 === 'GIVE THE GIFT'`.
  - `heroFor([{ category: 'class_pack' }], copy).line2 === copy.line2`.
- [ ] **Step 2:** Run `npx vitest run src/lib/offer-studios.test.js src/lib/sale-offers.test.js src/lib/offers-storefront.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. `resolveOfferStudio` selects named columns from `locations` by `slug` with `.maybeSingle()` and destructures `error`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `BLACKFRIDAY.2 — studio map, upcoming state, studio offer copy`.

### Task 3: Routes: studio picker, studio storefront, product page

**Files:**
- Modify: `src/app/offers/page.js` (now the studio picker)
- Modify: `src/app/offers/layout.js` (fonts and frame only; the studio queries move out)
- Create: `src/app/offers/[studio]/layout.js` (metadata via `storefrontTitle`, footer with the studio label, deadline and `legalLine`)
- Create: `src/app/offers/[studio]/page.js` (storefront, or legacy redirect)
- Create: `src/app/offers/[studio]/[slug]/page.js` (product page, moved from `src/app/offers/[slug]/page.js`)
- Delete: `src/app/offers/[slug]/page.js`
- Create: `src/lib/offers-legacy-redirect.js` + test
- Modify: `src/components/offers/OfferCheckout.jsx` (props below)

**Interfaces:**
- Consumes: Task 2 (`resolveOfferStudio`, `offersPageCopy`, `heroFor`, `offerIsUpcoming`, `OFFER_STUDIOS`).
- Produces: `legacyOfferRedirect(slug: string, purchase: string | null): string`, which returns `/offers/stillorgan/${slug}`, plus `?purchase=…` when given.
- `OfferCheckout` props: `{ studio: string, slug: string, priceLabel: string, provider: 'revolut' | 'un1t_online', terms: object | null, resumePurchaseId: string | null }`. It POSTs to `/api/public/offers/${studio}/${slug}/checkout`.
  - On `data.checkout.provider === 'un1t_online'`, it does `window.location.assign(data.checkout.url)`.
  - For `un1t_online`, the resume state shows "Thanks, your payment is with un1t.online. We'll be in touch within 24 hours to add your bonus." with no poll.
  - When `terms` is set it renders a required tick using `terms.label` / `terms.links` (the `un1tTermsPayload` shape, as /trial renders it) and sends `terms_accepted: true`. A 400 `terms_required` response re-renders the tick from `j.terms`.

Rules:
- `[studio]/page.js`:
  - A known key renders the storefront.
  - Otherwise, if a Stillorgan `sale_offers` row has that slug, `redirect(legacyOfferRedirect(slug, sp.purchase))`.
  - Otherwise, `notFound()`.
- The storefront lists rows of the studio that are open or upcoming, `active` only, ordered by `sort`.
  - An upcoming card shows the label `Opens <formatSaleDeadline(starts_at, {uppercase:false, zone})>` and is still a link.
  - The countdown shows "Sale ends" against the earliest-closing open dated row. If none is open, it shows "Opens" against the earliest `starts_at` among upcoming rows.
  - A gift row whose `starts_at` is later than the earliest membership `starts_at` gets the flag `Cyber Monday only`.
  - The info blocks from `offersPageCopy` render under the products.
- Remove `was` from both pages and the `€100` line from `includesFor`. `includesFor(offer, studio)` uses `studio.label` in place of "UN1T Stillorgan" and appends `offer.fine_print` when it is non-empty. For a gift row with `fine_print`, drop the generic "Spend it on any membership…" and "Valid for 5 years…" lines, because the fine print states that gift's own terms. The evergreen cards (empty `fine_print`) keep them. The Hatch cards also show `fine_print` under the price (renewal line).
- The product page: an upcoming offer shows "Opens <date>" in place of the form. Closed shows the existing ended panel. `provider` is `'un1t_online'` when `offer.un1t_product_id` is set. `terms` is passed only for a un1t provider (built with `un1tTermsPayload({ terms: await studioTermsCopy(db, locationId), studioName: location.name, publicPath: '/offers/hatch-street' })`).
- The picker at `/offers` shows two large links, "UN1T Stillorgan" → `/offers/stillorgan` and "UN1T Hatch Street" → `/offers/hatch-street`, under the default copy's hero.

- [ ] **Step 1: Failing tests.** In `src/lib/offers-legacy-redirect.test.js`:
  - `legacy slug redirects with purchase`: `legacyOfferRedirect('30-class-pack','abc') === '/offers/stillorgan/30-class-pack?purchase=abc'`.
  - Without purchase there is no query string.
  - The purchase value is `encodeURIComponent`-ed.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the helper, the pages, the layout split and the component props.
- [ ] **Step 4:** Run `npx vitest run src/lib/offers-legacy-redirect.test.js src/public-compliance-paths.test.jsx`. Expected: PASS (`/offers` is already allowlisted in all four places, and nested paths match by prefix).
- [ ] **Step 5:** Commit: `BLACKFRIDAY.3 — /offers studio picker, per-studio storefronts and product pages`.

### Task 4: Checkout route with two rails

**Files:**
- Create: `src/app/api/public/offers/[studio]/[slug]/checkout/route.js` + `route.test.js`
- Modify: `src/app/api/public/offers/[slug]/checkout/route.js`. It becomes a shim: `POST(request, props)` calls the new handler with `studio = 'stillorgan'`. It is kept for pages loaded before the deploy.
- Create: `src/lib/offer-checkout-un1t.js` + test (the Hatch leg)
- Modify: `src/lib/revolut-reconcile.js`, `src/lib/revolut-disputes.js`, and any other `offer_purchases` reader that selects `state='created'` or keys on `revolut_order_id` (from `git grep -n offer_purchases src/lib src/app`). Add `.eq('payment_provider','revolut')`.
- Modify: `src/lib/openapi.js` (register the new route).

**Interfaces:**
- Consumes: Task 1 columns, Task 2 `resolveOfferStudio`.
- Produces: `startUn1tOfferCheckout(db, { offer, location, contact, purchaseId, terms }): Promise<{ kind: 'redirect', checkoutUrl } | { kind: 'help_filed' } | { kind: 'unavailable', code }>`. Its steps:
  1. Insert the `offer_purchases` row: provider `un1t_online`, origin `page`, state `created`, `un1t_product_id` = `offer.un1t_product_id`, the terms fields, and the buyer fields.
  2. Call `ensureUn1tAccount` with origin `'web_offer'` and `originRef: purchaseId`, then stamp `un1t_user_id`.
  3. Call `createCheckoutLink` with `idempotencyKey: 'offer_purchase:'+purchaseId` and success/cancel URLs from the Global Constraints.
  4. On a refusal, card, or unknown result: set state `failed`, set `last_error` (`un1t_account_refused: <code>` / `un1t_checkout_refused: <code>` / `un1t_outcome_unknown: <code>`), send one `sendOpsAlert` with the subject `BLACK FRIDAY: <buyer> needs help buying <offer.name>` (with buyer name, email and phone), and return `help_filed`.
  5. On `Un1tSettingsReadError` or a retryable refusal: set state `failed` and return `unavailable`.
  Mirror `trial-purchase-un1t-checkout.js`'s error mapping. Logs carry ids and codes only.
- Route behaviour (in order):
  1. Validate the body: `{ name, email, phone, terms_accepted?: boolean }`.
  2. Rate limit: the existing `offerco:` key.
  3. `resolveOfferStudio`, then `sale_offers` by `(location_id, slug)` with `.maybeSingle()`. Missing → 404.
  4. Not open → 410 `sale_ended`. Upcoming → 409 `not_open_yet`.
  5. If the location's `membership_source === 'un1t_online'` and the category is `membership` or `class_pack`:
     - No `un1t_product_id` → 409 `not_configured`, and never Revolut.
     - Read `un1t_products.price_cents` for `(location_id, un1t_id)`. Not equal to `offer.price_cents` → 409 `price_mismatch` plus one `logError('offers', …)`.
     - Writes off → 409 `not_configured`.
     - `terms_accepted !== true` → 400 `terms_required` with the `terms` payload (as /trial).
     - Find or create the contact via `findOrCreateRaceContact` (restrictToOrg, `lead_source: 'offer_sale'`), then call `startUn1tOfferCheckout`.
     - Answers: `redirect` → 200 `{ success, data: { purchaseId, checkout: { provider: 'un1t_online', url } } }`; `help_filed` → 202 `{ success: false, code: 'help_filed', error: "We couldn't open the checkout. The team has your details and will be in touch today." }`; `unavailable` → 503 `{ code: 'busy', error: 'Busy right now, please try again in a minute.' }`.
  6. Otherwise, Revolut as today. `redirectUrl` → `${origin}/offers/${studio}/${slug}?purchase=${purchaseId}`. Insert with `payment_provider: 'revolut'`.

- [ ] **Step 1: Failing tests** (mock db, `createOrder`, `ensureUn1tAccount`, `createCheckoutLink`, following `trial-purchase-un1t-checkout.test.js`'s mocks):
  - `stillorgan offer uses revolut with studio redirect`: `createOrder` gets `redirectUrl` ending `/offers/stillorgan/20-class-pack?purchase=<id>`.
  - `hatch gift card uses revolut`: a Hatch `gift_card` row with no product goes to `createOrder`.
  - `hatch membership without product is refused`: 409 `not_configured`, and `createOrder` is not called.
  - `hatch price mismatch is refused`: `un1t_products.price_cents` 62700 vs offer 59700 → 409 `price_mismatch`.
  - `hatch requires terms`: no tick → 400 `terms_required`.
  - `hatch happy path redirects`: 200 `checkout.provider === 'un1t_online'`. `createCheckoutLink` gets `origin: 'web_offer'` and `idempotencyKey: 'offer_purchase:<id>'`. The inserted row has `payment_provider: 'un1t_online'` and `revolut_order_id` undefined.
  - `upcoming offer is refused`: `starts_at` in the future → 409 `not_open_yet`.
  - `reconcile skips un1t_online rows`: in `revolut-reconcile` tests, the candidate query includes `.eq('payment_provider','revolut')`.
  - `old slug route delegates to stillorgan`: the shim calls the handler with `studio: 'stillorgan'`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, then `npm run check:route-guards`, `npm run check:location-scoping` and `npx vitest run tests/un1t-online-write-guard.test.js tests/mia-no-charge-no-refund-guard.test.js`. Expected: PASS. If the write guard pins `createCheckoutLink` callers, add `src/lib/offer-checkout-un1t.js` to its allowed list, with a comment naming BLACKFRIDAY.4.
- [ ] **Step 5:** Commit: `BLACKFRIDAY.4 — offer checkout: Revolut or un1t.online hosted checkout per studio`.

### Task 5: Hatch purchase sweep

**Files:**
- Create: `src/lib/un1t-offer-purchases.js` + `src/lib/un1t-offer-purchases.test.js`

**Interfaces:**
- Consumes: Task 1 columns, `linkOrCreateContactForPurchase` and `notifyStaffOfPaidPurchase` (sale-offers.js), `runSetPasswordStep`, `sendUn1tAccountEmail`, `readUn1tWriteSettings`.
- Produces: `sweepUn1tOfferPurchases(db, locationId, { now = () => Date.now() } = {}): Promise<{ ok: boolean, checked: number, recorded: number, matchedPage: number, expired: number, failed: number }>`. It never throws.

Algorithm:
1. Read the location's `sale_offers` with `un1t_product_id` not null. None → `{ ok: true }`. Let `windowStart` = min `starts_at`.
2. Read `un1t_transactions` for the location:
   - `product_id` in the set, `remote_created_at >= windowStart`, `.order('remote_created_at')`, `.range` paginated at 500;
   - keep only `amount_cents > 0`, `type !== 'sub_renewal'`, `refunded !== true`.
3. Read the existing `offer_purchases.un1t_transaction_id` for the location (paginated). Skip any transaction already used. Within a run, use each transaction once.
4. For each transaction, find its offer by `product_id`. The transaction qualifies if `remote_created_at` is within `[starts_at, ends_at]`. It also qualifies if it is later than `ends_at` and there is a page row `(un1t_user_id, offer_id, state 'created', created_at <= ends_at)`.
5. If a matching page row (`state 'created'`, same `un1t_user_id` and `offer_id`, `created_at <= remote_created_at`, oldest first) exists: CAS `state 'created' → 'paid'` with `paid_at = remote_created_at`, `un1t_transaction_id`, `amount_cents` from the transaction. Then run `linkOrCreateContactForPurchase`, `notifyStaffOfPaidPurchase`, and the set-password step. The set-password step uses origin `'web_offer'` and `emailArgs { kind: 'trial_purchase', productName: offer.name, copy: { subject: 'Your UN1T Hatch Street account', body: <default below> } }`.
6. Otherwise: insert a row with origin `off_page`, state `paid`, provider `un1t_online`, `un1t_user_id`, `un1t_product_id`, `un1t_transaction_id`, `amount_cents`, `paid_at`.
   - Buyer fields come from the contact behind `un1t_clients.contact_id`: `name`, or first + last, or `'un1t.online client'`; email and phone default to `''`.
   - Set `contact_id` directly and write `OFFER_SALE_TAG` via `writeContactTag`.
   - A 23505 on the unique index counts as already recorded, not failed.
   - Then `notifyStaffOfPaidPurchase`.
7. Expire: page rows still `created` for this location with provider `un1t_online` older than `UN1T_TRIAL_EXPIRY_MS` (import it) → `cancelled` (CAS).
8. `ok` is false only if a read in steps 1-3 failed. A failed side effect increments `failed` and is logged with `logError`, ids only.

Default set-password body: "Thanks for your Black Friday purchase at UN1T Hatch Street. We've set up your un1t.online account. Check your inbox for a code to set your password, then book your first class in the app."

- [ ] **Step 1: Failing tests** (fake db in the style of `trial-purchase-un1t-settle.test.js`):
  - `sweep records off-page purchase in window`: a transaction for the 3-month product at `2026-11-24T10:00Z` with no page row → one insert with origin `off_page`, state `paid` and `un1t_transaction_id` set.
  - `sweep ignores off-window off-page transactions`: the same at `2026-11-22T10:00Z` and at `2026-12-01T10:00Z` → no insert.
  - `sweep honours late payment for a page row`: page row created `2026-11-30T23:50Z`, transaction `2026-12-01T00:30Z` → the CAS update to `paid`.
  - `sweep is idempotent across runs`: run twice over the same transaction → one row.
  - `sweep skips renewals and refunds`: `type 'sub_renewal'` or `refunded: true` → nothing.
  - `sweep never matches a different product`: a trial-product transaction does not settle a 3-month page row.
  - `sweep expires stale page rows`: a page row created 26h before now → `cancelled`.
  - `sweep read failure is not ok`: the transactions read errors → `ok: false` and no writes.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `BLACKFRIDAY.5 — Hatch offer purchase sweep off the un1t.online mirror`.

### Task 6: Cron arm and heartbeat

**Files:**
- Modify: `src/app/api/cron/un1t-online-sync/route.js` (+ its test)
- Create: `supabase/migrations/828_un1t_offer_purchase_sweep_heartbeat.sql` (copy mig 805's shape; name `'un1t-offer-purchase-sweep'`, same interval and grace as 805). Applied **after** the deploy.

**Interfaces:** Consumes `sweepUn1tOfferPurchases` from Task 5. `OFFER_PURCHASE_HEARTBEAT = 'un1t-offer-purchase-sweep'`.

- [ ] **Step 1: Failing tests** in the route test:
  - `offer purchase sweep stamps its own heartbeat when clean`;
  - `offer sweep failure does not stop the sync heartbeat`;
  - `offer sweep timeout leaves its heartbeat unstamped`.
  Copy the PAIDTRIALTRIGGER.1b arm tests.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Add the arm after the €39 purchase arm. Same per-location try/catch/deadline race, with its own `OFFER_CAP_MS`.
- [ ] **Step 4:** Run the route tests. Then run `grep -L stampHeartbeat src/app/api/cron/*/route.js`; it still lists only `health-check` and `ad-insights-backfill`. Expected: PASS.
- [ ] **Step 5:** Commit: `BLACKFRIDAY.6 — offer purchase sweep as an un1t-online-sync arm (mig 828 after deploy)`.

### Task 7: Staff copy in Offer sales

**Files:**
- Modify: `src/app/(money)/offer-sales/page.js` (select `payment_provider, origin, un1t_user_id` as well; subtitle "Paid Black Friday and sale purchases. Set the member up, add the bonus, then mark the sale fulfilled.")
- Modify: `src/components/OfferSalesList.jsx` (+ test if present). Each row shows the bonus to add (`offer.bonus_headline`), plus:
  - for `un1t_online` rows, a chip `un1t.online` and the line "Paid in un1t.online. Add the bonus there.";
  - for `off_page`, a second chip `Bought in app/desk`.
  Chips follow the `bg-<c>-500/10 text-<c>-700` rule.
- Modify: `src/lib/sale-offers.js` `notifyStaffOfPaidPurchase`. When `purchase.payment_provider === 'un1t_online'`, the last line reads "Already paid in un1t.online. Add the bonus (<bonus_headline>) there, then mark the sale fulfilled in Approvals." Otherwise it is unchanged.

- [ ] **Step 1: Failing tests:**
  - `notifyStaffOfPaidPurchase un1t copy`: the html contains `Add the bonus` and not `Glofox` for a `un1t_online` purchase;
  - an `OfferSalesList` render shows `un1t.online` for such a row.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `npm run check:guardrails`. Expected: PASS.
- [ ] **Step 5:** Commit: `BLACKFRIDAY.7 — Offer sales shows un1t.online and off-page purchases with the bonus to add`.

### Task 8: Black Friday catalogue data (migration 829, after deploy)

**Files:**
- Create: `supabase/migrations/829_black_friday_offer_rows.sql`
- Create: `tests/black-friday-offer-rows.test.js`

Rows. Membership and pack rows run `starts_at '2026-11-23 00:00:00+00'` to `ends_at '2026-11-30 23:59:59+00'`; gift rows `starts_at '2026-11-30 00:00:00+00'`, same `ends_at`. All rows `active true`.
- Retire the old Stillorgan timed rows: `UPDATE sale_offers SET active=false WHERE location_id=<stillorgan> AND category IN ('membership','class_pack')`. Then upsert (on `(location_id, slug)`) the new rows.
- **Stillorgan** (`a0000000-0000-0000-0000-000000000001`), membership and packs (slug / name / bonus_headline / price_cents / sort):
  - `1-year-membership` / 12 Month Membership / `+3 MONTHS FREE` / 216900 / 1
  - `6-month-membership` / 6 Month Membership / `+6 WEEKS FREE` / 114400 / 2
  - `3-month-membership` / 3 Month Membership / `+3 WEEKS FREE` / 59700 / 3
  - `1-month-membership` / 1 Month Membership / `+2 WEEKS FREE` / 9900 / 4
  - `30-class-pack` / 30 Class Pack / `+10 CLASSES FREE` / 51000 / 5
  - `20-class-pack` / 20 Class Pack / `+5 CLASSES FREE` / 38000 / 6
- **Stillorgan gifts:**
  - `cyber-monday-gift-card` / €100 Gift Card + €20 Bonus / `+€20 BONUS CARD` / 10000 / 7. fine_print: "Your €100 gift card is valid for 5 years. The free €20 bonus card can be used from 1 January to 28 February 2027."
  - `gift-a-reset` / Gift a Reset / `GIFT A RESET` / 3900 / 8. fine_print: "One Reset at UN1T Stillorgan, to be used within 12 months. If they've had a trial with us before, we'll give them €39 of credit instead."
  - The four evergreen gift cards are untouched.
- **Hatch** (`28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`), slugs and names as Stillorgan, with `un1t_product_id`:
  - 1-year 226800 / `a85d6e20-43a8-428a-8af4-5e305ac60aaf`. fine_print: "Renews at €2,268 every 12 months after your bonus time. Cancel any time before."
  - 6-month 119400 / `d60b05bb-6a51-40f3-8643-32321c45fdcb`. fine_print: "Renews at €1,194 every 6 months after your bonus time. Cancel any time before."
  - 3-month 62700 / `de6fbadc-fea7-4854-855e-8649f3abc305`. fine_print: "Renews at €627 every 3 months after your bonus time. Cancel any time before."
  - 30-pack 54000 / `b1d7ab46-ba9e-4d28-918f-2f81009bb9d8`
  - 20-pack 40000 / `741855ef-9a50-4337-af2e-dbe087665af8`
  - 1-month 9900 / **`active false`, `un1t_product_id NULL`**, until Richard's product exists
  - The two gift rows as Stillorgan, with "UN1T Hatch Street" in the Reset fine_print and no product id (Revolut).
- Descriptions (both studios): "12 months of unlimited coached training, plus 3 months on the house." (and the equivalent for 6 months / 6 weeks, 3 months / 3 weeks, 1 month / 2 weeks), "30 classes, plus 10 more on the house.", "20 classes, plus 5 more on the house.", and for the gift card "Buy a €100 gift card and get a €20 bonus card free.". The Gift a Reset description is "Give someone their first step into UN1T: a Reset, on us to give."
- `UPDATE locations SET settings = jsonb_set(coalesce(settings,'{}'),'{offers_page}', '{"legalLine":"CHAMP CHAMP FITNESS LIMITED, DUBLIN, IRELAND"}')` for Stillorgan only.

- [ ] **Step 1: Failing test.** `tests/black-friday-offer-rows.test.js` reads the SQL and asserts:
  - each of the 12 prices appears;
  - every Hatch membership or pack row has a product id except the 1-month, which is `false`/NULL;
  - no row text contains `€100 off` or `discount`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Write the SQL.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `BLACKFRIDAY.8 — Black Friday catalogue rows for both studios (mig 829, after deploy)`.

### Task 9: Verify, document, ship

- [ ] **Step 1:** Run the full CI mirror (the thirteen commands in CLAUDE.md), then `npm run build`. Expected: all green.
- [ ] **Step 2:** Run `npm run dev` via preview, with mig 829's rows applied to a local or preview-safe state, or else check against prod data after the deploy. Check:
  - `/offers` (picker);
  - `/offers/stillorgan` and `/offers/hatch-street` (teaser, "Opens" countdown, info blocks, no was-price, Hatch renewal lines);
  - `/offers/30-class-pack` redirects;
  - a Hatch product page shows the terms tick.
  Take screenshots at 375px and desktop.
- [ ] **Step 3:** Add `docs/changelog/entries/<PR>.md` after `gh pr create`. Add a one-line invariant to CLAUDE.md: "Hatch Black Friday/offer purchases are recorded by `sweepUn1tOfferPurchases` off the un1t.online mirror; `offer_purchases.payment_provider='un1t_online'` rows have no Revolut order."
- [ ] **Step 4:** Push the branch, open the PR. After merge and deploy, apply migs 828 and 829 and re-run `get_advisors`.

## Open items for Richard (not blocking the build)

- Hatch's legal-entity footer line (`offers_page.legalLine` on Hatch). It is left blank until he gives it.
- Gift a Reset's 12-month validity against the 5-year Gift Vouchers Act minimum. It lives in `fine_print`, so it can change with SQL only.
- Create the €99 one-off un1t.online product. Then set the Hatch `1-month-membership` row's `un1t_product_id` and `active = true`.
- Final wording of the renewal lines and info blocks (both are data).
