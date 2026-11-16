# STAFFPAYLINK.1 Hatch Street staff payment link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a contact's Hatch card, staff pick a product and send a WhatsApp "Pay now" link; the customer (new or existing) pays on un1t.online's hosted checkout and the CRM marks the link paid.

**Architecture:** A service-role table `staff_payment_links` holds one row per link (token hashed). A staff route sends it (cta_url inside the 24h window, an approved UTILITY template outside, copied from the cancellation-form route). A public page `/buy/<token>` plus `POST /api/public/buy/<token>` finds or creates the un1t.online account (`ensureUn1tAccount`) and makes the checkout (`createCheckoutLink`) only on the customer's tap. A new arm of the */2 `process-trial-purchases` cron marks links paid off the `un1t_transactions` mirror.

**Tech Stack:** Next.js 16 App Router, Supabase (service role), vitest, Zod, Meta WhatsApp Cloud API, un1t.online write layer.

**Spec:** `docs/superpowers/specs/2026-11-15-hatch-payment-link-design.md`

## Global Constraints

- Ticket prefix `STAFFPAYLINK.1`; commits `STAFFPAYLINK.1 — <summary>`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The CRM never charges a card: only `createCheckoutLink` (un1t.online hosted checkout). Never `/purchases/charge`, `charge-custom`, `/credits/grant`.
- Staff never accept terms for the customer: account creation only with `terms_accepted_at` recorded from the customer's own POST.
- The token and the checkout URL are never logged, never stored on `staff_payment_links` (token: sha256 hex only). Log ids and codes only (`logWarn/logError`, module `paylink`).
- Link lifetime 7 days (`STAFF_PAYMENT_LINK_TTL_MS = 7 * 24 * 60 * 60_000`). One live link per contact per studio; a new send revokes the previous one.
- Live statuses: `sent`, `opened`, `checkout_started`. Terminal: `paid`, `expired`, `revoked`.
- Paid = a `un1t_transactions` row with the link's `un1t_user_id` AND `product_id = un1t_product_id`, `remote_created_at >= created_at`, `amount_cents > 0`, `type !== 'sub_renewal'`, `refunded !== true`. A transaction with no product never counts.
- Price shown on the public page is the CURRENT `un1t_products` price; a product no longer active/sellable → expired page.
- Existing members see the same page without the ticks (one extra tap). GET never writes to un1t.online; GET may only stamp `opened`.
- Template must be APPROVED + UTILITY and its URL button rooted on the studio's customer host (`templateUrlPrefixOk`); else 409 `needs_template` when the window is closed.
- Not gated on marketing consent; refused when the contact is WhatsApp-opted-out at the studio or undeliverable.
- Customer-facing copy operator-editable: `locations.settings.un1t_online.payment_link` `{ template_name, whatsapp_text, button_text, page_* }` with code defaults.
- Public path `/buy/` in all FOUR allowlists + `page-slug.js` reserved list.
- Every supabase write destructures and judges `error`; `.single()` only on a pk.
- Run the 13-command CI mirror once before pushing; never run the full suite beside `next build` (8 GB Mac).

## Review Focus

1. Customer taps Pay now twice / after paying → second tap finds the payment and shows "all paid up"; never a second checkout (Task 6 test `refuses checkout when the mirror shows the payment`).
2. Contact edited between send and tap (email changed) → page shows the profile's CURRENT name/email and creates the account with it (Task 6 test `reads the contact fresh on POST`).
3. WhatsApp/link-preview crawler GETs the link → only `opened` stamped, no un1t.online call (Task 6 test `GET makes no un1t.online call`).
4. un1t.online answers "email in use" / ambiguous account → friendly "reply to us on WhatsApp" page plus a staff-visible `last_error`, never a crash (Task 6 test `account card reasons render the help page`).
5. Staff send while a link is live → old link revoked, its token now shows the expired page (Task 2 test `issue revokes the previous live link`).

---

### Task 1: Migrations — table and heartbeat row

**Files:**
- Create: `supabase/migrations/841_staff_payment_links.sql`
- Create: `supabase/migrations/842_staff_payment_link_sweep_heartbeat.sql` (applied right AFTER the code deploys)
- Test: existing guards (`tests/table-default-acl-guard.test.js`, `check:select-columns`)

**Interfaces:**
- Produces table `public.staff_payment_links` with columns: `id uuid pk default gen_random_uuid()`, `location_id uuid not null references locations(id)`, `organization_id uuid not null`, `contact_id uuid not null references contacts(id) on delete cascade`, `un1t_product_id text not null`, `product_title text`, `price_cents integer`, `token_hash text not null unique`, `status text not null check (status in ('sent','opened','checkout_started','paid','expired','revoked'))`, `un1t_user_id text`, `terms_accepted_at timestamptz`, `checkout_count integer not null default 0`, `last_checkout_ledger_id uuid`, `paid_transaction_id text`, `paid_at timestamptz`, `opened_at timestamptz`, `whatsapp_message_id text`, `last_error text`, `created_by uuid`, `created_at timestamptz not null default now()`, `expires_at timestamptz not null`, `updated_at timestamptz not null default now()`.
- Partial unique index `staff_payment_links_one_live ON (location_id, contact_id) WHERE status IN ('sent','opened','checkout_started')`; index `(status, expires_at)`.
- Heartbeat row name `staff-payment-link-sweep`, interval matching `*/2` with grace sized like `un1t-offer-purchase-sweep`'s row (read it from mig 828 and copy its numbers).

- [ ] **Step 1:** Write 841: `BEGIN; SET LOCAL lock_timeout='5s';` create table/indexes (IF NOT EXISTS), `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ON public.staff_payment_links FROM anon, authenticated`, `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role`, `COMMIT`. Header comment explains the table and that it is service-role only.
- [ ] **Step 2:** Write 842 copying mig 828's heartbeat insert shape with the new name.
- [ ] **Step 3:** Run `npx vitest run tests/table-default-acl-guard.test.js && npm run check:select-columns` → PASS.
- [ ] **Step 4:** Commit.

### Task 2: Core library

**Files:**
- Create: `src/lib/staff-payment-links.js`
- Test: `src/lib/staff-payment-links.test.js`

**Interfaces:**
- Produces:
  - `STAFF_PAYMENT_LINK_TTL_MS`, `LIVE_STATUSES` (frozen array), `BUY_PATH = '/buy/'`
  - `mintPaymentToken(): { token: string, hash: string }` (32 random bytes base64url; sha256 hex)
  - `hashPaymentToken(token: string): string`
  - `buildBuyUrl(baseUrl: string, token: string): string`
  - `issueStaffPaymentLink(db, { locationId, organizationId, contactId, product: { un1t_id, title, price_cents }, createdBy, now? }): Promise<{ ok: true, linkId, token, expiresAt } | { ok: false, error }>` — revokes live rows for (location, contact) first (`status → 'revoked'`, `.in('status', LIVE_STATUSES)`), then inserts; a 23505 retries the revoke once.
  - `revokeStaffPaymentLink(db, linkId, reason): Promise<void>` (sets `revoked`, `last_error = reason`)
  - `resolveStaffPaymentLink(db, token, { now? }): Promise<{ kind: 'not_found' } | { kind: 'link', link, state: 'live'|'paid'|'expired'|'revoked' }>` — shape-checks the token (`/^[A-Za-z0-9_-]{40,64}$/`) before any query; a live row past `expires_at` reads as `'expired'` (no write).
  - `markOpened(db, linkId, nowIso)` — CAS `status='sent'` → `opened`, stamps `opened_at`.
  - `isPaymentForLink(link, t): boolean` — the Global Constraints "paid" rule.
  - `productLabel(product): string` — `"<title>, <un1tPriceLabel>"`, reusing `un1tPriceLabel` from `@/lib/agent/un1t-tools`.
  - `paymentLinkCopy(settings): { template_name, whatsapp_text, button_text, page_title_new, page_title_existing, paid_text, expired_text, unavailable_text, help_text }` — defaults below, operator values override when non-empty strings.

Defaults (exact copy):
- `whatsapp_text`: `Hi {first_name}, it's {studio}. Here's the link for the {product} we talked about on the phone. Tap below to pay securely on un1t.online.`
- `button_text`: `Pay now`
- `paid_text`: `You're all paid up. See you in class!`
- `expired_text`: `This link has expired. Reply to us on WhatsApp and we'll send you a new one.`
- `unavailable_text`: `We couldn't reach the payment system just now. Please try again in a minute.`
- `help_text`: `We couldn't set up your account automatically. Reply to us on WhatsApp and we'll sort it out.`

- [ ] **Step 1: Write failing tests** with a supabase mock: `mintPaymentToken` hash equals `hashPaymentToken(token)`; `issue revokes the previous live link` (revoke update called with `.in('status', LIVE_STATUSES)` for that location+contact before insert); `resolve refuses a malformed token without a query`; `resolve reads a live row past expires_at as expired`; `isPaymentForLink` table: matching → true; other product / no product / €0 / `sub_renewal` / refunded / dated before `created_at` / other user → false; `paymentLinkCopy` falls back per key on empty string.
- [ ] **Step 2:** `npx vitest run src/lib/staff-payment-links.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit.

### Task 3: Permission key

**Files:**
- Modify: `shared/permissions.js` (WEB_PERMISSIONS entry + every role default row, mirroring `un1t_comp_credits` exactly)
- Modify: `shared/permission-bundles.js` (`un1t_payment_links: ['bundle_members']`)
- Modify: `scripts/check-mobile-parity.mjs` (`WEB_ONLY_OK` reason: `"STAFFPAYLINK.1: Hatch payment link from the web contact page's Hatch card. No phone screen in this change."`)
- Create: `src/lib/un1t-payment-link-access.js` exporting `UN1T_PAYMENT_LINKS_PERMISSION = 'un1t_payment_links'`, `canSendUn1tPaymentLink(user, locationId): boolean` (copy `un1t-comp-credits-access.js`)
- Test: `src/lib/un1t-payment-link-access.test.js`

- [ ] **Step 1:** Failing test: owner/manager/reception defaults true, staff/head_coach as `un1t_comp_credits` is; master true; no user false.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Label `Send payment links`, hint `Send a un1t.online payment link for a membership or credit pack on WhatsApp from the contact page. Owner/master/manager/reception by default.`
- [ ] **Step 4:** `npx vitest run src/lib/un1t-payment-link-access.test.js && npm run check:mobile-parity` → PASS. **Step 5:** Commit.

### Task 4: Staff route `GET|POST /api/contacts/[id]/un1t-payment-link`

**Files:**
- Create: `src/app/api/contacts/[id]/un1t-payment-link/route.js`
- Test: `src/app/api/contacts/[id]/un1t-payment-link/route.test.js`
- Modify: `src/lib/openapi.js` (register both)

**Interfaces:**
- Consumes Task 2 (`issueStaffPaymentLink`, `revokeStaffPaymentLink`, `buildBuyUrl`, `productLabel`, `paymentLinkCopy`), Task 3 (`canSendUn1tPaymentLink`), `listPurchaseOptions` (`@/lib/agent/purchase-intents`), and the cancellation-form route's WhatsApp helpers (`ownNumberOrRefusal`, `getOrCreateConversation`, `loadSendConversation`, `contactWaPhone`, `isWindowOpen`, `sendCtaUrlMessage`, `sendTemplateMessage`, `buildTemplateComponents`, `renderTemplateBody`, `pickTemplateConfig`, `templateUrlPrefixOk`, `URL_BUTTON_MAPPING_KEY`, `manualTakeoverPatch`, `whatsappErrorStatus`).
- GET `?locationId=` → `{ success, data: { offers: [{ offer_id, title, price_label, recurring }], latest: { status, product_title, created_at, paid_at, expires_at } | null, can: { send, has_email, has_phone, window_open, template_ready }, live_membership: { plan } | null, preview_text } }`.
- POST body `{ locationId: uuidLike, offerId: uuidLike }` → `{ success, data: { linkId, expiresAt, via: 'cta' | 'template' } }`.

Gate order: `getCurrentUser` (401) → validate → contact read by id (404) → `assertLocationAccessOr404(user, locationId)` → `canSendUn1tPaymentLink` AND web/mobile `whatsapp` at `locationId` (403) → studio has `membership_source='un1t_online'` (409 `not_a_un1t_studio`) → `readUn1tWriteSettings` writes enabled (409) → contact has email (400 `Add an email to this contact first — un1t.online needs it for the account.`) and phone (400) → not opted out / undeliverable (409) → offer in `listPurchaseOptions` (400 `offer_not_available`) → window or usable template (409 `needs_template`, copy as cancellation-form's) → issue → send → on send throw `revokeStaffPaymentLink` and return `whatsappErrorStatus(e, 502)` → log `whatsapp_messages` + conversation update with `manualTakeoverPatch` + `activities` row type `un1t_payment_link_sent` (best-effort) → stamp `whatsapp_message_id`.
Template mapping: `{ '1': 'first_name', '2': productLabel(product), [URL_BUTTON_MAPPING_KEY]: token }`. cta body = `whatsapp_text` rendered with `{first_name}`, `{studio}`, `{product}`.
`live_membership`: from `contact_studios` (`membership_status='active'`, `membership_plan`) at `locationId`; shown only, never blocks.

- [ ] **Step 1: Failing tests:** 401; 404 for a contact at another studio; 403 without the permission; 409 at a Glofox studio; 400 no email; 409 `needs_template` when window closed and template is MARKETING; cta send inside the window (asserts `sendCtaUrlMessage` url = `<base>/buy/<token>`); template send outside (asserts mapping above); send failure revokes the link; GET returns `live_membership` when active.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run + `npm run check:route-guards && npm run check:location-scoping` → PASS. **Step 5:** Commit.

### Task 5: Staff UI on the Hatch card

**Files:**
- Create: `src/components/Un1tPaymentLink.jsx`
- Test: `src/components/Un1tPaymentLink.test.jsx`
- Modify: `src/components/Un1tClassBookingCard.jsx` (render `<Un1tPaymentLink contactId locationId studioName />` under the comp-credits block)

**Interfaces:** consumes Task 4 GET/POST.

Behaviour: hidden when GET says `can.send` false and there is no `latest`. Dropdown of offers (`title — price_label`), the preview text, **Send on WhatsApp** (`type="button"`, disabled while sending or when no offer chosen). If the chosen offer is `recurring` and `live_membership` is set, show the amber warning `<first name> already has <plan>, live. Sending a new membership could mean two payments.` (chip recipe `bg-amber-500/10 text-amber-700`). Disabled reason lines for no email / no phone / `needs_template`. Latest status line: `Link sent <time> · <status>`.

- [ ] **Step 1: Failing tests:** renders offers; send posts `{ locationId, offerId }`; warning appears only for recurring + live membership; no-email reason shows and button disabled; status line after a successful send.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `@/components/ui` primitives. **Step 4:** Run + `npm run check:guardrails` → PASS. **Step 5:** Commit.

### Task 6: Public page `/buy/[token]` and `POST /api/public/buy/[token]`

**Files:**
- Create: `src/app/buy/[token]/page.js`, `src/app/buy/[token]/BuyForm.jsx` ('use client'), `src/app/buy/layout.js` (copy `src/app/pay-link/layout.js`)
- Create: `src/app/api/public/buy/[token]/route.js`
- Create: `src/lib/staff-payment-link-checkout.js` (`startStaffLinkCheckout`)
- Test: `src/lib/staff-payment-link-checkout.test.js`, `src/app/buy/[token]/page.test.jsx`
- Modify: `src/proxy.js` `publicPaths` (`'/buy/'`), `src/components/AppShell.jsx` `PUBLIC_PATHS` (`'/buy'`), `src/lib/brands.js` un1t-marketing `allowedPaths` (`'/buy/'`), `src/lib/tenant-domains-edge.js` `DB_BRAND_DEFAULTS.allowedPaths` (`'/buy/'`), `src/lib/page-slug.js` reserved (`'buy'`), `src/public-compliance-paths.test.jsx` (a STAFFPAYLINK.1 describe copying the UN1TDUN.1 one)

**Interfaces:**
- `loadBuyPage(db, token): Promise<{ kind: 'not_found' } | { kind: 'paid'|'expired'|'unavailable', branding } | { kind: 'ready', branding, product: { title, price_label }, person: { first_name, email }, isNew: boolean }>` in `staff-payment-link-checkout.js`. Reads: link (Task 2 resolve), contact fresh by id (named columns), product from `un1t_products` (current, `isSellableUn1tProduct`), paid check over the mirror (`isPaymentForLink`), `isNew = !link.un1t_user_id && !contact.un1t_user_id` (no API call; a person whose account exists but is unlinked sees the ticks, and the POST then finds and links the account without creating one). Stamps `opened` (Task 2 `markOpened`). Makes no un1t.online call.
- `startStaffLinkCheckout(db, { token, acceptTerms: boolean, now? }, deps?): Promise<{ kind: 'redirect', url } | { kind: 'paid'|'expired'|'unavailable'|'help', reason? } | { kind: 'terms_required' }>`:
  1. re-resolve; non-live → that state; product re-read (not sellable → expired);
  2. mirror paid check → `paid` (stamp the row paid);
  3. `ensureUn1tAccount(db, { locationId, organizationId, contact, request: acceptTerms ? { terms_accepted_at: nowIso, terms_source: 'buy_page' } : null, origin: 'staff_payment_link', originRef: link.id })` — `card` with `terms_not_accepted` → `terms_required`; other `card` → `help` (write `last_error = reason`); `retry` → `unavailable`;
  4. stamp `un1t_user_id` (+ `terms_accepted_at` when created) before the checkout;
  5. `createCheckoutLink(db, { locationId, userId, productId, successUrl: <base>/buy/<token>?paid=1, cancelUrl: <base>/buy/<token>?cancelled=1, idempotencyKey: 'paylink:<id>:r<checkout_count>', origin: 'staff_payment_link', originRef: link.id })` → stamp `status='checkout_started'`, `checkout_count+1`, `last_checkout_ledger_id` → `redirect`. `free: true` → `paid`. `Un1tWriteRefused` retryable / `Un1tSettingsReadError` / `Un1tWriteUnknown` → `unavailable`; other refusal → `help`.
- Route POST `{ acceptTerms?: boolean }` → `{ success, data: { kind, url? } }`; `checkRateLimit(db, 'paylink:'+getClientIp(request), { max: 10, windowMs: 60_000 })`.
- Page: `?paid=1` → "You're in, <first_name>" + app store links + "Check your inbox for a code to set your password" when the account was CRM-created (`terms_accepted_at` set); otherwise states per `loadBuyPage`. New: two checkboxes (terms link and waiver link — take the URLs the /trial Hatch form uses), button **Continue to payment**. Existing: no checkboxes, same button.

- [ ] **Step 1: Failing tests (lib):** `GET makes no un1t.online call`; `refuses checkout when the mirror shows the payment`; `reads the contact fresh on POST`; `new customer without ticks → terms_required, no create`; `account card reasons render the help page` (stamps `last_error`); idempotency key increments per checkout; `free: true` → paid; expired product → expired.
- [ ] **Step 2: Failing tests (page + allowlists):** the compliance-path describe for `/buy/<token>` on every host; page renders ticks only when `isNew`.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run + `npm run check:route-guards` (add the route to `EXEMPT` as a token route with reason) → PASS. **Step 6:** Commit.

### Task 7: Paid sweep arm

**Files:**
- Create: `src/lib/staff-payment-link-sweep.js` (`sweepStaffPaymentLinks(db, locationId, { now? }): Promise<{ ok: boolean, checked, paid, expired, failed, passwordPending }>`)
- Test: `src/lib/staff-payment-link-sweep.test.js`
- Modify: `src/app/api/cron/process-trial-purchases/route.js` (new `runStaffPaymentLinkSweep(db)` arm after `runOfferPurchaseSweep`, heartbeat `staff-payment-link-sweep`, stamped only when every studio returned ok; same never-throws shape)

Per studio: live rows plus `expired` rows less than 3 days past expiry, with `un1t_user_id` (range-paginated, ordered by id, page < 1000); mirror transactions for those users since the earliest `created_at`; `isPaymentForLink` match, each transaction used once → CAS update `paid` (`.eq('status', <as read>)`, `.select('id')`, judge rows), `paid_transaction_id`, `paid_at`; then, when `terms_accepted_at` is set (CRM created the account), `runSetPasswordStep` as `un1t-offer-purchases.js` does (subject `Your UN1T Hatch Street account`, body `Thanks for your purchase at UN1T Hatch Street. We've set up your un1t.online account. Check your inbox for a code to set your password, then book your first class in the app.`), a failure counted in `passwordPending` and written to `last_error`. Live rows past `expires_at` and unpaid → `expired` (CAS).

- [ ] **Step 1: Failing tests:** marks paid on a matching transaction; ignores renewal/other product; one transaction never pays two links; late payment settles an expired row; expiry CAS; a read error → `ok:false`, no stamp; set-password only for CRM-created accounts.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run + `npx vitest run src/app/api/cron/process-trial-purchases` → PASS. **Step 5:** Commit.

### Task 8: Settings field + docs

**Files:**
- Modify: `src/components/settings/integrations/Un1tOnlineIntegrationTab.jsx` and `src/app/api/locations/[id]/un1t-online/route.js` (a "Payment links" section: template name + the copy keys of `paymentLinkCopy`, validated strings ≤ 1000 chars, stored at `settings.un1t_online.payment_link`)
- Test: the route's existing test file (add a case) 
- Create: `docs/changelog/entries/<PR>.md` (after `gh pr create`)
- Modify: `docs/architecture/REFERENCE.md` (a short § STAFFPAYLINK.1 pointing at the files)

- [ ] **Step 1:** Failing route test: saves and returns `payment_link` copy; rejects a non-string. **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Full CI mirror (the 13 commands in CLAUDE.md) and `npm run build`, one at a time → all green.
- [ ] **Step 6:** Commit, push, `gh pr create`, changelog entry, push again.

## Go-live (Richard, not code)

1. Apply mig 841 before the deploy; mig 842 right after.
2. Submit the UTILITY template (text in the spec) on the Hatch WABA, button URL `https://<hatch customer host>/buy/{{1}}`; once approved, put its name in Settings → Integrations → un1t.online → Payment links.
3. Try it on your own contact at Hatch.
