# un1t-crm — external integrations

> Integration reference (env vars, Xero, Twilio, Revolut, Pay subdomain, Cars deposit) extracted from the root `CLAUDE.md` (2026-06-25). Read when wiring or debugging a specific provider. Linked from the CLAUDE.md "Deep reference" index.

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
POSTMARK_API_KEY=
POSTMARK_FROM_EMAIL=hello@un1t.ie
POSTMARK_WEBHOOK_TOKEN=          # shared secret sent in X-Webhook-Token by Postmark (required — route 500s if unset). Set it on EVERY server that posts to us (marketing + support inbox)
POSTMARK_WEBHOOK_TOKEN_PREVIOUS= # optional — old token kept live during rotation; unset after every Postmark webhook config has been flipped to the new value
POSTMARK_EMAIL_INBOX_SERVER_TOKEN= # server token for the SUPPORT INBOX's own Postmark server. Ticket reply/compose only; no fallback — unset = those two routes 503 (EMAIL-OUTBOUND-SERVER.1)
POSTMARK_EMAIL_INBOX_STREAM=     # Postmark message stream id on that server. Defaults to 'email-send'. Postmark's vocabulary, NOT this app's broadcast/outbound
POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN= # token-in-URL secret for the support inbox's INBOUND webhook. ⚠️ Postmark points at the SUPABASE EDGE SHIM, not Vercel: https://iyvtbjjxdggiadzwwvdj.supabase.co/functions/v1/postmark-inbound-shim/<token> (EMAIL-INBOUND-SHIM.1, cut over 2026-08-07). The shim re-hosts attachments to Storage and forwards slim JSON to /api/webhooks/postmark-inbound/<same token> — repointing Postmark at the Vercel URL directly "works" but silently reinstates the ~3.3 MB inbound ceiling (Vercel 413s bodies over ~4.5 MB BEFORE the handler runs; Postmark base64-inlines attachments). Same token value as Edge Function secret + Vercel env. Probe from outside: POST a bogus token to the shim URL — 404 = secrets set and healthy, 500 missing_secret = secrets lost (same trick on the Vercel URL; the 404 is the healthy answer). Revert path in an emergency = paste the Vercel URL back into Postmark, accepting the size ceiling until the shim is restored.
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

# Revolut Merchant — see "Revolut Merchant integration"
REVOLUT_API_KEY=                 # Secret API key (sk_live_... or sk_sandbox_...)
REVOLUT_API_BASE_URL=            # https://merchant.revolut.com (prod) or https://sandbox-merchant.revolut.com
REVOLUT_WEBHOOK_SECRET=          # signing_secret for the CARS deposit webhook (/api/webhooks/revolut)
REVOLUT_RACE_WEBHOOK_SECRET=     # signing_secret for the RACE-PAYMENTS webhook (/api/webhooks/revolut/race-payments). Mig 084. If unset, race route falls back to REVOLUT_WEBHOOK_SECRET (single-merchant transitional case).
REVOLUT_OFFER_WEBHOOK_SECRET=    # signing_secret for the OFFERS webhook (/api/webhooks/revolut/offer-payments). Mig 505. If unset, the route falls back to REVOLUT_WEBHOOK_SECRET.
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

**ONE LOCATION = ONE XERO ORG — never shared.** Each business is a separate legal entity, so two locations on one tenant means one company's bills are filed into another's books. Enforced by `chooseTenantToBind()` in `src/lib/xero/tenant-binding.js`: the callback will not bind an org another location already holds, and refuses outright (naming the holder) when every granted org is taken. Correct a wrong binding with **Change organisation** on the location's Xero settings card — it repoints using the stored refresh token, no new consent needed, and purges + re-syncs the org-specific caches. Applies to every new location and every newly-connected Xero account. Backed by `xero_connections_tenant_id_unique UNIQUE (tenant_id)` (mig 554): the database rejects a second location on the same tenant, verified against the live table. Disconnecting a location also purges its `xero_accounts` / `xero_contacts` / `xero_tax_rates` — those key on `location_id`, which survives the disconnect, so nothing cascades on its own and a later reconnect to a different org would otherwise inherit the previous company's contacts.

`src/lib/xero/client.js` is a hand-rolled fetch wrapper around Xero's REST + OAuth endpoints (the official `xero-node` SDK is deliberately avoided — the surface we use is small and the SDK has churn issues against Next.js). All API calls go through `withFreshToken(locationId)` which transparently refreshes the access_token if it expires within 60 seconds and persists the rotated refresh_token (Xero rotates it on every refresh — failure to persist breaks all future refreshes).

`src/lib/xero/invoices.js` implements `issueCarInvoice(car)` — the customer invoice push for completed cars. Wired to `POST /api/cars/[id]/issue-xero-invoice` and the "Issue invoice" button on `CarDetail`.

OAuth routes:
- `GET /api/xero/connect?location_id=…` — kick off OAuth (sets CSRF cookie, redirects)
- `GET /api/xero/callback` — exchange code, persist tokens, redirect to `/settings/locations/<id>?tab=xero`
- `POST /api/xero/disconnect` — remove the connection row
- `GET /api/xero/status?location_id=…` — safe subset of the connection row (no tokens) for client UIs
- `GET /api/xero/debug` — dev-only diagnostic; dumps masked env vars + the exact authorize URL

Settings UI lives on the per-location Integrations tab — Settings → Locations → \<name\> → Integrations → Xero, i.e. `/settings/locations/<id>?tab=xero` (`XeroIntegrationTab.jsx` wrapping `XeroLocationCard.jsx`). The old standalone `/settings/integrations` page was retired (INTEG-A4).

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

When adding a new Xero feature, append the relevant granular scope to `XERO_SCOPES` in `src/lib/xero/client.js`. Existing connected locations need to click "Reconnect" to receive the additional scope on their token (scopes are additive). The integration card on the per-location Integrations tab (`/settings/locations/<id>?tab=xero`) shows the current scope grant in `connection.scopes`.

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

The earlier Files API path (`src/lib/xero/files.js`) has been deleted — nothing imported it. Email-to-Bills is the supported path because it doesn't require the per-org "Convert files to bills" Files Inbox toggle.

### Webhook authentication

`src/lib/webhook-auth.js` provides `verifyMetaSignature()` (HMAC-SHA256 over the raw body, used by `/api/webhooks/whatsapp`) and `verifySharedSecret()` (constant-time token compare, used by `/api/webhooks/postmark`). Both routes set `export const runtime = 'nodejs'` so `node:crypto` is available.

**Postmark.** Auth is enforced — `POSTMARK_WEBHOOK_TOKEN` is required, and a missing env var returns 500 (not 200-with-warning). The 5xx is deliberate: Postmark retries 5xx responses for ~24h, so a config drift gets recovered as soon as the env var is set, instead of silently dropping events. A bad/missing `X-Webhook-Token` returns 403 (Postmark won't retry 4xx — correct behaviour for a deliberately-rogue caller). The auth predicate is exported from the route as `verifyPostmarkRequest({ headerValue, primarySecret, previousSecret })` and unit-tested in `src/lib/postmark-webhook-auth.test.js`. **Token rotation:** set `POSTMARK_WEBHOOK_TOKEN_PREVIOUS` to the old token while you flip every webhook custom-header config in Postmark over to the new one — both are accepted in the meantime, with a `[security]` warning when the previous one matches so you remember to finish the rotation. Unset PREVIOUS after.

**Postmark — TWO SERVERS, ONE ENDPOINT (EMAIL-OUTBOUND-SERVER.1).** Marketing and the support inbox are separate Postmark servers, and since EMAIL-OUTBOUND-SERVER.1 the ticket reply/compose routes *send* on the support one (`POSTMARK_EMAIL_INBOX_SERVER_TOKEN`, stream `email-send`). Their Delivery/Bounce/SpamComplaint events therefore arrive from a second server. **`/api/webhooks/postmark` is server-agnostic and needs no change to accept them:** it authenticates on a shared secret (not on server identity), dedupes on `RecordType:MessageID`, and every downstream correlation — `email_sends`, `campaign_recipients`, `email_inbox_messages.postmark_message_id` (EMAIL-DELIVERY.1) — keys purely off Postmark's `MessageID`, which is an **account-wide** GUID. Configure the same URL and the same `X-Webhook-Token` custom header on the support server:

```
https://crm.un1tdublin.com/api/webhooks/postmark
X-Webhook-Token: <POSTMARK_WEBHOOK_TOKEN>
```

Until that is configured, ticket replies simply produce **no** delivery events: the thread shows no delivered/bounced marker, `email_sends.status` stays `sent`, and a hard bounce on a support reply does not reach the marketing suppression path (which is otherwise unchanged — see `postmark-webhook-processor.js`). Nothing errors; the events are never sent.

**Meta WhatsApp.** Strict HMAC verification via `verifyMetaSignature()` against `WHATSAPP_APP_SECRET`. Missing env var or bad signature → 403.

When adding a new webhook handler, read the body with `await request.text()` first (verify HMAC), then `JSON.parse()` — calling `request.json()` consumes the body and the re-serialised JSON won't byte-match the signed payload. Mirror the Postmark pattern of exporting the pure auth predicate from the route module so the test can exercise it without mocking Supabase (see `verifyTwilioSignature` in the Twilio status webhook for another example).

### QStash push delivery

QSTASH.1 (pilot) added push-based delivery for `postmark_webhook_queue` alongside its drain cron; QSTASH.3 extended the pattern to webhook dead-letter replays, QSTASH.4 to contact imports, QSTASH.6 to bulk invoice analysis (the first job on a **bounded-parallelism QStash queue** — see below), QSTASH.7 to class-booking requests, QSTASH.8 to host campaign sends (the first **BULK-SEND job — campaign-level kick + chunk chaining**, see below), QSTASH.9 to external export jobs (Strava uploads — the second bounded-parallelism queue), and QSTASH.10 to receipt hunts (the third bounded queue and the first at **parallelism 1** — strict sequentiality preserved; its weekly finalizer stays **cron-only**, see the table row). Common shape: the enqueue site inserts/marks its queue row (unchanged), then fire-and-forget publishes `{ id }` to QStash via `publishQueuePush` (`src/lib/qstash.js` — env-gated on `QSTASH_TOKEN`, never throws), which POSTs the worker route — signature-verified (`Upstash-Signature` HS256 JWT, both signing keys accepted for rotation) and processed through the **same claim CAS** as the sweeper cron, so the two consumers race safely. Workers return 200 for processed/skipped, 500 to make QStash retry; rows QStash gives up on stay pending and the cron sweeps them.

**Campaign-level kick + chunk chaining (QSTASH.8):** a bulk send breaks the one-message-per-row shape — a host campaign can hold thousands of `host_campaign_sends` rows, so a per-recipient publish would burn the QStash free-tier request budget (1000/day) and lose the cron's chunked pacing. Instead the send route publishes **one** campaign-level kick `{ campaignId }` (dedup `host-campaign-<id>-kick`, published only AFTER every fan-out row is enqueued — a kick delivered before the pending rows exist would look "drained" to the worker and mis-finalise the campaign), and the worker processes **one ≤50-row chunk per delivery** through the shared claim CAS, then **self-chains**: while pending rows remain it publishes the next kick `{ campaignId, link+1 }` with a 2s `Upstash-Delay` (gentle pacing) and **no dedup id** — each chain link is a deliberate distinct message; a dedup id would be swallowed inside QStash's dedup window because the body is otherwise identical. Chains are bounded at `MAX_CHAIN` 40 links per delivery lineage (≈2000 rows); past the cap — and whenever a chain publish fails or a link crashes — the sweeper cron drains the remainder, so the queue table stays the delivery guarantee. `halted` campaigns (the sender-verification kill switch) 200-and-stop the chain; they stay `'sending'` and resume via the cron sweeper when UN1T re-verifies the domain.

**Bounded parallelism (`queueName`):** `publishQueuePush({ queueName, queueParallelism, … })` switches from `/v2/publish/` to QStash's FIFO-queue enqueue endpoint (`/v2/enqueue/<queueName>/<destination>`), and QStash then caps concurrent deliveries at the queue's parallelism — how invoice analysis keeps Claude Vision OCR at ≤2 concurrent invocations no matter how many rows an operator queues at once. The queue is upserted **lazily**: only a 404 on the enqueue triggers `ensureQueue(queueName, parallelism)` (`POST /v2/queues`, an idempotent create-or-update — also exported for pinning a queue's parallelism up front) followed by exactly ONE enqueue retry, all inside the never-throws contract. Caveat: whether QStash 404s or auto-creates a missing queue on enqueue is undocumented; if it auto-creates it does so at the default parallelism 1 — still bounded, just slower — so pin parallelism 2 once via `ensureQueue('invoice-analysis', 2)` or the Upstash console when setting up.

Migrated jobs:

| Job | Enqueue site (publish) | Worker route | Shared claim lib | Sweeper cron |
|---|---|---|---|---|
| Postmark webhook queue | `/api/webhooks/postmark` (dedup `postmark-queue-<id>`) | `/api/webhooks/qstash/postmark` | `src/lib/postmark-queue.js` (CAS on `processed_at` NULL→now) | `/api/cron/process-postmark-webhooks` (`*/10` — vercel.json is the truth; QStash push delivers most rows in seconds, the cron is the sweeper) |
| Webhook dead-letter replay | `deadLetterWebhook()` in `src/lib/webhook-dead-letter.js`, replayable providers only (dedup `webhook-replay-<id>`, 60s `Upstash-Delay` so the first replay respects the minimum backoff) | `/api/webhooks/qstash/webhook-replay` | `src/lib/webhook-replay-queue.js` (CAS on `last_attempt_at` unchanged-since-read; no status flip — the table has no 'replaying' status) | `/api/cron/webhook-replay` (`*/5`, keeps the exponential backoff for swept rows; QStash's own retry schedule covers pushed rows) |
| Contact imports | async path of `/api/contacts/import/commit` (dedup `contact-import-<id>`, no delay) | `/api/webhooks/qstash/contact-imports` (`maxDuration` 300 — imports legitimately run minutes; a QStash per-delivery timeout redelivering mid-import 200-skips on the 'processing' status while the original invocation keeps working, by design) | `src/lib/contact-import-queue.js` (CAS on status `pending`→`processing`; no release-on-failure — failed imports stamp `failed` for the operator, they are not blindly retryable) | `/api/cron/process-contact-imports` (`*/2`; keeps the CRON-ONLY stuck-recovery pass that resets `processing` rows older than 5 min back to `pending`) |
| Bulk invoice analysis | `/api/invoices-inbox/bulk-queue-analysis` — per queued row, onto the **`invoice-analysis` QUEUE, parallelism 2** (dedup `invoice-analysis-<id>`; allSettled-batched after the row updates) — the ONLY site that sets `analysis_queued_at` | `/api/webhooks/qstash/invoice-analysis` (`maxDuration` 300; **deterministic extraction failures 200** — the row is stamped with its `extraction_error` and DE-QUEUED per the INV-BULK.1 design, so QStash must not burn rate limit retrying it; 500 only for infrastructure errors) | `src/lib/invoice-analysis-queue.js` (by-id conditional UPDATE mirroring the `claim_invoice_analysis_batch` RPC predicate — fresh `analysis_claimed_at`, stale claims >10 min re-claimable) | `/api/cron/process-invoice-analysis` (`*/2`; keeps the RPC batch claim — FOR UPDATE SKIP LOCKED — whose stale-claim arm IS the crash recovery) |
| Class bookings | `/api/public/class-booking` (the /start wizard) + the WhatsApp Flow completion handler `src/lib/whatsapp-flow/completion.js` (dedup `class-booking-<id>`, no delay; the 23505 dedupe path publishes nothing — no id, and the original submit's publish / the cron covers that row) | `/api/webhooks/qstash/class-bookings` (`maxDuration` 300; **decision-tree outcomes 200** — booked, routed-to-review AND terminally-failed rows are stamped by the processor itself, a retry cannot improve them; 500 only when the processor THROWS — the shared lib re-queued the row under the attempt cap, so the retry re-runs it, mirroring the cron's later-tick retry) | `src/lib/class-booking-queue.js` (CAS on status `queued`→`processing` + attempts bump in one conditional UPDATE; throw-path bookkeeping re-queues under `MAX_ATTEMPTS` 3, else `needs_review`) | `/api/cron/process-class-bookings` (`*/2`; keeps the CRON-ONLY reaper that re-queues rows stuck `processing` >10 min — under the attempt cap — and flags the rest `needs_review`) |
| Host campaign sends (**BULK — campaign-level kick + chunk chaining**) | `POST /api/host/emails/[id]/send` — ONE `{ campaignId }` kick per campaign (dedup `host-campaign-<id>-kick`), published only after the full fan-out enqueue; the worker then self-chains `{ campaignId, link+1 }` per ≤50-row chunk (2s delay, NO dedup id, ≤`MAX_CHAIN` 40 links/lineage). The send route is the ONLY site that flips a campaign into `'sending'` (repo-sweep verified); re-verifying a halted campaign's sender flips no status and deliberately publishes nothing — the cron resumes it | `/api/webhooks/qstash/host-campaigns` (`maxDuration` 300; **chunk_sent/drained/halted/skipped 200** — halted = the sender-verification kill switch, campaign stays `'sending'` and resumes via the cron; **500 only for infrastructure errors** — retry-safe because a crashed attempt's claimed rows are swept terminal by the cron, never re-sent) | `src/lib/host-campaign-queue.js` (CAS on status `pending`→`claimed` batched by campaign; send-time consent + per-host-suppression re-check per claimed row; finalise only when nothing pending AND nothing claimed; count-query errors throw rather than mis-finalise) | `/api/cron/send-host-campaigns` (`*/2`; keeps the CRON-ONLY stale-claim sweep — `claimed` >15 min → terminal `failed`, no attempts column so terminal is the only never-double-send choice — plus the ≤5-campaigns-per-tick loop and heartbeat) |
| External export jobs (Strava uploads) | `enqueueExportsForSession()` in `src/lib/external-export.js` (fired from live-class `endSession`, `source='ble_bridge'` sessions only) — per FRESHLY-INSERTED job via `.select('id')` on the ignoreDuplicates upsert (a re-enqueued session never re-publishes), onto the **`strava-exports` QUEUE, parallelism 2** (dedup `strava-export-<id>`, no delay — each export burns 2–4 Strava API calls against the 100-req/15-min budget, and endSession fans out per member on class end); the requeue-on-failure path deliberately does NOT publish — retries belong to the cron's backoff | `/api/webhooks/qstash/strava-exports` (`maxDuration` 60, same as the cron; **job failures return 200** — the bookkeeping already re-queued the row with `next_attempt_at` backoff or went terminal at the attempt cap, and the claim is NOT a CAS, so a QStash retry could race the cron into a duplicate upload and burn rate budget; 500 only for infrastructure errors) | `processExportJob()` in `src/lib/external-export.js` (the queue's own lib — no new file; claim = blind status flip 'processing'+attempts+1, NOT a CAS — the documented accepted race, Strava de-dupes by external_id; worker eligibility: 'queued' AND `next_attempt_at` due) | `/api/cron/run-strava-exports` (`*/2`; its batch select includes 'processing' — that IS the crash recovery, CRON-ONLY — and owns every retry on the queue's 1m→6h backoff schedule) |
| Receipt hunts (recon_bank_lines) | `seedHunts()` in `src/lib/recon/statuses.js` (the Friday receipt-coverage-weekly cron's seed step) — per seeded row via the seed update's `.select('id')`, onto the **`receipt-hunts` QUEUE, parallelism 1** (dedup `receipt-hunt-<id>`, no delay — a hunt opens IMAP sessions against the location's mailboxes + burns a Claude Vision call per candidate; hunting has ALWAYS been strictly sequential and the parallelism-1 bound preserves that while replacing */5-poll latency with continuous drain); publishes are **capped at `HUNT_PUBLISH_CAP` 200 per seed call** (~2 locations → ≤400/Friday, safely inside the 1000-req/day free tier; a normal week seeds a handful) — overflow rows drain via the cron sweep | `/api/webhooks/qstash/receipt-hunts` (`maxDuration` 300, same as the cron; **EVERY hunt outcome returns 200 — found, not_found AND error**: `huntLine` never throws, and an error already ran `errorFinish` — terminal `recon_hunts` audit row + de-queue, exactly what the cron does (tallies `failed`, never retries; next Friday re-seeds); 500 only for infrastructure errors. **The weekly finalizer is CRON-ONLY**: the worker NEVER calls `maybeFinalizeWeekly` — it emails the coverage report and stamps ANOTHER cron's heartbeat, and its already-reported guard is check-then-act; worst case the report waits ≤5 min for the next cron tick. The worker stamps no heartbeat) | `src/lib/recon/hunt-queue.js` (by-id conditional UPDATE mirroring the `claim_recon_hunt_batch` RPC predicate — status in uncovered/not_found + `hunt_queued_at` set + fresh `hunt_claimed_at`, stale claims >10 min re-claimable; the per-row unit is the pre-existing shared `huntLine`, nothing extracted) | `/api/cron/process-receipt-hunts` (`*/5`; keeps the RPC batch claim — FOR UPDATE SKIP LOCKED — whose stale-claim arm IS the crash recovery, the `maybeFinalizeWeekly` call, and BOTH heartbeats: its own every tick, the weekly one via the finalizer) |

**Deliberately NOT migrated:** `run-campaigns` stays on its */2 cron by decision (Richard, 2026-07-19) — it already paces sends via claim-before-send in 500-recipient chunks, and per-chunk QStash publishes would push the free tier's 1000-requests/day cap for no operator-visible benefit. See docs/BACKLOG.md before "completing the pattern".

**Setup (operator):** create an Upstash account → QStash → copy the token + current/next signing keys into Vercel env. **Rollback / kill switch:** unset `QSTASH_TOKEN` — publishing stops, the crons carry everything again; no code change, no data loss (the tables are the source of truth throughout). **Dedup keys are DASH-ONLY** — QStash 400s on colons in `Upstash-Deduplication-Id` (undocumented; the first live publish proved it).

### Rate limiting

`src/lib/rate-limit.js` provides `checkRateLimit(db, key, { max, windowMs })` backed by the `rate_limit_buckets` table (migration 015). Currently wired to:

- `POST /api/public/book` — 5/15 min per IP
- `POST /api/unsubscribe/[token]` — 10/15 min per IP
- `GET/PUT /api/preferences/[token]` — 20/15 min per IP

The limiter is fail-open (DB error → request allowed, warning logged) so a Supabase blip can't take down the booking flow. Routes call `getClientIp(request)` to derive the bucket key from `x-forwarded-for`. Cron `/api/cron/prune-rate-limits` deletes expired buckets nightly at 03:30 UTC.

Add a new public endpoint? Wire the limiter at the top of the handler with a unique bucket prefix (`book:`, `unsubscribe:`, etc.) and `export const runtime = 'nodejs'` so `node:crypto` is available transitively.

### Reviews carousel

A `reviews` landing-page block renders a pure-CSS marquee ("wall of love") of reviews on `/welcome/[location]`, read from the `google_reviews` table (mig 249). Auto-filtered to a configurable minimum rating (default 4★), newest first, with a per-review `hidden` toggle. Config (heading, min rating, marquee speed, aggregate header) lives in the landing-page editor; block editing uses the `landing_page` permission.

**Reviews are populated manually.** The Google Business Profile API sync (OAuth + `/api/cron/sync-google-reviews` + `google_business_connections`) was retired in **mig 410** — the API's access-approval gate (days–weeks, 0→300 QPM) wasn't worth it for our volume. To load/refresh reviews, insert rows into `google_reviews` (`location_id`, `google_review_id` unique per location, `rating`, `comment`, `author_name`, `review_time`, `hidden=false`); `scripts/seed-google-reviews.mjs` is a starting point. The aggregate header + JSON-LD `aggregateRating` are dormant (they read the removed connection); wire an operator-editable aggregate onto the reviews block if the "X★ · N reviews" headline is wanted. Historical design: `docs/REVIEW_CAROUSEL_DESIGN.md`.


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


## Shelly Cloud (smart plugs and relays)

**No env vars.** Credentials are per location: an owner or master pastes the studio's Shelly *Authorization cloud key* and account server (Shelly Smart Control app → User settings → Authorization cloud key) on **Automations → Smart plugs** (`/automations/shelly`). The `shelly_connections` row is the configuration; with zero rows the `shelly-reconcile` cron is dormant and still stamps its heartbeat — but only a tick that COMPLETED stamps: an explicit `ok: false` (the connection load failed, or the clock is unusable) skips the stamp, and the heartbeat's 900 s grace absorbs a single blip so only a sustained failure pages.

**Operator flow, as shipped (SHELLY-UI.1→.9).** The whole surface is one page, `/automations/shelly`, gated by `device_control`. Every route scopes by the session's ACTIVE LOCATION — none of them accepts a `location_id` — so "which studio am I configuring" is answered by the location switcher and by nothing else.

1. **Connect.** Automations → Smart plugs → paste the account server and the cloud auth key. Owner or master only (managers hold `device_control` but not a live credential); everyone else sees a read-only line. The key is proved against Shelly BEFORE it is stored, so a typo is a 400 at paste time rather than a credential that fails forever. The panel then shows `host · ••••abcd · last OK`, and a "connected, N devices found" line — *N* is what the probe counted on the account, and **0 is a real state** (a Shelly account in maintenance looks exactly like that). When the probe could not count at all the sentence is omitted entirely rather than printing a zero nobody can act on.
2. **Find devices → Adopt.** "Find devices" lists every relay channel the account can see, with a chip per row: *Adopted here* / *In use at &lt;name&gt;* (same organisation only) / *In use elsewhere* (another business — named to nobody) / *Not supported yet* / *Offline*. Adopt claims one channel; a four-relay Pro 4PM is one device and four rows, which is why the discovery count is labelled in relays and the connect count in devices. A device the caller's own account cannot see is **"Not found on this Shelly account"** — deliberately the same answer as "no such device", so the ownership check cannot be used to probe another tenant's hardware.
3. **Schedule.** Per device: *no schedule*, *fixed windows* (up to 16 recurring on/off windows, overlaps refused at save time because the planner would silently drop the later one), or *class* — on `lead_min` before the day's first class and off `lag_min` after the last one ends, following the location-wide timetable. Class mode needs Glofox at that location; fixed mode needs at least one window before the schedule can be switched on.
4. **Toggle.** On / Off / **Back to schedule**. On a **managed** device (enabled *and* a schedule) the duration presets — until midnight, 1 h, 3 h — mean what they say: the schedule resumes in both directions when the override expires. On an **unmanaged** device (schedule off, or no schedule) the engine never closes an expired override, so the card drops the presets and says "No schedule runs this plug — it stays as you set it until you change it". A toggle on an **offline** plug is not refused: the override is written first and the cron applies it when the plug is back, so the button answers "Queued" rather than an error.
5. **Run now always re-sends the scheduled state** — it does not check whether the relay already agrees, so it costs one slot of the shared 1 req/s account budget even when nothing changes. That is deliberate: the button exists to override the exactly-once stamp, and a version that could decline would be indistinguishable from one that silently failed. It keeps the two REFUSALS apart on purpose — *no schedule to apply* and *the schedule is switched off* — and checks the first before the second, because "turn the schedule on" is useless advice when there is no schedule to turn on.
6. **Remove destroys the device's energy history** (`shelly_energy_daily` is `ON DELETE CASCADE`), and because a relay channel can be adopted at exactly one location, **relocating a plug to another studio is necessarily remove-then-adopt** — the kWh history does not travel with it. The confirm names the loss before the click.
7. **Disabling a schedule leaves the relay exactly as it is.** `enabled: false` means "not mine to touch", not "switch off" — an operator turning a schedule off at 06:00 to stop it firing at 07:00 must not have the room go dark under them. The response and the card both say so when the plug is currently held on.
8. **Integrations hub** carries a *Shelly plugs* card per in-scope location, deep-linking to `/automations/shelly` for the active one. A location with adopted plugs but no connection shows as a half-set-up nag rather than as healthy.
9. **"Use Shelly names" copies the labels from the Shelly app** onto the adopted rows (SHELLY-NAMES.1) — two choices, because a replaced name has no undo: *Only unnamed plugs* (the default) and *All plugs — replaces names typed here*. It writes only `name`, never a relay. A plug the account carries no label for anywhere is reported as such rather than silently skipped, and the request logs the payload's KEY SHAPE (key names and typeof strings only — `settings` carries the device's wifi and MQTT credentials, so no value from it is ever logged) so a label living somewhere the resolver does not yet look can be found from one press. **The labels themselves come from the ACCOUNT layer** (SHELLY-NAMES.3): the v2 Cloud Control payload proved label-free at the live gate — the Smart Control app names the account RECORD, which that API never returns — so when the device payload carries no name the surface makes one further call to the undocumented-but-live `POST /interface/device/list` (the endpoint Shelly's own web UI reads) and takes the name from there; that call is an enhancement and never a gate, so a failure on it is logged and the names resolved from the device payload are written anyway.

**When the key dies.** Changing the Shelly account password invalidates the key: the connection flips to **Action needed** and the copy is "Shelly rejected the stored key — re-paste it from the Shelly app (User settings → Authorization cloud key)". Re-pasting clears the badge in the same request. A connection reading **error** instead is *retrying* — a network blip, a 5xx or a rate limit — and needs nothing from the operator; only an auth failure is ever reported as a bad key. A paste that answers `verification_unavailable` is the third case: our own duplicate-key lookup failed, so we cannot prove the key is not another business's. Every doubtful case refuses — try again in a moment.

**The status vocabulary is documented per operation at `/api-docs`** (tag *Automations*), not as one blanket list, because the same word means different things on different routes: `key_rejected` is a 400 on the connection PUT (you just pasted it) and a 409 everywhere else (the STORED key stopped working); a 429 `rate_limited` on the toggle carries `success: true` because the override is saved and the cron will apply it; and `GET /api/shelly/devices` can answer 200 with `connected: null` — a third state meaning "the connection row could not be read", which must not be rendered as "not connected".

**Bundle.** `device_control` is enabled by **Marketing OR Operations** since mig 564 (it was Marketing-only, inherited from when the key gated Sonos studio music). Widening rather than moving it is what stops an Operations-only tenant — a studio that buys the ops bundle and not the marketing one — being unable to switch on its own heaters. Behaviour-neutral for every location live at the time: none had Marketing off.

- **One Shelly account per location.** The same account may be linked at several locations of one organisation (an owner with two studios); a key already linked at a location in another organisation is refused, and the refusal never names it. A physical relay channel (`device_id`, `channel`) can be adopted at exactly one location — enforced by the database.
- **Changing the Shelly account password invalidates the key.** The cron flips the connection to `action_needed` within a minute and retries every 15 minutes; the owner re-pastes the key. The account server host can also change (Shelly relocates tenants) — same repair. A connection that is merely FAILING (network, 5xx, 429) is parked 5 minutes instead (`ERROR_RETRY_MS`): an outage nobody has to fix, retried far sooner than a wrong key but not 1,440 times a day.
- **Rate limit is 1 request/second per account.** The client paces itself (end-to-start ≥1 s), batches reads (`MAX_GET_IDS` = 10) and writes (`set/groups`), retries a 429 once, and the cron serialises same-account locations while running different accounts in parallel — with a 1 s handoff between two locations of one account, because each builds its own client and a fresh one believes it has never called. Connections are swept oldest-`last_ok_at` first (nulls first), so a tick that runs short of budget rotates the shortfall round the estate instead of starving the same tail every minute.
- **A failing account is backed off, never hammered.** The first failed read batch *before any success* ends that tick's reads and skips its commands too (the black-hole stop) — with nothing behind it, every remaining batch would spend a slot of the shared budget to learn the same thing. `connected` is written only for a tick with at least one 2xx **and** no hard 429 (`budgetHit`), so a studio whose relays did not move never shows a green badge; an unmade request is never evidence, so a location the budget skipped keeps the status it had. A `get` that answers 2xx with a top-level `error` body counts as a FAILED read: read as success it is indistinguishable from "the account answered and mentioned nobody", which writes every device at the location offline.
- **Two diagnostics, gated on change.** Every covered id coming back unmentioned (the v2 id echo) and every device reading offline (the v2 `online` field) each warn only on a tick where an affected device could have changed state — a never-read device counts as a transition, so the first tick after adopt is still the one that names the bug, while a genuinely dark studio stays quiet all night.
- **Gen2+ only** (Plus/Pro/Gen3/Gen4 `switch:N` shape). Gen1 and non-switch devices (Pro 3EM) are marked unsupported at discovery; an offline device is never judged ("ask again later").
- **Schedules are boundary exactly-once** plus a two-way manual override: humans win between boundaries, a failed command is retried next tick, a class-timetable read failure skips class devices for that tick rather than switching them off.
- **Energy** is rolled per channel per local day from the monotonic `aenergy.total` counter (resets and power-cut rollbacks handled); read it per device. The carry window is `ENERGY_LOOKBACK_DAYS` = 7 days, selected per device with an explicit column list (never `*` — the row round-trips into the upsert), and `ENERGY_ROW_CAP` pins the worst case (every device × every day of the window) under PostgREST's 1k ceiling.
- **Device freshness is graded against the engine's WRITE floor, not its read cadence.** The cron reads every adopted plug once a minute but only rewrites a row when something actually moved (a deadband swallows a wattmeter twitching in the third decimal), so an idle plug's `last_seen_at` advances only on the `STATE_REFRESH_MS` refresh floor — every five minutes. The card's green window is therefore that floor plus one sweep (six minutes), amber to fifteen, red past it. Sizing it to the read cadence instead made every healthy idle plug flicker amber for two minutes in every five.
- **Integrator API** (Shelly's consent-based multi-account model) is a parallel operator application — https://forms.office.com/e/KDxYr4K3vF or support@shelly.cloud, business email required. Swapping to it changes `src/lib/shelly/client.js` only.
- **Secrets never leave the server**: routes expose `key_hint` (last four characters) and `has_auth_key`; the client never logs a URL or request body (the key rides in the query string / form body); `redactSecret` covers the raw and encoded forms.


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


