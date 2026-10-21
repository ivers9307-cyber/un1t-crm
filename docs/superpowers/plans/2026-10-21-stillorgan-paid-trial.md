# Stillorgan paid 2-week trial — Meta ads product page (PAIDTRIAL.1)

**Goal (Richard, 21 Oct 2026):** a product page for Stillorgan's Meta ads (its own ad account, separate from Hatch Street's) selling a 2-week trial for €39. After the payment settles, the trial is put on the customer's profile: an existing contact and Glofox member gets the membership added; a new person gets a CRM contact, a Glofox account and the membership. Carry the Hatch ads-page learnings: one price panel that the eye lands on, lead captured at the POST (never a step earlier), trial first and book after payment, machine-readable refusal codes, attribution from the landing URL, Lead and Purchase to the studio's own Meta dataset.

**Decisions taken (defaults that mirror the paid intro the class funnel already runs):**
1. The CRM takes the €39 through the studio's payment rail (`resolveLocationPaymentProvider`: Revolut for UN1T). The Glofox product is a **€0 plan** named for the trial (created 21 Oct as "1) The Un1t 14 Day Reset"), bought on the account with `purchaseGlofoxMembership` after the money is in. Glofox never charges; the invoice it mints is the €0 "paid online" record. Richard creates that plan in Glofox Stillorgan and picks it in the block editor (membership id + plan code, the same picker the class funnel uses).
2. The product lives as a landing block `paid_trial` on Stillorgan's `landing_page_settings` row, so every customer-facing string, the price, the duration and the Glofox plan are operator-editable. The page is `/trial` (UN1T-only, like `/start`; not served on tenant hosts).
3. Fulfilment is a queue row in `trial_purchases` (mig 762), processed by a QStash worker with a 2-minute cron sweeper, exactly the class-bookings shape. One row = one purchase; `status` is the lifecycle; `grant` is a write-ahead marker so a purchase Glofox never answered is never bought twice (TRIALGRANT.1 rule).
4. The existing free-trial rules do NOT apply: a paid trial is granted to a returner too (they paid for it), and it never buys the free trial product (`attachTrial: false`).
5. A failure after the money is taken is never silent: the row goes `needs_review`, an ops alert goes to the org's recipients, and staff grant by hand in Glofox. No refund path in v1.
6. The Revolut webhook for class bookings (`/api/webhooks/revolut/class-bookings`) also resolves trial rows, so no new Revolut dashboard configuration is needed.

**Out of scope for v1:** booking the first class inside the flow (the done screen points at the booking app), an approvals card for failed grants (ops alert instead), refunds, a second studio.

## Files

| File | Action |
|---|---|
| `supabase/migrations/762_trial_purchases.sql` | table, indexes, RLS closed, heartbeat row |
| `src/lib/landing-page-blocks.js` | `PAID_TRIAL_DEFAULT`, registry entry |
| `src/lib/paid-trial.js` (+test) | `paidTrialConfigFromBlocks`, pure state helpers |
| `src/lib/trial-purchase-payments.js` (+test) | create payment, resolve by ref, mark status (release) |
| `src/lib/trial-purchase-processor.js` (+test) | ensure Glofox account, grant plan with write-ahead marker, review on failure |
| `src/lib/trial-purchase-queue.js` | claim CAS + bookkeeping |
| `src/lib/trial-purchase-emails.js` | 'granted' transactional email (operator-editable template name) |
| `src/app/api/public/trial-purchases/route.js` | POST: capture lead, insert row, open payment |
| `src/app/api/public/trial-purchases/[id]/route.js` | GET: status poll with provider re-check |
| `src/app/api/webhooks/revolut/class-bookings/route.js` | also resolve trial rows |
| `src/app/api/webhooks/qstash/trial-purchases/route.js` | worker |
| `src/app/api/cron/process-trial-purchases/route.js` + `vercel.json` | sweeper + heartbeat |
| `src/components/landing-page/PaidTrialFunnel.jsx` | client: details → pay → done; resumes on `?purchase=` |
| `src/components/landing-page/ClassFunnelCheckout.jsx` | `statusPath` prop (default unchanged) |
| `src/components/landing-page/BlockRenderers.jsx`, `LandingPageSettingsForm.jsx` | renderer + editor for the block |
| `src/app/trial/page.js` | the page |
| `src/proxy.js`, `AppShell.jsx`, `brands.js`, `public-compliance-paths.test.jsx` | public path |
| `src/lib/qstash.js` | `TRIAL_PURCHASES_WORKER_PATH` |
| `src/lib/openapi.js` | the two public routes |
