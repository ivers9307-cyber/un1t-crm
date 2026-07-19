# un1t-crm — external integrations

> Integration reference (env vars, Xero, Twilio, Revolut, Pay subdomain, Cars deposit) extracted from the root `CLAUDE.md` (2026-06-25). Read when wiring or debugging a specific provider. Linked from the CLAUDE.md "Deep reference" index.

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
POSTMARK_API_KEY=
POSTMARK_FROM_EMAIL=hello@un1t.ie
POSTMARK_WEBHOOK_TOKEN=          # shared secret sent in X-Webhook-Token by Postmark (required — route 500s if unset)
POSTMARK_WEBHOOK_TOKEN_PREVIOUS= # optional — old token kept live during rotation; unset after every Postmark webhook config has been flipped to the new value
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=    # optional
WHATSAPP_WEBHOOK_VERIFY_TOKEN=   # for Meta GET subscription handshake
WHATSAPP_APP_SECRET=             # for X-Hub-Signature-256 verification on POST
WHATSAPP_ES_CONFIG_ID=           # Facebook Login for Business configuration id driving Embedded Signup v4 ("Connect with WhatsApp" in Settings → Locations → Integrations). Unset = the connect button renders a not-configured state; the exchange route 500s.
QSTASH_TOKEN=                    # Upstash QStash publish token. UNSET = QStash disabled entirely (deliberate kill switch): webhook routes skip the push publish and the drain crons remain the only queue consumers. See "QStash push delivery".
QSTASH_CURRENT_SIGNING_KEY=      # Upstash-Signature verification (worker routes 503 without it)
QSTASH_NEXT_SIGNING_KEY=         # second accepted key so Upstash-side key rotation never drops deliveries
ANTHROPIC_API_KEY=               # for the in-app assistant chat
CRM_API_KEY=                     # Bearer token for n8n / external integrations
NEXT_PUBLIC_APP_URL=https://crm.un1tdublin.com
CRON_SECRET=                     # for Vercel cron auth
XERO_CLIENT_ID=                  # Xero OAuth 2.0 web app — see "Xero integration"
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=https://crm.un1tdublin.com/api/xero/callback
XERO_SALES_ACCOUNT_CODE=         # optional, defaults to 200 (Sales). Set if your chart uses a different code.
GOOGLE_OAUTH_CLIENT_ID=          # Google Cloud OAuth 2.0 web client — Business Profile reviews
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://crm.un1tdublin.com/api/google-business/callback

# Revolut Merchant — see "Revolut Merchant integration"
REVOLUT_API_KEY=                 # Secret API key (sk_live_... or sk_sandbox_...)
REVOLUT_API_BASE_URL=            # https://merchant.revolut.com (prod) or https://sandbox-merchant.revolut.com
REVOLUT_WEBHOOK_SECRET=          # signing_secret for the CARS deposit webhook (/api/webhooks/revolut)
REVOLUT_RACE_WEBHOOK_SECRET=     # signing_secret for the RACE-PAYMENTS webhook (/api/webhooks/revolut/race-payments). Mig 084. If unset, race route falls back to REVOLUT_WEBHOOK_SECRET (single-merchant transitional case).
REVOLUT_API_VERSION=2026-03-12   # optional; default in src/lib/revolut.js
NEXT_PUBLIC_REVOLUT_MODE=        # 'prod' | 'sandbox' — must match REVOLUT_API_BASE_URL
NEXT_PUBLIC_REVOLUT_PUBLIC_KEY=  # Public API key (pk_live_... or pk_sandbox_...) for the embedded checkout widget

# Twilio SMS — see "Twilio integration"
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=CCFautos             # alphanumeric ID (Ireland) OR E.164 number OR Messaging Service SID

# Buyer-facing payment domain — see "Pay subdomain"
DEPOSIT_BASE_URL=https://pay.ccfautos.com           # used server-side when generating deposit links
NEXT_PUBLIC_DEPOSIT_BASE_URL=https://pay.ccfautos.com  # client-side mirror for operator preview links
PAY_HOSTNAME=pay.ccfautos.com    # middleware uses this to gate which paths are public on the pay host

# Apple Health (Apple Watch ingestion) — DIRECT on-device HealthKit, no relay.
# The champ-app native app reads HealthKit on-device and POSTs to
# /api/wearables/apple-health/ingest (customer-authed). No env vars needed here.
# (The old OpenWearables relay + its OPENWEARABLES_* env were removed once the
# direct path was device-verified — 2026-06-24.)

# InBody / Lookin'Body WebAPI (CONSULTATIONS SP2) — see src/lib/inbody-webhook.js
INBODY_WEBHOOK_SECRET=           # shared secret we set as a custom header (x-inbody-secret) in the InBody portal Step 3; /api/webhooks/inbody 500s if unset, 403s on mismatch
```


## Xero integration

Per-location OAuth 2.0 connection stored in the `xero_connections` table (migration 029). The same Xero login can grant access to multiple tenants (e.g. UN1T Dublin gym + CCF Autos under one user account); each CRM location is bound to one tenant_id explicitly so we know which org to push into.

`src/lib/xero/client.js` is a hand-rolled fetch wrapper around Xero's REST + OAuth endpoints (the official `xero-node` SDK is deliberately avoided — the surface we use is small and the SDK has churn issues against Next.js). All API calls go through `withFreshToken(locationId)` which transparently refreshes the access_token if it expires within 60 seconds and persists the rotated refresh_token (Xero rotates it on every refresh — failure to persist breaks all future refreshes).

`src/lib/xero/invoices.js` implements `issueCarInvoice(car)` — the customer invoice push for completed cars. Wired to `POST /api/cars/[id]/issue-xero-invoice` and the "Issue invoice" button on `CarDetail`.

OAuth routes:
- `GET /api/xero/connect?location_id=…` — kick off OAuth (sets CSRF cookie, redirects)
- `GET /api/xero/callback` — exchange code, persist tokens, redirect to /settings/integrations
- `POST /api/xero/disconnect` — remove the connection row
- `GET /api/xero/status?location_id=…` — safe subset of the connection row (no tokens) for client UIs
- `GET /api/xero/debug` — dev-only diagnostic; dumps masked env vars + the exact authorize URL

Settings UI lives at `/settings/integrations` (`XeroLocationCard.jsx`).

### Xero OAuth scopes — granular reference

**Critical context:** Xero deprecated the broad `accounting.transactions` and `accounting.reports.read` scopes on **2 March 2026**. Apps registered on/after that date — **including ours** (registered 30 April 2026) — *cannot* request the broad scopes at all and Xero rejects the auth with a misleading `unauthorized_client / Invalid scope for client` error that doesn't actually name the bad scope. Apps registered before the cutoff have until September 2027 to migrate.

**Always use granular scopes when extending the integration.** Quick lookup table for the new scopes our app can request:

| Granular scope (use this) | Endpoints / use case | Replaces (deprecated) |
|---|---|---|
| `accounting.contacts` | Contacts (read+write). **Unchanged** — works for old + new apps. | (n/a) |
| `accounting.invoices` | Invoices, credit notes, items, purchase orders, quotes, repeating invoices, linked transactions | `accounting.transactions` |
| `accounting.payments` | Payments, batch payments, overpayments, prepayments | `accounting.transactions` |
| `accounting.banktransactions` | Bank transactions, bank transfers (reconciled ledger items, NOT bank feeds) | `accounting.transactions` |
| `accounting.manualjournals` | Manual journal entries | `accounting.transactions` |
| `accounting.classicexpenses` | Expense claims, receipts (deprecated endpoint) | `accounting.transactions` |
| `accounting.settings` | Tax rates, tracking categories, branding themes, organisation settings, items | (n/a — unchanged) |
| `accounting.attachments` | File attachments on invoices/contacts/etc | (n/a — unchanged) |
| `accounting.budgets` | Budgets | (n/a — unchanged) |
| `accounting.reports.aged.read` | Aged Payables/Receivables by Contact | `accounting.reports.read` |
| `accounting.reports.balancesheet.read` | Balance Sheet | `accounting.reports.read` |
| `accounting.reports.banksummary.read` | Bank Summary | `accounting.reports.read` |
| `accounting.reports.executivesummary.read` | Executive Summary | `accounting.reports.read` |
| `accounting.reports.profitandloss.read` | Profit & Loss | `accounting.reports.read` |
| `accounting.reports.taxreports.read` | GST / BAS reports | `accounting.reports.read` |
| `accounting.reports.trialbalance.read` | Trial Balance | `accounting.reports.read` |
| `accounting.journals.read` | Journals | (n/a — unchanged, read-only) |
| `offline_access` | Issue refresh_token (REQUIRED for any long-lived integration) | (n/a — unchanged) |

Each scope also has a `.read` variant for read-only access (e.g. `accounting.invoices.read`). Items live under both `accounting.invoices` AND `accounting.settings` — if you only touch items, use settings.

Non-Accounting APIs are unaffected by the granular split: `payroll.*`, `files`, `assets`, `projects`, `bankfeeds`, `practicemanager`, `finance`. Add them as-is when you need them.

**Do not include the OIDC scopes** (`openid`, `profile`, `email`) unless we actually start consuming the id_token for Xero-side identity. Including them on apps that haven't explicitly opted into OIDC also throws the same "Invalid scope" error. The user is already authenticated via Supabase — the access_token is all we need.

When adding a new Xero feature, append the relevant granular scope to `XERO_SCOPES` in `src/lib/xero/client.js`. Existing connected locations need to click "Reconnect" to receive the additional scope on their token (scopes are additive). The integration card on `/settings/integrations` shows the current scope grant in `connection.scopes`.

### Xero invoice push (v2) + bills auto-forward

`src/lib/xero/invoices.js` — `issueCarInvoice(car)` validates required fields, resolves the "Car" branding theme by name (overridable via `XERO_BRANDING_THEME_NAME`), upserts the buyer Contact (find-by-email → name → create; backfills missing email if matched), POSTs the AUTHORISED invoice, calls `/Invoices/{id}/Email` to email it, downloads the PDF via `Accept: application/pdf` and uploads to Supabase Storage at `cars/{id}/xero-invoice-{number}.pdf`. `voidCarInvoice(car)` POSTs the invoice with `Status: VOIDED`. `validateInvoiceFields(car)` is exported and mirrored client-side in `XeroCard` so the button can be disabled before the round-trip.

Routes:
- `POST /api/cars/[id]/issue-xero-invoice` — full issue flow
- `POST /api/cars/[id]/void-xero-invoice?reissue=true` — void + optional reissue (typical use: sale price drifted)
- `GET  /api/cars/[id]/xero-invoice-pdf` — 5-min signed URL for the saved PDF

The "Void & reissue" button only appears in `XeroCard` when `irish_sale_price_ex_vat` differs from `xero_invoice_amount` (the snapshot taken at issue time). Native `confirm()` for the warning to keep the implementation tight.

`src/lib/xero/bills-email.js` — `sendCarDocumentBillEmail(documentId)` reads the per-location `xero_connections.bills_email_address` (set in Settings → Integrations from Xero's UI under **Business → Bills to pay → Create bill from email**), pulls the PDF bytes from Supabase Storage, base64-encodes, and sends via Postmark with the PDF as an attachment. Xero auto-OCR's the inbound email and creates a draft Bill in **Business → Bills to pay → Draft** with supplier/amount/line items extracted. Subject is `<doc-label> — <car-reg>` so the resulting draft is easy to match back to the right car. No Xero scope needed for this path — it's all Postmark + Xero's email-in pipeline.

Route: `POST /api/cars/[id]/documents/[docId]/send-to-xero`. Persists `xero_sent_at` (timestamp) + `xero_file_id` (Postmark message id) + `xero_sent_by` on the `car_documents` row, and `xero_send_error` on failure. `completionGaps()` requires every required-doc-type to have at least one upload with a populated `xero_sent_at` (label suffix: " — send to Xero" when uploaded but not yet forwarded), so a car can't be promoted to completed until the AP side is captured.

`POST /api/xero/bills-email` updates `bills_email_address` on the connection row from the integrations UI. Validated as an email; null clears it.

The earlier Files API path (`src/lib/xero/files.js`) is retained as a deprecation marker only — nothing imports it. Email-to-Bills is the supported path because it doesn't require the per-org "Convert files to bills" Files Inbox toggle.

### Webhook authentication

`src/lib/webhook-auth.js` provides `verifyMetaSignature()` (HMAC-SHA256 over the raw body, used by `/api/webhooks/whatsapp`) and `verifySharedSecret()` (constant-time token compare, used by `/api/webhooks/postmark`). Both routes set `export const runtime = 'nodejs'` so `node:crypto` is available.

**Postmark.** Auth is enforced — `POSTMARK_WEBHOOK_TOKEN` is required, and a missing env var returns 500 (not 200-with-warning). The 5xx is deliberate: Postmark retries 5xx responses for ~24h, so a config drift gets recovered as soon as the env var is set, instead of silently dropping events. A bad/missing `X-Webhook-Token` returns 403 (Postmark won't retry 4xx — correct behaviour for a deliberately-rogue caller). The auth predicate is exported from the route as `verifyPostmarkRequest({ headerValue, primarySecret, previousSecret })` and unit-tested in `src/lib/postmark-webhook-auth.test.js`. **Token rotation:** set `POSTMARK_WEBHOOK_TOKEN_PREVIOUS` to the old token while you flip every webhook custom-header config in Postmark over to the new one — both are accepted in the meantime, with a `[security]` warning when the previous one matches so you remember to finish the rotation. Unset PREVIOUS after.

**Meta WhatsApp.** Strict HMAC verification via `verifyMetaSignature()` against `WHATSAPP_APP_SECRET`. Missing env var or bad signature → 403.

When adding a new webhook handler, read the body with `await request.text()` first (verify HMAC), then `JSON.parse()` — calling `request.json()` consumes the body and the re-serialised JSON won't byte-match the signed payload. Mirror the Postmark pattern of exporting the pure auth predicate from the route module so the test can exercise it without mocking Supabase (see `verifyTwilioSignature` in the Twilio status webhook for another example).

### QStash push delivery

QSTASH.1 (pilot) added push-based delivery for `postmark_webhook_queue` alongside its drain cron; QSTASH.3 extended the pattern to webhook dead-letter replays. Common shape: the enqueue site inserts its queue/dead-letter row (unchanged), then fire-and-forget publishes `{ id }` to QStash via `publishQueuePush` (`src/lib/qstash.js` — env-gated on `QSTASH_TOKEN`, never throws), which POSTs the worker route — signature-verified (`Upstash-Signature` HS256 JWT, both signing keys accepted for rotation) and processed through the **same claim CAS** as the sweeper cron, so the two consumers race safely. Workers return 200 for processed/skipped, 500 to make QStash retry; rows QStash gives up on stay pending and the cron sweeps them.

Migrated jobs:

| Job | Enqueue site (publish) | Worker route | Shared claim lib | Sweeper cron |
|---|---|---|---|---|
| Postmark webhook queue | `/api/webhooks/postmark` (dedup `postmark-queue-<id>`) | `/api/webhooks/qstash/postmark` | `src/lib/postmark-queue.js` (CAS on `processed_at` NULL→now) | `/api/cron/process-postmark-webhooks` (`*/2`) |
| Webhook dead-letter replay | `deadLetterWebhook()` in `src/lib/webhook-dead-letter.js`, replayable providers only (dedup `webhook-replay-<id>`, 60s `Upstash-Delay` so the first replay respects the minimum backoff) | `/api/webhooks/qstash/webhook-replay` | `src/lib/webhook-replay-queue.js` (CAS on `last_attempt_at` unchanged-since-read; no status flip — the table has no 'replaying' status) | `/api/cron/webhook-replay` (`*/5`, keeps the exponential backoff for swept rows; QStash's own retry schedule covers pushed rows) |

**Setup (operator):** create an Upstash account → QStash → copy the token + current/next signing keys into Vercel env. **Rollback / kill switch:** unset `QSTASH_TOKEN` — publishing stops, the crons carry everything again; no code change, no data loss (the tables are the source of truth throughout). **Dedup keys are DASH-ONLY** — QStash 400s on colons in `Upstash-Deduplication-Id` (undocumented; the first live publish proved it).

### Rate limiting

`src/lib/rate-limit.js` provides `checkRateLimit(db, key, { max, windowMs })` backed by the `rate_limit_buckets` table (migration 015). Currently wired to:

- `POST /api/public/book` — 5/15 min per IP
- `POST /api/unsubscribe/[token]` — 10/15 min per IP
- `GET/PUT /api/preferences/[token]` — 20/15 min per IP

The limiter is fail-open (DB error → request allowed, warning logged) so a Supabase blip can't take down the booking flow. Routes call `getClientIp(request)` to derive the bucket key from `x-forwarded-for`. Cron `/api/cron/prune-rate-limits` deletes expired buckets nightly at 03:30 UTC.

Add a new public endpoint? Wire the limiter at the top of the handler with a unique bucket prefix (`book:`, `unsubscribe:`, etc.) and `export const runtime = 'nodejs'` so `node:crypto` is available transitively.

### Google reviews carousel

Per-location Google Business Profile connection (`google_business_connections`, mirrors `xero_connections`) powers a `reviews` landing-page block — a pure-CSS marquee of synced Google reviews on `/welcome/[location]`. OAuth scope `business.manage`; reviews come from the **legacy `mybusiness.googleapis.com/v4` endpoint** (the newer split APIs host accounts + locations only). A daily `/api/cron/sync-google-reviews` cron upserts into `google_reviews` (mig 249) preserving the per-review `hidden` operator toggle, and snapshots the average rating + total count onto the connection. Operators connect + pick the listing + sync + hide reviews at Settings → Locations → [name] → Integrations → Google Reviews; they configure the carousel (heading, min rating, marquee speed, aggregate header) in the landing-page editor. **Prerequisite:** Google Business Profile API access approval (new GCP projects start at 0 QPM; approval takes days–weeks) plus the three `GOOGLE_OAUTH_*` env vars. Design: `docs/REVIEW_CAROUSEL_DESIGN.md`. No new permission key — block editing uses `landing_page`, connecting uses the owner/master role gate.


## Twilio integration

`src/lib/twilio.js` is the single SMS helper. Used by the deposit-link issue flow; designed to be reused for any future transactional SMS.

**Sender for Ireland.** Twilio's Irish (`+353`) long codes are **voice-only** — the Irish mobile carriers (Vodafone, Three, Eir) don't accept A2P SMS over them. Three viable senders:

| Sender | Cost | Reply support | When to use |
|---|---|---|---|
| Alphanumeric ID `CCFautos` (default) | Free | One-way only | Most utility messages — branded, instantly recognisable |
| UK long code (`+44…`) | ~€1/mo + per-SMS | Two-way | Only if you specifically need replies |
| Irish short code (e.g. `50500`) | €800+/mo + per-SMS | Two-way | Only at very high volume (banks / Glofox use these) |

Set via `TWILIO_FROM` env. Twilio infers the sender type from the value's shape — alphanumeric ID, E.164 number, or `MGxxx...` Messaging Service SID all go in the same field.

**Trial-account gotcha.** Twilio trial accounts can ONLY send to phone numbers verified in the console (Phone Numbers → Manage → Verified Caller IDs). Adding billing flips the account to paid status and lifts the restriction. Alphanumeric senders are blocked entirely on trial accounts — you must upgrade before testing the alpha sender even works.

**Vodafone IE alpha sender filtering.** Some carriers (Vodafone IE specifically) silently drop unregistered alphanumeric senders. Register `CCFautos` in Twilio Console → Messaging → Senders → Alphanumeric Sender IDs (1-2 business day approval) to avoid this. Three IE and Eir generally accept unregistered alpha senders.

**Diagnostics.** Every SMS the issue endpoint sends inserts a system note on the car (`car_notes` table) with the Twilio SID. Operators paste the SID into Twilio Console → Monitor → Logs → Messaging when a customer says "I never got the SMS" — the log shows delivered / failed / queued + the carrier-specific error code.

**E.164 normalisation.** `toE164Ireland(raw)` is a best-effort helper that handles the common Irish formats operators type (`087 1234567`, `0871234567`, `+353…`, bare `87…`). Falls back to passing the input through unchanged so Twilio gets a chance to reject explicitly with a helpful error code.


## Revolut Merchant integration

Used for car deposit payments. **All field names + enum values are verified against `merchant-2026-03-12.yaml`** in the [revolut-openapi](https://github.com/revolut-engineering/revolut-openapi) repo, NOT against my pre-existing knowledge — there are gotchas if you don't read the spec for the version you've pinned.

**API key shape.** Two keys per environment, both generated in Revolut Business → APIs → Merchant API:

- **Secret key** (`sk_live_...` / `sk_sandbox_...`) — `REVOLUT_API_KEY`. Server-side only. `Authorization: Bearer <secret>` on every API call.
- **Public key** (`pk_live_...` / `pk_sandbox_...`) — `NEXT_PUBLIC_REVOLUT_PUBLIC_KEY`. Exposed to the browser bundle (intentional — Revolut's docs explicitly say "the Public key is provided with payment methods at checkout"). Used to initialise the embedded checkout widget on the client.

**API version pinning.** Every request sends `Revolut-Api-Version: 2026-03-12` (configurable via `REVOLUT_API_VERSION`, default in `lib/revolut.js`). When updating to a newer version, **read the changelog AND the OpenAPI spec for that version's enum values** — Revolut has shifted enum casing between versions (e.g. `capture_mode` was upper-snake in older versions, lowercase in newer; the SDK token field renamed from `public_id` to `token`).

**Spec-verified facts.** All values lowercase in the current pinned version:

- `Order.state` enum: `pending`, `processing`, `authorised`, `completed`, `cancelled`, `failed`. **There is NO `refunded` order state** — refunds create a NEW order with `type='refund'` linked via `related_order_id`; the original order's state stays `completed`.
- `capture_mode` enum: `automatic` (default if omitted), `manual`. **Omit the field entirely unless you specifically want manual capture** — sidesteps any future enum-casing changes.
- Order response field for the SDK token: **`token`** (was `public_id` in the deprecated endpoint — don't fall back to `public_id` for new code).
- Webhook signature header: `Revolut-Signature` (multiple `v1=<hex>` candidates separated by commas — any match wins; supports rotation).
- Webhook timestamp header: `Revolut-Request-Timestamp` (Unix milliseconds; reject anything older than 5 min).
- Webhook events for orders: `ORDER_COMPLETED`, `ORDER_AUTHORISED`, `ORDER_CANCELLED`, `ORDER_FAILED`, `ORDER_PAYMENT_DECLINED`, `ORDER_PAYMENT_FAILED` (+ several others for subscriptions / payouts / disputes we don't use).
- Webhook payload discriminator field: `event` (string).
- Webhook payload order id field: `order_id` (snake_case).

**Sandbox vs prod.** Completely separate accounts with separate dashboards, separate API keys, separate webhook secrets. Toggle three env vars together: `REVOLUT_API_KEY` (`sk_sandbox_*` ↔ `sk_live_*`), `REVOLUT_API_BASE_URL` (`https://sandbox-merchant.revolut.com` ↔ `https://merchant.revolut.com`), `NEXT_PUBLIC_REVOLUT_MODE` (`sandbox` ↔ `prod`). **All three must match.** A mismatch causes the SDK to silently fail (iframe loads but renders blank) because the SDK can't validate a prod token against sandbox infrastructure or vice versa. Use Vercel's per-environment env scoping to keep Preview pointing at sandbox while Production takes real money.

**Webhook setup (production).** The webhook UI doesn't surface in every Revolut Business dashboard layout. Cleanest path is the API:

```bash
curl -X POST https://merchant.revolut.com/api/webhooks \
  -H "Authorization: Bearer YOUR_LIVE_REVOLUT_API_KEY" \
  -H "Revolut-Api-Version: 2026-03-12" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://crm.un1tdublin.com/api/webhooks/revolut",
    "events": ["ORDER_COMPLETED", "ORDER_AUTHORISED", "ORDER_PAYMENT_DECLINED", "ORDER_PAYMENT_FAILED"]
  }'
```

Returns `{ id, url, events, signing_secret }`. The `signing_secret` (starts `wsk_`) goes into Vercel as `REVOLUT_WEBHOOK_SECRET`. **Spec note:** unlike the legacy API, `signing_secret` is included in ALL webhook responses (not just creation), so a `GET /api/webhooks/{id}` will retrieve it later. Rotate via `POST /api/webhooks/{id}/rotate-signing-secret`.

**Webhook IPs to allowlist** (per spec, line 13871): production `35.246.21.235`, `34.89.70.170`. Sandbox `35.242.130.242`, `35.242.162.241`.

**Embedded checkout (current widget).** `RevolutCheckout.embeddedCheckout({ publicToken, target, createOrder, onSuccess, onError, onCancel })` mounts a widget inline on our page that handles cards + Apple Pay + Google Pay + Revolut Pay automatically. The order is created on SUBMIT (via the SDK's `createOrder` callback hitting our `/accept-and-pay` endpoint), NOT on page load — drops abandoned-order count in the merchant dashboard. SDK source: `node_modules/@revolut/checkout/esm/embeddedCheckoutLoader.js` confirms `RevolutCheckout.embeddedCheckout` is exposed as a static method on the loaded global. **Don't use the older `createCardField` path** — it's the legacy single-payment-method API.

**Webhook handler is idempotent.** `runs `getOrder(orderId)` to fetch fresh state rather than trusting payload state (Revolut docs explicitly warn payload state can be stale during retries). `paid_at` only stamps if not already set, so duplicate webhook deliveries don't reset the timestamp. Always returns 200 even on unrecognised events so Revolut doesn't auto-disable the hook.


## Pay subdomain (`pay.ccfautos.com`)

Buyer-facing deposit pages live on a separate hostname from the CRM. Same Vercel project — multi-domain via hostname-aware middleware. The CRM stays at `crm.un1tdublin.com`; everything except the deposit pages + their backing public API is 404'd on the pay hostname so buyers never see CRM URLs.

**Implementation.** `src/proxy.js` checks `request.headers.get('host')` first thing:

- If hostname matches `PAY_HOSTNAME` (env, defaults to `pay.ccfautos.com`):
  - Allow `/deposit/*` and `/api/public/deposit/*` through unauthenticated
  - Allow `/_next/*`, `/favicon.ico`, `/robots.txt` (framework assets)
  - 404 everything else (don't redirect — that would leak the CRM URL)
- Otherwise (CRM hostname) — existing auth logic runs.

**Critical layout gotcha:** the deposit page lives at `src/app/deposit/[token]/page.js`, NOT under `/cars/deposit/`. Reason: `src/app/cars/layout.js` runs `getCurrentUser()` + `redirect('/login')` for unauthenticated visitors, and that fires BEFORE the page renders even if middleware allows the route. Anything under `/cars/*` inherits that auth gate. Public buyer pages must live OUTSIDE the `/cars` route segment.

**URL generation.** `src/lib/app-url.js → getDepositBaseUrl()` is the canonical helper for buyer-facing deposit links. Reads `DEPOSIT_BASE_URL`, falls back to `NEXT_PUBLIC_APP_URL`. Three places use it: `/api/cars/[id]/issue-deposit-link` (the link in the SMS), `/api/public/deposit/[token]/accept-and-pay` (Revolut's `redirect_url` so the hosted-page fallback bounces back to the same domain the buyer started on), and `DepositCard.jsx` ('View public deposit page' operator preview link via `NEXT_PUBLIC_DEPOSIT_BASE_URL`).

**DNS setup.** CNAME `pay.ccfautos.com → cname.vercel-dns.com`. Add the domain in Vercel → Settings → Domains. SSL auto-provisioned within ~1 minute of DNS resolving.


## Cars deposit feature

End-to-end flow: operator clicks one button on a car → buyer gets an SMS with a tokenised link → opens `pay.ccfautos.com/deposit/<token>` → reads T&Cs → ticks accept → Revolut embedded checkout widget mounts inline → buyer pays via card / Apple Pay / Google Pay / Revolut Pay → webhook flips the car to **Deposit paid** with audit trail.

**Schema (mig 044, 046, 047, 078).** `cars` row gets:
- `deposit_token` (UUID, unique, indexed) — the public URL key. **Rotates on every issue.**
- `deposit_token_expires_at` — 24h from last issue. Public endpoints reject expired tokens with HTTP 410 + `{ code: 'TOKEN_EXPIRED' }`.
- `deposit_amount` — per-car override of `locations.car_deposit_default_amount` (default €500).
- `deposit_link_sent_at` + `deposit_link_sent_via` (`'sms'` only after the Twilio switch).
- `deposit_terms_accepted_at` + `_ip` + `_version` — evidence trail. Version snapshot at acceptance time so if the operator edits T&Cs later, the buyer's accepted version is preserved.
- `deposit_revolut_order_id` + `_checkout_url` — Revolut order linkage.
- `deposit_status` — `null → sent → terms_accepted → paid` (terminal happy path; `cancelled`, `failed`, `refunded` for sad paths).
- `deposit_paid_at` + `deposit_paid_amount`.
- `deposit_receipt_sent_at` (mig 078) — idempotency stamp for the buyer-facing receipt SMS. Set ONLY on a confirmed Twilio success so a transient failure can be retried by the next webhook delivery.

`locations` gets `car_deposit_default_amount`, `car_deposit_terms` (operator-editable text), `car_deposit_terms_version` (bumped server-side every time the wording changes), `car_deposit_whatsapp_template_id` (unused after the Twilio switch — kept in schema for now, can be dropped in a follow-up mig), and `car_deposit_receipt_sms_enabled` (mig 078, BOOLEAN NOT NULL DEFAULT FALSE — per-location opt-in for the deposit-paid receipt SMS; backfilled to TRUE for any location with `car_deposit_default_amount IS NOT NULL` at deploy time so CCF Autos auto-enabled).

**Token rotation.** Every call to `/api/cars/[id]/issue-deposit-link` generates a fresh `deposit_token` (unless the deposit is already paid — then keeps the existing token so the receipt URL stays valid). Old URLs become 404s. Limits the blast radius if a link is forwarded somewhere it shouldn't be. Same call also sets `deposit_token_expires_at = NOW() + 24h` and clears any in-flight Revolut order linkage so the next accept-and-pay creates a fresh order under the new token's idempotency key.

**System notes (mig 047).** `car_notes` table holds two kinds of entries: `manual` (operator-typed) and `system` (auto-generated). Every `issue-deposit-link` call inserts a system note with the URL + the Twilio SID for cross-referencing in Twilio's logs. The note's URL renders as a clickable link with a copy-to-clipboard button in the UI — exactly the affordance an operator needs when they want to copy / re-test / re-share a link without re-clicking the issue button. RLS-scoped via denormalised `location_id`.

**Public page (`src/app/deposit/[token]/page.js`).** Renders `<CarDepositPage>` (a client component). Page loads → fetches deposit data → renders T&Cs + accept checkbox → ticks accept → mounts the Revolut embedded checkout widget → buyer submits → SDK calls `createOrder` callback which POSTs to `/api/public/deposit/[token]/accept-and-pay` → endpoint records the consent (timestamp + IP + terms version snapshot) and creates the Revolut order → returns the order token → SDK takes payment → `onSuccess` fires → page refetches deposit data → green confirmation card. The webhook is the authoritative DB-flip; the SDK callback is just for instant UX feedback.

**Operator UI.** `DepositCard.jsx` (dynamic-imported into `CarDetail.jsx`) shows the status badge, amount input, **Send / Resend deposit link** button, expiry countdown ("expires in 22h 14m"), and a 'View public page' preview link. `CarDepositSettings.jsx` (in `/settings/locations/[id]`) exposes the default amount + terms textarea + the **"Send buyer a receipt SMS when their deposit is paid"** toggle (mig 078) — saving with changed terms bumps the version automatically.

**Deposit-paid receipt SMS (mig 078).** When the Revolut webhook receives `ORDER_COMPLETED` for a car's order, after flipping `deposit_status='paid'` it fires `sendDepositReceiptSms` (`src/lib/deposit-receipts.js`) as a best-effort side effect. Three gates in priority order: location toggle (`car_deposit_receipt_sms_enabled`), idempotency (`cars.deposit_receipt_sent_at`), buyer phone present. Body example: `"Hi Sarah, we've received your €500.00 deposit for Tesla Model 3 241-D-1234. Thanks — we'll be in touch shortly to arrange next steps. CCF Autos."` Single segment for typical car-name lengths. Each successful send stamps `deposit_receipt_sent_at` AND inserts a `kind='system'` `car_notes` entry with the recipient phone + Twilio SID — same diagnostic pattern as the issue-deposit-link route. Failure modes: SMS failure leaves `deposit_receipt_sent_at` unstamped (so a future webhook delivery could retry, though in practice we always 200 so retries don't happen — operator can text the buyer manually if needed and the absence of a system note is the visible signal). The receipt is intentionally **not** part of any consent gate — buyer just paid us money, the receipt is a transactional necessity not a marketing message; the per-location toggle is the right place to opt in/out.

**Concurrency.** Each car is fully isolated end-to-end (`deposit_token`, `deposit_revolut_order_id`, `deposit_revolut_checkout_url`, idempotency key all keyed off the car). 4-5 simultaneous deposits work without contention — Postgres serializes UPDATEs naturally on different rows, Vercel scales horizontally per request, Revolut webhooks land in different car rows. Only edge case: two operators issuing the same car at the exact same moment would race — easy to fix with row-level lock if it ever matters.


