# Weekend Offer Sale — public offer pages + Revolut checkout + leads email

**Status:** approved approach (Option A), spec under review.
**Date:** 2026-08-08. **Sale window:** now → **Mon 11 Aug 2026, 23:59:59 Europe/Dublin**.
**Owner:** Richard. **Location:** Stillorgan (`a0000000-…0001`).

## 1. Goal

Sell five upfront-paid offers to the leads list this weekend:

| # | Slug | Offer | Bonus | Price (EUR) |
|---|---|---|---|---|
| 1 | `3-month-membership` | 3 Month Membership | +2 weeks free | €497 (incl. €100 off) |
| 2 | `6-month-membership` | 6 Month Membership | +1 month free | €1,044 (incl. €100 off) |
| 3 | `1-year-membership` | 1 Year Membership | +6 weeks free | €2,068 (incl. €100 off) |
| 4 | `30-class-pack` | 30 Class Pack | +10 classes free | €510 |
| 5 | `20-class-pack` | 20 Class Pack | +5 classes free | €380 |

Three deliverables: (a) a public sale landing page + one product page per offer with embedded Revolut checkout, (b) a paid → staff-fulfilment loop in the CRM (staff set the member up in Glofox manually), (c) a branded marketing email to the leads list with CTAs into the pages.

**Decisions already made:** one-off upfront payments (no recurring); staff fulfil in Glofox (no auto-provisioning); Revolut = the existing shared UN1T merchant account (`resolveLocationPaymentProvider` default, same rail as class-pay); sale copy hard-coded for v1 with offer name/price/bonus/window DB-editable.

## 2. What already exists (reuse, don't rebuild)

- **Revolut Merchant rail:** `src/lib/revolut.js` (`createOrder`, `getOrder`, `verifyWebhookSignature`), embedded checkout widget pattern (order created on submit via the SDK `createOrder` callback), idempotency keys, pinned API version. Precedents: car deposits, race payments, **class-pay** (`/class-pay/[id]` + `/api/webhooks/revolut/class-bookings`) — class-pay is the template for this build.
- **Webhook conventions:** dedicated signing secret per webhook URL with fallback to `REVOLUT_WEBHOOK_SECRET` (class-bookings route lines 41–42), `webhook_events` dedupe, fresh `getOrder()` state (never trust payload), always 200 on unrecognised events.
- **Public page plumbing:** proxy `publicPaths` + AppShell publicPaths + brand-domain allowlist (the `/free-class` / `/start` precedent — all three or it breaks).
- **Approvals framework:** drop a provider in `src/lib/approvals/providers/` + register — badge/count/tab come free.

## 3. Data model (one forward-only migration, next free number)

**`sale_offers`** — id uuid pk, `location_id` fk, `slug` text unique, `category` text check in (`membership`,`class_pack`), `name` text, `bonus_headline` text (e.g. "+2 WEEKS FREE"), `description` text, `price_cents` int, `currency` text default 'EUR', `active` bool default true, `starts_at`/`ends_at` timestamptz, `sort` int, timestamps. Seeded with the 5 offers in the same migration. Price/name/bonus/window editable in the DB without a deploy.

**`offer_purchases`** — id uuid pk, `offer_id` fk, `location_id` fk, `buyer_name`/`buyer_email`/`buyer_phone` text, `contact_id` fk nullable, `revolut_order_id` text unique, `amount_cents` int, `currency` text, `state` text check in (`created`,`paid`,`failed`,`cancelled`) default 'created', `paid_at`, `fulfilled_at`, `fulfilled_by` fk profiles nullable, timestamps. Indexes: `revolut_order_id`, `(state, location_id)`.

RLS per repo invariants: `security_invoker` on any view, per-command policies (never restrictive `FOR ALL`), `(SELECT auth.uid())`, one permissive policy per (table, command). Both `get_advisors` types after DDL. Service-role routes enforce access in app code.

## 4. Public pages (brand domain, same mechanism as `/free-class`)

- **`/offers`** — sale landing. Hero: LOCK IN YOUR MEMBERSHIP. Countdown to `ends_at`. Two sections (memberships, class packs), five cards, each linking to its product page. Server-renders from `sale_offers`.
- **`/offers/[slug]`** — product page. Offer name, bonus, price, what's included, buyer form (name, email, phone), embedded Revolut checkout. Success state confirms purchase + "we'll be in touch to get you set up".
- After `ends_at` (Dublin wall-clock via `dublinTodayStr`-family helpers, never naive `Date` maths): pages stay up, checkout replaced with a sale-ended message.
- Allowlists: add `/offers` to proxy `publicPaths`, AppShell publicPaths, and the brand-domain path allowlist. Public API routes live under `/api/public/` (already allowlisted).
- Design: UN1T brand (black/white, uppercase headings, hard-edged CTAs). Customer-facing, so a **mockup goes to Richard before the final page build** (his standing rule). No class-capacity numbers anywhere.

## 5. Checkout flow

1. Buyer fills the form and hits pay. Widget's `createOrder` callback POSTs `/api/public/offers/[slug]/checkout` (`validateBody` Zod: name, email, phone).
2. Server loads the offer by slug: must be `active` and inside `starts_at..ends_at` — otherwise 404/410. **Amount comes only from `sale_offers.price_cents`.** The client can never send a price.
3. Server creates the Revolut order (idempotency key, EUR, description = offer name) and inserts an `offer_purchases` row (`created`, order id). Returns the order token for the widget.
4. Buyer pays in the embedded widget (cards, Apple Pay, Google Pay).
5. **`POST /api/webhooks/revolut/offer-payments`** (new webhook URL, secret `REVOLUT_OFFER_WEBHOOK_SECRET`, fallback `REVOLUT_WEBHOOK_SECRET`): verify signature + timestamp, dedupe via `webhook_events`, `getOrder()` for fresh state, match `offer_purchases` by `revolut_order_id` (unknown order → 200 + ignore). `ORDER_COMPLETED` → state `paid`, stamp `paid_at` (only if unset). Failure/decline events → `failed`.
6. Fire-and-forget after paid (own try/catch, never blocks the 200): contact match by normalised email using `escapeLikePattern` equality (never bare `.ilike`, never `.eq` on mixed-case) → link `contact_id` or create a contact; tag `offer-sale-aug-2026` in **both** `contacts.tags` and `contact_tags`; staff notification email to the location.

## 6. Fulfilment (staff → Glofox, manual)

New approvals provider `src/lib/approvals/providers/offer-purchases.js`: pending = `paid` and `fulfilled_at IS NULL`. Row shows buyer, offer, amount, paid time. Action: **Mark fulfilled** (`POST /api/offer-purchases/[id]/fulfil` — standard mutation skeleton: `getCurrentUser` → role check → `assertLocationAccess` → write `fulfilled_at`/`fulfilled_by`). Staff set the membership/credits up in Glofox first, then mark fulfilled. Detail routes 404 not 403.

## 7. The email

UN1T brand HTML (table layout, inline CSS, preheader, 600px, black CTAs, NEXA-style uppercase). Structure: logo bar → hero "LOCK IN YOUR MEMBERSHIP" + deadline line ("Ends midnight Monday") → membership section (3 cards, each with bonus + price + LOCK IT IN button) → "STOCK UP ON CLASSES" section (2 cards) → primary CTA "SHOP THE SALE" → footer (Champ Champ Fitness Limited, Dublin + unsubscribe). Copy rules: no em-dashes, no gush, no emoji in body, coach voice. Buttons link to the product pages with `utm_source=email&utm_medium=campaign&utm_campaign=lock_in_aug_2026&utm_content=<slug>`.

Send via the CRM campaign rail (`/communications/send`) to the Stillorgan leads audience — the rail already enforces per-location marketing consent (`contact_location_audience` view) and unsubscribe. **Richard triggers the send**; nothing sends automatically.

## 8. Ops to go live (Richard, ~10 min)

1. Merge PR; migration applied via Supabase MCP (un1t-crm project) before deploy.
2. Register the new webhook URL via the Revolut API (`POST /api/webhooks` with `url: https://crm.un1tdublin.com/api/webhooks/revolut/offer-payments`, order events) → put returned `signing_secret` in Vercel as `REVOLUT_OFFER_WEBHOOK_SECRET`. (Until set, the route falls back to `REVOLUT_WEBHOOK_SECRET`.)
3. Sanity-buy one offer end-to-end (can refund from the Revolut dashboard).
4. Send the campaign.

## 9. Out of scope (v1)

Recurring billing; Glofox auto-provisioning; admin UI for editing offers (SQL edit is fine for the weekend); refunds UI (Revolut dashboard); discount codes; Hatch Street (Stillorgan only).

## 10. Testing

Vitest on: checkout route (price from DB, window enforcement, closed-sale 410), webhook route (signature, dedupe, idempotent paid stamp, unknown order 200), approvals provider, contact match/tag helper (using `ilikeMatches` test helper). Full CI mirror (all nine checks) + `npm run build` locally before push. Webhook + checkout routes registered in `openapi.js`; route-guard script satisfied (webhook verifies signature; public checkout under `/api/public/`).
