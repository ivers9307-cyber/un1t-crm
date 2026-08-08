# Weekend Offer Sale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public `/offers` sale pages with embedded Revolut checkout for 5 upfront-paid offers, a paid→fulfilment loop in Approvals, and a branded leads email. Spec: `docs/superpowers/specs/2026-08-08-offer-sale-pages-design.md`.

**Architecture:** Clone the class-pay Revolut rail: server-side order creation (price from DB only) → embedded widget → dedicated signed webhook → `offer_purchases.state='paid'` → approvals provider + staff email. Pages are public marketing-host pages (three-allowlist pattern, `/free-class` precedent).

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes, RLS-enabled tables), Revolut Merchant (`src/lib/revolut.js`), Vitest, Zod.

**Worktree:** `~/code/un1t-crm-offer-sale`, branch `offer-sale-pages`. Sale window: now → `2026-08-11 23:59:59+01` (Dublin).

**Repo invariants that bind every task:** service-role routes enforce access in app code (404 not 403); forward-only migrations via Supabase MCP against `iyvtbjjxdggiadzwwvdj` + both `get_advisors` types after DDL; `await` every insert/update; `escapeLikePattern` for email equality; webhook idempotent + 200 on unrecognised; no naive Dublin date maths; `type="button"` on non-submit buttons; register routes in `src/lib/openapi.js`.

---

### Task 1: Migration — `sale_offers` + `offer_purchases`

**Files:**
- Create: `supabase/migrations/503_sale_offers.sql` (confirm 503 is the next free number with `ls supabase/migrations | tail -1`; duplicate prefixes exist on purpose elsewhere — do not renumber old files)

- [ ] **Step 1: Write the migration**

```sql
-- OFFERS.1 — weekend "lock in" sale: offers catalogue + purchases.
-- Both tables are service-role-surface only (public pages and staff UI go
-- through /api routes); RLS is enabled with a single authenticated SELECT
-- and no client write policies.

create table sale_offers (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  slug text not null unique,
  category text not null check (category in ('membership','class_pack')),
  name text not null,
  bonus_headline text not null,
  description text not null default '',
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'EUR',
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table sale_offers enable row level security;
create policy sale_offers_select on sale_offers
  for select to authenticated using (true);

create table offer_purchases (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references sale_offers(id),
  location_id uuid not null references locations(id),
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text not null default '',
  contact_id uuid references contacts(id),
  revolut_order_id text not null unique,
  amount_cents integer not null,
  currency text not null default 'EUR',
  state text not null default 'created'
    check (state in ('created','paid','failed','cancelled')),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  fulfilled_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index offer_purchases_state_loc on offer_purchases (state, location_id);
alter table offer_purchases enable row level security;
create policy offer_purchases_select on offer_purchases
  for select to authenticated using (true);

-- Seed the August sale (Stillorgan). Editable later via SQL without deploys.
insert into sale_offers
  (location_id, slug, category, name, bonus_headline, description, price_cents, ends_at, sort)
values
  ('a0000000-0000-0000-0000-000000000001','3-month-membership','membership','3 Month Membership','+2 WEEKS FREE','Three months of unlimited coached training, with an extra two weeks on the house. Includes 100 euro off.',49700,'2026-08-11 23:59:59+01',1),
  ('a0000000-0000-0000-0000-000000000001','6-month-membership','membership','6 Month Membership','+1 MONTH FREE','Six months of unlimited coached training, with a full extra month added automatically. Includes 100 euro off.',104400,'2026-08-11 23:59:59+01',2),
  ('a0000000-0000-0000-0000-000000000001','1-year-membership','membership','1 Year Membership','+6 WEEKS FREE','A full year of unlimited coached training, with six extra weeks for committing to the year. Includes 100 euro off.',206800,'2026-08-11 23:59:59+01',3),
  ('a0000000-0000-0000-0000-000000000001','30-class-pack','class_pack','30 Class Pack','+10 CLASSES FREE','Buy 30 classes, train on 40. Our biggest class pack bonus of the sale.',51000,'2026-08-11 23:59:59+01',4),
  ('a0000000-0000-0000-0000-000000000001','20-class-pack','class_pack','20 Class Pack','+5 CLASSES FREE','Buy 20 classes, train on 25. A full extra week of sessions, free.',38000,'2026-08-11 23:59:59+01',5);
```

Before writing, verify the Stillorgan location id: `select id, name from locations` via the Supabase MCP `execute_sql` — the seed must reference the real row.

- [ ] **Step 2: Apply via Supabase MCP** — `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects` first; NOT sentinel). Name: `503_sale_offers`.

- [ ] **Step 3: Run `get_advisors` type=security AND type=performance.** Expect no new findings attributable to these tables (the single-SELECT-policy shape avoids `multiple_permissive_policies`; wrap nothing in `auth.uid()` — no user-scoped policies here).

- [ ] **Step 4: Commit** — `git add supabase/migrations/503_sale_offers.sql && git commit -m "OFFERS.1 — sale_offers + offer_purchases (mig 503)"`

### Task 2: `src/lib/sale-offers.js` — domain helpers (TDD)

**Files:**
- Create: `src/lib/sale-offers.js`, `src/lib/sale-offers.test.js`

- [ ] **Step 1: Write failing tests** covering: `offerIsOpen` (inactive → false; before `starts_at` → false; after `ends_at` → false; inside window → true — construct dates as absolute instants, e.g. `new Date('2026-08-11T22:59:00Z')` vs ends `2026-08-11T22:59:59Z`); `formatEuro(49700) === '€497'` and `formatEuro(104400) === '€1,044'`; `markOfferPurchaseState` maps Revolut states (`completed`→`paid` + stamps `paid_at` only when unset; `failed`→`failed`; `cancelled`→`cancelled`; unknown state → no-op) and is idempotent (second `completed` call does not overwrite `paid_at`). Use the repo's supabase mock pattern — copy the arrangement from `src/lib/class-booking-payments.test.js`.

- [ ] **Step 2: Run** `npx vitest run src/lib/sale-offers.test.js` — expect FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// sale-offers.js — domain logic for the weekend "lock in" sale.
export function offerIsOpen(offer, now = new Date()) {
  if (!offer?.active) return false
  const t = now.getTime()
  return t >= new Date(offer.starts_at).getTime() && t <= new Date(offer.ends_at).getTime()
}

export function formatEuro(cents) {
  return '€' + (cents / 100).toLocaleString('en-IE', { maximumFractionDigits: 0 })
}

export async function resolveOfferPurchaseByOrderId(db, orderId) {
  const { data } = await db.from('offer_purchases')
    .select('*, offer:offer_id ( id, slug, name, price_cents )')
    .eq('revolut_order_id', orderId).maybeSingle()
  return data || null
}

const STATE_MAP = { completed: 'paid', failed: 'failed', cancelled: 'cancelled' }

export async function markOfferPurchaseState({ db, purchase, providerState }) {
  const next = STATE_MAP[providerState]
  if (!next || purchase.state === next) return { changed: false, state: purchase.state }
  if (purchase.state === 'paid') return { changed: false, state: 'paid' } // never downgrade a paid row
  const patch = { state: next, updated_at: new Date().toISOString() }
  if (next === 'paid' && !purchase.paid_at) patch.paid_at = new Date().toISOString()
  const { error } = await db.from('offer_purchases').update(patch).eq('id', purchase.id)
  if (error) throw new Error(`offer_purchases update: ${error.message}`)
  return { changed: true, state: next }
}
```

(`new Date().toISOString()` for *timestamps* is fine — the guardrails lint bans it only for Dublin business-*day* derivation.)

- [ ] **Step 4: Run tests → PASS. Step 5: Commit** `"OFFERS.2 — sale-offers domain helpers"`

### Task 3: Contact link/tag + staff notification helper (TDD)

**Files:**
- Modify: `src/lib/sale-offers.js` (+ tests)

- [ ] **Step 1: Failing tests:** `linkOrCreateContactForPurchase` — (a) existing contact matched by normalised email via **escaped** ilike (assert with `ilikeMatches` from `src/lib/like-escape.test-helpers.js`, and assert a literal `_` in an email does NOT match a different contact); (b) no match → creates a contact with name/email/phone + `location_id`; (c) tags `offer-sale-aug-2026` written to BOTH `contacts.tags` and `contact_tags` (two-system invariant); (d) links `contact_id` back onto the purchase row.

- [ ] **Step 2: Run → FAIL. Step 3: Implement** using `normalizeEmail` + `escapeLikePattern` (`src/lib/like-escape.js`), scoping every contacts query by the purchase's `location_id`. Copy the tag-both-systems sequence from the gympass identification helper (`grep -rn "contact_tags" src/lib/gympass*.js` for the exact insert shape). Notification: `notifyStaffOfPaidPurchase(db, purchase)` — reuse the transactional Postmark send used by `src/lib/booking-confirmations.js` (same import, same from-address resolution via `getLocationBranding`), subject `NEW SALE — {offer.name} — {buyer_name}`, body listing buyer contact details + "set them up in Glofox, then mark fulfilled in Approvals". Fire-and-forget caller-side; the helper itself throws so tests can assert, callers wrap in try/catch.

- [ ] **Step 4: Run → PASS. Step 5: Commit** `"OFFERS.3 — contact linking, tagging, staff notification"`

### Task 4: Public checkout + status routes (TDD)

**Files:**
- Create: `src/app/api/public/offers/[slug]/checkout/route.js` (+ `route.test.js`)
- Create: `src/app/api/public/offer-purchases/[id]/route.js` (+ test)

- [ ] **Step 1: Failing tests:** checkout — 404 unknown slug; 410 `{ error: 'sale_ended' }` when `offerIsOpen` false; happy path calls `createOrder` with `amount === offer.price_cents` from the DB row (assert the request body amount can NOT be influenced by the POST body), inserts `offer_purchases` row (`state='created'`, `revolut_order_id` from order, `amount_cents = offer.price_cents`), returns `{ success: true, data: { purchaseId, checkout: { provider: 'revolut', token } } }`; Zod rejection (missing email) → 400 with `issues`. Status route — 404 unknown id; `{ success: true, data: { paid: false } }` for `created`; `paid: true` for `paid`. Mock `@/lib/revolut`.

- [ ] **Step 2: Run → FAIL. Step 3: Implement checkout:**

```js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { createOrder } from '@/lib/revolut'
import { offerIsOpen } from '@/lib/sale-offers'
import { validateBody } from '@/lib/validation' // confirm exact path: grep -rn "export function validateBody" src/lib

const checkoutSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(6).max(30),
})

export const runtime = 'nodejs'

export async function POST(request, ctx) {
  const { slug } = await ctx.params
  const body = await validateBody(request, checkoutSchema)
  if (body.error) return body.error // follow the repo's validateBody usage exactly (copy from /api/public/class-booking)

  const db = createServerClient()
  const { data: offer } = await db.from('sale_offers').select('*').eq('slug', slug).maybeSingle()
  if (!offer) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!offerIsOpen(offer)) return NextResponse.json({ success: false, error: 'sale_ended' }, { status: 410 })

  const purchaseId = crypto.randomUUID()
  const order = await createOrder({
    amount: offer.price_cents,               // server-side price ONLY
    currency: offer.currency,
    description: `UN1T — ${offer.name}`,
    metadata: { offer_purchase_id: purchaseId, offer_slug: offer.slug, location_id: offer.location_id },
    idempotencyKey: purchaseId,
  })

  const { error } = await db.from('offer_purchases').insert({
    id: purchaseId, offer_id: offer.id, location_id: offer.location_id,
    buyer_name: body.data.name, buyer_email: body.data.email, buyer_phone: body.data.phone,
    revolut_order_id: order.id, amount_cents: offer.price_cents, currency: offer.currency,
  })
  if (error) return NextResponse.json({ success: false, error: 'Could not start checkout' }, { status: 500 })

  return NextResponse.json({ success: true, data: {
    purchaseId, checkout: { provider: 'revolut', token: order.token },
  } })
}
```

Status route mirrors `/api/public/class-booking-payments/[id]` — returns only `{ paid }`, never buyer PII. Both routes: check `scripts/check-route-guards` handling for `/api/public/` (they should pass as public token/paid routes — if the script complains, follow how existing `/api/public/class-booking` is classified, don't blanket-EXEMPT).

- [ ] **Step 4: Run → PASS. Step 5:** register both routes in `src/lib/openapi.js` (copy an existing public-route registration). **Step 6: Commit** `"OFFERS.4 — public checkout + status routes"`

### Task 5: Revolut offers webhook (TDD)

**Files:**
- Create: `src/app/api/webhooks/revolut/offer-payments/route.js` (+ `route.test.js`)
- Modify: `src/lib/webhook-events.js` (add `REVOLUT_OFFER: 'revolut_offer'` to `WEBHOOK_PROVIDERS`; first check whether mig 107's table has a provider CHECK constraint — `grep -n "provider" supabase/migrations/107*.sql` — if yes, extend it in mig 503 style with a small follow-up migration before coding)

- [ ] **Step 1: Failing tests** (clone `src/app/api/webhooks/revolut/class-bookings/route.test.js` arrangement): 401 bad signature; 200 + dedupe on second identical event; 200 `skipped: 'unknown_order'` for unmatched order id; `ORDER_COMPLETED` → `getOrder` called, purchase → `paid`, contact helper + notify helper invoked; contact/notify failure does NOT fail the response (200 still); `ORDER_PAYMENT_FAILED` → `failed`; GET → 200.

- [ ] **Step 2: Run → FAIL. Step 3: Implement** — copy `class-bookings/route.js` structure verbatim, swapping: secrets `[process.env.REVOLUT_OFFER_WEBHOOK_SECRET, process.env.REVOLUT_WEBHOOK_SECRET]`, provider `WEBHOOK_PROVIDERS.REVOLUT_OFFER`, resolver `resolveOfferPurchaseByOrderId`, marker `markOfferPurchaseState`, and after a state change to `paid` run fire-and-forget (own try/catch): `linkOrCreateContactForPurchase` then `notifyStaffOfPaidPurchase`. No QStash. GET returns `{ success: true, ok: 'offer-payments revolut webhook endpoint' }`.

- [ ] **Step 4: Run → PASS. Step 5: Commit** `"OFFERS.5 — revolut offer-payments webhook"`

### Task 6: Approvals provider + fulfil route (TDD)

**Files:**
- Create: `src/lib/approvals/providers/offer-purchases.js` (+ test), `src/app/api/offer-purchases/[id]/fulfil/route.js` (+ test)
- Modify: `src/lib/approvals/registry.js` (register provider), `src/lib/permissions*.js` wherever `approvals_*` keys live (`grep -rn "approvals_contractor_invoices" src/lib shared/` and mirror every touchpoint — `WEB_PERMISSIONS`, role defaults, and the mobile-parity decision: give it the same treatment the most recently added `approvals_*` key got; `check:mobile-parity` will fail until you do)

- [ ] **Step 1: Failing tests:** provider `fetchPending` returns paid+unfulfilled rows scoped to `user.activeLocation` with title `{buyer_name}`, subtitle `{offer name} · €{amount}`, and `countPending` matches; fulfil route — 401 no user, 404 wrong-location id (not 403), happy path stamps `fulfilled_at` + `fulfilled_by`, second call is a 200 no-op.

- [ ] **Step 2: Run → FAIL. Step 3: Implement** — provider clones `contractor-invoices.js` with `.eq('state','paid').is('fulfilled_at', null)`; `permissionKey: 'approvals_offer_purchases'`, `label: 'Offer sales'`, `reviewUrl: '/approvals?tab=offer_purchases&focus={id}'` (match how existing tabs deep-link). Fulfil route follows the mutation skeleton: `getCurrentUser` → `hasPermission(user, 'approvals_offer_purchases')` (403) → load row → `assertLocationAccess` (404 on failure) → update. Register in openapi.js.

- [ ] **Step 4: Run → PASS. Step 5: Commit** `"OFFERS.6 — approvals fulfilment queue + fulfil route"`

### Task 7: Public pages — mockup gate, then build

**Files:**
- Create: `src/app/offers/page.js`, `src/app/offers/[slug]/page.js`, `src/components/offers/OfferCheckout.jsx`, `src/components/offers/SaleCountdown.jsx`
- Modify: `src/lib/brands.js` (add `'/offers'` to un1t-marketing `allowedPaths`), `src/proxy.js` (`publicPaths` + `'/offers'`), `src/components/AppShell.jsx` (publicPaths + `'/offers'`)

- [ ] **Step 1: MOCKUP GATE.** Build a single static HTML mockup (landing + one product page, black/white UN1T aesthetic, uppercase display type, hard-edged CTAs, countdown strip) and show Richard. **Do not build the real pages until he approves the direction.** (His standing rule for customer-facing surfaces.)

- [ ] **Step 2: Build pages** after approval. `/offers/page.js`: server component, `createServerClient()`, select active offers ordered by `sort`, render hero (LOCK IN YOUR MEMBERSHIP / Ends midnight Monday), `SaleCountdown` (client, ticks to `ends_at` passed as ISO prop), two sections, cards linking to `/offers/[slug]`. `/offers/[slug]/page.js`: server component; unknown slug → `notFound()`; closed sale → renders sale-ended state (no checkout). Both `export const metadata = { robots: { index: false, follow: false } }`, `export const dynamic = 'force-dynamic'`, reuse `SiteHeader`/`SiteFooter` from `@/components/landing-page/BlockRenderers`. **No class-capacity numbers anywhere.**

- [ ] **Step 3: `OfferCheckout.jsx`** — clone `ClassFunnelCheckout.jsx` minus the Stripe branch: buyer form (name/email/phone, every non-submit button `type="button"`), on submit POST `/api/public/offers/[slug]/checkout`, then mount the Revolut embed with the returned token (`createOrder: async () => ({ publicId: token })`), poll `/api/public/offer-purchases/[id]` every 3s as the paid fallback, success panel: "You're locked in. We'll be in touch within 24 hours to set you up."

- [ ] **Step 4: Allowlists ×3** — grep-verify all three after editing: `grep -n "offers" src/lib/brands.js src/proxy.js src/components/AppShell.jsx`. Missing any one breaks logged-out access (the `/free-class` lesson).

- [ ] **Step 5:** `npm run dev` → verify `localhost:3000/offers` renders logged-out (incognito), product page renders, closed-offer state renders (temporarily set an offer inactive via SQL to check, then revert). **Step 6: Commit** `"OFFERS.7 — public /offers pages + embedded checkout"`

### Task 8: The leads email

**Files:**
- Create: `~/code/un1t-email-campaign/lock-in-sale-email.html` (lives with the other campaign emails, not in the CRM repo)

- [ ] **Step 1: Build** per the un1t-brand-emails skill: table layout, inline CSS, 600px, preheader ("Extra weeks and free classes on every plan. Ends midnight Monday."), black logo bar, hero LOCK IN YOUR MEMBERSHIP + deadline line, 3 membership cards + STOCK UP ON CLASSES + 2 pack cards (each: name, bonus headline, price, black LOCK IT IN button → `https://un1tdublin.com/offers/<slug>?utm_source=email&utm_medium=campaign&utm_campaign=lock_in_aug_2026&utm_content=<slug>`), single SHOP THE SALE primary CTA → `/offers`, footer (Champ Champ Fitness Limited, Dublin, Ireland + unsubscribe placeholder matching the campaign rail's merge tag — copy the exact tag from an existing sent campaign template). Copy rules: **no em-dashes**, no emoji in body, no gush, coach voice. Subject: `LOCK IN YOUR MEMBERSHIP. ENDS MIDNIGHT MONDAY.`

- [ ] **Step 2:** Render preview to Richard (send the HTML file). He sends it via `/communications/send` to the Stillorgan leads audience — the rail enforces consent + unsubscribe. Nothing sends from this plan.

### Task 9: CI, docs, PR

- [ ] **Step 1:** Full CI mirror (all nine) + `npm run build` (new routes/pages = build required locally).
- [ ] **Step 2:** `docs/CHANGELOG.md` entry (OFFERS.1–7). Add `REVOLUT_OFFER_WEBHOOK_SECRET` to the env-var table in `docs/architecture/INTEGRATIONS.md`.
- [ ] **Step 3:** Push, `gh pr create --base main --fill`, report PR URL + the go-live checklist (webhook registration curl with the offers URL, Vercel env var, sanity purchase, send campaign).

---

## Self-review notes

- Spec §3 migration → Task 1; §5 checkout → Tasks 2/4; §5.5–6 webhook + fire-and-forget → Tasks 3/5; §6 fulfilment → Task 6; §4 pages + allowlists → Task 7; §7 email → Task 8; §8 ops → PR body (Task 9). No gaps.
- Names used consistently: `offerIsOpen`, `formatEuro`, `resolveOfferPurchaseByOrderId`, `markOfferPurchaseState`, `linkOrCreateContactForPurchase`, `notifyStaffOfPaidPurchase`.
- Two deliberate "confirm at implementation" points (validateBody import path; webhook_events provider constraint) are verification steps with exact grep commands, not placeholders.
