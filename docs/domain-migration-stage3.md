# Domain migration — Stage 3: provider re-registration runbook (CONSOLE-ONLY)

> **REPSET-P6.S3.** As of Stage 2 (#1446) the platform is canonically on
> **crm.repset.ie** (CRM) and **api.repset.ie** (member app). This runbook is the
> single tracking surface for re-pointing every external provider that still has a
> legacy host registered. **No code changes belong in this stage** — every item
> below is a provider console/portal/API action (plus, where flagged, a Vercel env
> value or one pre-written SQL statement).

## The standing rule

**The legacy hosts (`crm.un1tdublin.com`, `app.champfitness.ie`) keep serving
indefinitely.** Both hostnames front the same Vercel deployment, so a webhook or
OAuth redirect registered against the old host keeps working exactly as before.
Nothing on this page is urgent, nothing breaks while a box is unticked, and each
item is independently schedulable. But each item **must eventually happen** —
this page is where that is tracked. Tick a box only after its verification step
has been observed.

## Status

| # | Provider / item | Owner | Done when | Status |
|---|---|---|---|---|
| 1a | Stripe — Connect endpoint (`/api/webhooks/stripe`) | Richard (dashboard) + env flip | New endpoint shows successful deliveries on crm.repset.ie AND `STRIPE_WEBHOOK_SECRET` = new endpoint's secret AND old endpoint disabled | [ ] |
| 1b | Stripe — wallet endpoint (`/api/webhooks/stripe-wallet`) | Richard (dashboard) + env flip | Same, for `STRIPE_WALLET_WEBHOOK_SECRET` | [ ] |
| 2a | Revolut — cars webhook (`/api/webhooks/revolut`) | Richard or agent (API) + env flip | New webhook delivering, `REVOLUT_WEBHOOK_SECRET` = new secret, old webhook deleted | [ ] |
| 2b | Revolut — race-payments webhook | Richard or agent (API) + env flip | Same, for `REVOLUT_RACE_WEBHOOK_SECRET` | [ ] |
| 2c | Revolut — class-bookings webhook | Richard or agent (API) + env flip | Same, for `REVOLUT_CLASS_BOOKING_WEBHOOK_SECRET` | [ ] |
| 2d | Revolut — offer-payments webhook | Richard or agent (API) + env | Webhook registered against crm.repset.ie, `REVOLUT_OFFER_WEBHOOK_SECRET` set (registration was still an open item from the weekend sale — may go straight to the new host) | [ ] |
| 3 | Glofox — webhook target | Richard → Glofox support | Glofox support confirms target = crm.repset.ie and a live event lands in `glofox_webhook_events` | [ ] |
| 4a | Xero — OAuth redirect pair (portal URI + `XERO_REDIRECT_URI`) | Richard (same window) | Both read `https://crm.repset.ie/api/xero/callback`; a Reconnect round-trip succeeds | [ ] |
| 4b | Xero — webhook delivery URL + signing key | Richard (portal) | Intent-to-receive passes on the new URL; `XERO_WEBHOOK_KEY` matches the key the portal shows | [ ] |
| 5a | Strava — push-subscription callback | Agent (API, curl) | `GET push_subscriptions` shows `callback_url` on crm.repset.ie; a real activity ingests | [ ] |
| 5b | Strava — OAuth pair (app callback domain, then DB row) | Richard (strava.com) then agent (SQL) | App domain = `api.repset.ie` AND `service_integrations.redirect_uri` flipped; a fresh member connect succeeds | [ ] |
| 6 | Zoom | — | **No action** — Server-to-Server OAuth, outbound only; nothing URL-shaped is registered with Zoom | [x] n/a |
| 7 | InBody / Lookin'Body — portal webhook URL | Richard (InBody portal) | Portal Step 4 test passes against crm.repset.ie; next real scan lands in `inbody_webhook_events` | [ ] |
| 8 | Supabase — Auth Site URL (+ redirect allow-list) | Richard (Supabase dashboard) | Site URL = `https://crm.repset.ie`; legacy hosts remain in Additional Redirect URLs | [ ] |
| 9 | Postmark — webhooks (all servers/streams) | Orchestrator fills | *see MCP inventory* | [ ] |
| 10 | Meta — WhatsApp + Instagram webhooks, ES/OAuth surfaces | Orchestrator fills | *see MCP inventory* | [ ] |

---

## 1. Stripe (platform account) — **cutover flip, not add-alongside**

### The verification mechanism (why this one is subtle)

Both Stripe routes verify against **one env secret each — no multi-secret try**:

- `/api/webhooks/stripe` → `verifyStripeWebhook()` reads **only**
  `STRIPE_WEBHOOK_SECRET` (`src/lib/stripe.js:47-49`).
- `/api/webhooks/stripe-wallet` → `verifyStripeWalletWebhook()` reads **only**
  `STRIPE_WALLET_WEBHOOK_SECRET`, with **deliberately no fallback** to the
  Connect secret (`src/lib/stripe.js:65-78`; the route 503s while unset,
  `src/app/api/webhooks/stripe-wallet/route.js:33-42`).

Every Stripe endpoint you create gets its **own** `whsec_…` signing secret. So
although Stripe happily hosts multiple endpoints, the moment a second endpoint
exists, only ONE of the two can verify at any time — whichever one the single
env var currently matches. **Add-alongside-and-wait does not work here without a
code change; the console-only strategy is a cutover flip.** The flip is safe
because Stripe retries failed deliveries with backoff for up to ~3 days, so the
brief window where the new endpoint 400s (before the env flip) is recovered
automatically, and after the flip the old endpoint's 400s stop mattering once
you disable it.

### Current registered values

- Connect endpoint → `https://crm.un1tdublin.com/api/webhooks/stripe`, secret in
  `STRIPE_WEBHOOK_SECRET` ("Register ONE endpoint … Its signing secret is
  STRIPE_WEBHOOK_SECRET", `src/app/api/webhooks/stripe/route.js:1-6`), created
  with **"listen to events on connected accounts" enabled**
  (`src/lib/stripe.js:12-14`).
- Wallet endpoint → `https://crm.un1tdublin.com/api/webhooks/stripe-wallet`,
  secret in `STRIPE_WALLET_WEBHOOK_SECRET`; subscribed to **only**
  `checkout.session.completed` + `checkout.session.expired`, **without**
  connected-accounts (`src/app/api/webhooks/stripe-wallet/route.js:1-12`).

### New values

- `https://crm.repset.ie/api/webhooks/stripe`
- `https://crm.repset.ie/api/webhooks/stripe-wallet`

### Console steps (per endpoint — do 1a and 1b as two separate passes)

1. Stripe Dashboard → **Developers → Webhooks** (dashboard.stripe.com/webhooks),
   live mode.
2. **Add endpoint** with the new URL. Recreate the event configuration
   **exactly**: for 1a tick *"Listen to events on Connected accounts"* and the
   same event list as the old endpoint (open the old endpoint's page side-by-side
   and copy its "Listening to" list); for 1b select only
   `checkout.session.completed` + `checkout.session.expired` and leave
   connected-accounts OFF.
3. Reveal the new endpoint's **Signing secret** (`whsec_…`).
4. Vercel → un1t-crm → Settings → Environment Variables → Production: set
   `STRIPE_WEBHOOK_SECRET` (1a) / `STRIPE_WALLET_WEBHOOK_SECRET` (1b) to the new
   secret → **redeploy** (env changes need a redeploy to take effect).
5. Back in Stripe: **Disable** (do not yet delete) the old endpoint. Both
   endpoints receive the same events, so disabling old at flip time leaves no gap.
6. After a week of clean deliveries, delete the old endpoint.

### Verification

- New endpoint's page in Stripe shows deliveries with **200** responses (the
  Connect endpoint gets `account.updated` traffic organically; for the wallet
  endpoint use Stripe's "Send test webhook" — the route answers 400 on a test
  signature only if the secret mismatches, 200/ignored if it verifies).
- Old endpoint shows **Disabled**.
- No 400 "Invalid Stripe signature" spikes in Vercel logs after the flip.

---

## 2. Revolut (Merchant API) — flip per endpoint; duplicates are pre-deduped

### The verification mechanism

Unlike Stripe, the shared verifier **accepts a LIST of secrets and any match
wins**: `verifyWebhookSignature(rawBody, sig, ts, { secrets })`
(`src/lib/revolut.js:175-199`). Each route passes its own chain:

| Route | Secrets tried (in order) | Cite |
|---|---|---|
| `/api/webhooks/revolut` (cars deposits) | `REVOLUT_WEBHOOK_SECRET` only | `src/app/api/webhooks/revolut/route.js:5,74-77` |
| `/api/webhooks/revolut/race-payments` | `REVOLUT_RACE_WEBHOOK_SECRET`, then `REVOLUT_WEBHOOK_SECRET` | `…/race-payments/route.js:44-48` |
| `/api/webhooks/revolut/class-bookings` | `REVOLUT_CLASS_BOOKING_WEBHOOK_SECRET`, then `REVOLUT_WEBHOOK_SECRET` | `…/class-bookings/route.js:40-44` |
| `/api/webhooks/revolut/offer-payments` | `REVOLUT_OFFER_WEBHOOK_SECRET`, then `REVOLUT_WEBHOOK_SECRET` | `…/offer-payments/route.js:37-41` |

Each webhook registered with Revolut mints its **own** `wsk_…` signing secret,
and each env slot holds one value — so, like Stripe, the env value for a given
endpoint is a **flip**, not an accumulation. But the Revolut flip is more
forgiving than Stripe's, for two reasons grounded in the code:

1. While old + new webhooks are both registered, Revolut delivers **every event
   to both**. One copy verifies (whichever secret is in env), the other 401s and
   is retried/eventually dropped. The verified duplicate is harmless: all four
   handlers dedupe on `webhook_events` / row-state guards (route headers, e.g.
   `…/offer-payments/route.js:12-15`).
2. Never delete the old webhook until the new one is confirmed flowing —
   the **race-payments precedent**: these are deliberately **separate webhooks
   per business flow, never aliased or merged** (`…/race-payments/route.js:1-20`
   spells out why). Re-register each of the four as its own webhook on the new
   host; do not consolidate them "while we're at it".

### Current registered values

Registered via the Merchant API against
`https://crm.un1tdublin.com/api/webhooks/revolut` (and the three sub-paths) —
see the registration recipe + current URL in
`docs/architecture/INTEGRATIONS.md:248-261` and the offers registration plan in
`docs/superpowers/specs/2026-08-08-offer-sale-pages-design.md:68`.
⚠️ **2d (offer-payments) may never have been registered at all** — it was left as
an open operator item after the weekend sale ended (the route falls back to
`REVOLUT_WEBHOOK_SECRET` meanwhile). Check with
`GET https://merchant.revolut.com/api/webhooks` first; if absent, register it
directly against the new host and skip the flip dance.

### New values

- `https://crm.repset.ie/api/webhooks/revolut`
- `https://crm.repset.ie/api/webhooks/revolut/race-payments`
- `https://crm.repset.ie/api/webhooks/revolut/class-bookings`
- `https://crm.repset.ie/api/webhooks/revolut/offer-payments`

### Steps (per endpoint; the webhook UI doesn't surface in every Business dashboard layout — the API is the reliable path)

1. List what exists: `curl -H "Authorization: Bearer $REVOLUT_API_KEY" -H "Revolut-Api-Version: 2026-03-12" https://merchant.revolut.com/api/webhooks`
2. Create the new webhook (same events as the old row — copy them from step 1):

   ```bash
   curl -X POST https://merchant.revolut.com/api/webhooks \
     -H "Authorization: Bearer $REVOLUT_API_KEY" \
     -H "Revolut-Api-Version: 2026-03-12" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://crm.repset.ie/api/webhooks/revolut", "events": ["ORDER_COMPLETED", "ORDER_AUTHORISED", "ORDER_PAYMENT_DECLINED", "ORDER_PAYMENT_FAILED"]}'
   ```

   The response includes `signing_secret` (`wsk_…`); it's also retrievable later
   via `GET /api/webhooks/{id}` (`docs/architecture/INTEGRATIONS.md:261`).
3. Vercel → set the endpoint's env slot (`REVOLUT_WEBHOOK_SECRET` /
   `REVOLUT_RACE_WEBHOOK_SECRET` / `REVOLUT_CLASS_BOOKING_WEBHOOK_SECRET` /
   `REVOLUT_OFFER_WEBHOOK_SECRET`) to the new `wsk_…` → redeploy.
4. Confirm a real (or sandbox-rehearsed) event verifies on the new webhook, then
   `DELETE https://merchant.revolut.com/api/webhooks/{old_id}`.

### Verification

- A live order event lands with 200 (check `webhook_events` rows for the
  provider, or Vercel logs for the route); no persistent 401 "Invalid signature"
  entries after the old webhook is deleted.

---

## 3. Glofox — webhook target (configured Glofox-side)

- **Current value:** Glofox POSTs to
  `https://crm.un1tdublin.com/api/webhooks/glofox`. There is no self-serve
  webhook console — the setup was **requested through Glofox support** and is
  configured on their side (`src/lib/glofox.js:53-54`; receiver:
  `src/app/api/webhooks/glofox/route.js:1-30`).
- **New value:** `https://crm.repset.ie/api/webhooks/glofox`
- **Steps:** email/ticket Glofox support asking them to repoint the webhook
  target for branch `a0000000-…0001` (Stillorgan — the only live branch) to the
  new URL. **No secret change needed**: auth is the per-location
  `webhook_secret` stored on the CRM location row
  (`locations.settings.glofox.webhook_secret`, `src/lib/glofox.js:315,365`) and
  HMAC verification is host-agnostic.
- **Verification:** after Glofox confirms, watch `glofox_webhook_events` for a
  fresh `event_id` (bookings arrive constantly at Stillorgan); a same-day row
  means deliveries are flowing to the new host.

---

## 4. Xero — the SAME-WINDOW redirect pair, plus the webhook

### 4a. OAuth redirect pair (auth-time-only — existing connections are safe)

The redirect URI is used **only at authorise time**; connected locations refresh
tokens server-to-server, so nothing live breaks while the pair is stale — but
"Connect"/"Reconnect" fails whenever the two halves disagree, so change them
**in the same sitting**:

- **Current values:** `XERO_REDIRECT_URI=https://crm.un1tdublin.com/api/xero/callback`
  (env — deliberately left on the old host through Stage 2;
  `docs/architecture/INTEGRATIONS.md:33`) and the **identical** value registered
  on the Xero app ("register EXACTLY that value … no trailing slash, lowercase,
  https", `src/app/api/xero/debug/route.js:58`; consumed at
  `src/lib/xero/client.js:121`).
- **New value (both halves):** `https://crm.repset.ie/api/xero/callback`
- **Steps (one window):**
  1. developer.xero.com → My Apps → the CRM app → **Configuration** → Redirect
     URIs → add `https://crm.repset.ie/api/xero/callback` (Xero allows several —
     keep the old one listed during the transition; remove it at final cleanup).
  2. Vercel → `XERO_REDIRECT_URI` → new value → redeploy.
  3. Sanity-check with `GET /api/xero/debug` (dev-only route) — since Stage 2 it
     derives `expectedRedirectUriInXero` from the env var, so it shows exactly
     what must be registered (`src/app/api/xero/debug/route.js:57-58`).
- **Verification:** Settings → Locations → Stillorgan → Integrations → Xero →
  **Reconnect** completes the OAuth round-trip and lands back on
  `/settings/locations/<id>?tab=xero` connected.

### 4b. Webhook delivery URL + signing key

- **Current value:** `https://crm.un1tdublin.com/api/webhooks/xero`; auth is
  HMAC-SHA256 with **the per-webhook signing key from the Xero developer
  portal**, env `XERO_WEBHOOK_KEY` (`src/app/api/webhooks/xero/route.js:10-14`,
  key checked at `:126-129`).
- **New value:** `https://crm.repset.ie/api/webhooks/xero`
- **Steps:** developer.xero.com → My Apps → the app → **Webhooks** → change
  "Delivery URL" to the new value → Save. Saving triggers Xero's
  **Intent-to-receive** validation (a signed POST the route must answer
  correctly — it does, same key). The portal shows the webhook signing key on the
  same page: confirm it is unchanged; if Xero rotates it on edit, copy the new
  key into `XERO_WEBHOOK_KEY` and redeploy **before** clicking retry on the ITR.
- **Verification:** ITR shows **OK** in the portal; next invoice CREATE/UPDATE
  event flows (visible as `cars` / `invoices_queue` status updates, or the route
  in Vercel logs answering 200). Remember Xero auto-disables the hook after
  repeated failures (`src/app/api/webhooks/xero/route.js:18-19`) — if it was
  ever disabled, re-enable after the URL change.

---

## 5. Strava — webhook callback + the OAuth pairing order

### 5a. Push-subscription callback (received by the CRM host, not the member app)

`/api/webhooks/strava` lives in **un1t-crm** (`src/app/api/webhooks/strava/route.js`),
so its host is the CRM host — the new value is on **crm.repset.ie**, not
api.repset.ie.

- **Current value:** subscription registered with
  `callback_url=https://crm.un1tdublin.com/api/webhooks/strava`
  (`docs/superpowers/plans/2026-06-23-strava-direct-inbound.md:533`). The GET
  handshake verifies `STRAVA_WEBHOOK_VERIFY_TOKEN`
  (`src/app/api/webhooks/strava/route.js:13-16`) — env unchanged by this
  migration.
- **New value:** `https://crm.repset.ie/api/webhooks/strava`
- **Steps:** Strava allows **one push subscription per app** and the callback
  can't be edited in place — view, delete, re-create (client id/secret from
  `service_integrations`):

  ```bash
  # view (note the id)
  curl "https://www.strava.com/api/v3/push_subscriptions?client_id=<id>&client_secret=<secret>"
  # delete the old one
  curl -X DELETE "https://www.strava.com/api/v3/push_subscriptions/<sub_id>?client_id=<id>&client_secret=<secret>"
  # re-create on the new host (Strava GETs the callback to verify first)
  curl -X POST https://www.strava.com/api/v3/push_subscriptions \
    -F client_id=<id> -F client_secret=<secret> \
    -F callback_url=https://crm.repset.ie/api/webhooks/strava \
    -F verify_token=$STRAVA_WEBHOOK_VERIFY_TOKEN
  ```

  (Delete-then-create means a short gap with no push events; Strava data is
  re-fetchable and personal-only — acceptable.)
- **Verification:** the POST returns `{ id }`; a subsequent GET shows the new
  `callback_url`; next activity from a connected athlete appears in
  `strava_activities`.

### 5b. OAuth redirect_uri — a PAIR, in this order

Two halves must agree: the Strava app's **Authorization Callback Domain**
(strava.com/settings/api — a single bare domain) and the DB row the CRM builds
authorize URLs from (`buildAuthorizeUrl` reads `service_integrations.redirect_uri`
— `src/lib/strava.js:30-33`; master-editable via the admin Integrations screen,
`src/app/api/admin/integrations/[id]/route.js:32`).

- **Current values:** DB row (live, read 2026-08-18):
  `service_integrations.redirect_uri = https://app.champfitness.ie/api/oauth/strava/callback`
  (matches the admin UI placeholder, `src/components/IntegrationsAdmin.jsx:142`);
  Strava app callback domain: `app.champfitness.ie`.
- **New values:** callback domain `api.repset.ie`; DB row
  `https://api.repset.ie/api/oauth/strava/callback` (the member-app host —
  Stage 2 made api.repset.ie the champ-app canonical).
- **Order matters — app domain FIRST, then the DB row.** Strava holds only one
  callback domain, so the halves cannot overlap; flipping the domain first means
  the (brief) broken window fails at Strava's authorize screen with a clear
  redirect_uri error, rather than after the member has approved access. New
  connects fail during the window; **existing member connections keep working
  throughout** (token refresh doesn't use redirect_uri).
  1. strava.com/settings/api → "Authorization Callback Domain" →
     `api.repset.ie` → Save.
  2. Immediately flip the DB row:

  ```sql
  -- ⚠️ DO-NOT-RUN-YET — run only immediately AFTER the Strava app's
  -- Authorization Callback Domain has been changed to api.repset.ie.
  UPDATE service_integrations
     SET redirect_uri = 'https://api.repset.ie/api/oauth/strava/callback'
   WHERE provider = 'strava'
     AND redirect_uri = 'https://app.champfitness.ie/api/oauth/strava/callback';
  -- expect: UPDATE 1
  ```

- **Verification:** a member runs "Connect Strava" end-to-end from the app and
  lands back connected; `contact_external_integrations` gains/refreshes the row.

---

## 6. Zoom — **no action required**

The Zoom Phone contact sync uses **Server-to-Server OAuth**
(`account_credentials` grant — `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` /
`ZOOM_CLIENT_SECRET`, `src/lib/zoom/client.js:19-37`): the CRM calls Zoom
outbound; Zoom never calls us and no redirect URI exists on the Zoom app. The
QStash worker path (`/api/webhooks/qstash/zoom-contacts`, `src/lib/qstash.js:89`)
is invoked by **QStash**, whose destination URLs are covered by the QStash/env
surface, not a Zoom console. Nothing to re-register. (Integration currently
ships dark until `ZOOM_*` is set — `src/lib/settings-tree.js:290`.)

---

## 7. InBody / Lookin'Body — portal webhook URL

- **Current value:** the InBody/Lookin'Body portal (API-KEY setup, Step 3) POSTs
  scan-completed notifications to `https://crm.un1tdublin.com/api/webhooks/inbody`
  with the custom header `x-inbody-secret` matching `INBODY_WEBHOOK_SECRET`
  (`src/app/api/webhooks/inbody/route.js:1-13,35-38`;
  `docs/architecture/INTEGRATIONS.md:63`).
- **New value:** `https://crm.repset.ie/api/webhooks/inbody`
- **Steps:** InBody/Lookin'Body web portal → the API-KEY / webhook setup screen
  (same Step 3 page where the custom header was configured) → replace the URL →
  keep the `x-inbody-secret` header + value exactly as-is → run the portal's
  Step 4 test (the route deliberately 200s InBody's unmatched-phone test payload
  so the save can complete, `src/app/api/webhooks/inbody/route.js:11-13`).
- **Pi-side note (Stage 4, not here):** the Lookin'Body API key lives **on the
  gym Pi**, and any Pi-local base-URL / IP-allowlist configuration
  (champ-bridge `CHAMP_API_URL` etc.) is deliberately left to the **Stage 4
  fleet pass** — Pis are frozen (overlayroot) and changes there follow the
  `pi rw` / `pi ro` procedure, not this console runbook.
- **Verification:** portal test passes; next real scan at Stillorgan inserts a
  row in `inbody_webhook_events` (and enriches into `inbody_scans`).

---

## 8. Supabase — Auth Site URL (one dashboard field)

- **Current value:** dashboard-configured Site URL on project
  `iyvtbjjxdggiadzwwvdj` (legacy host).
- **New value (post-flip recommendation):** `https://crm.repset.ie`
- **What it actually controls — the caveat:** the Site URL is only the
  **fallback** for auth-email links. The CRM's own flows pass an explicit
  `redirectTo` built from `NEXT_PUBLIC_APP_URL` (staff password reset:
  `src/app/api/staff/[id]/send-password-reset/route.js:77-85`; staff invite
  falls back to "Supabase will use its dashboard-configured default Site URL"
  only when the env is unset: `src/app/api/staff/route.js:134-138`; member app
  invites use `CHAMP_APP_URL`:
  `src/app/api/contacts/[id]/invite-app/route.js:78-83`). So what falls back to
  the Site URL is: any auth email sent **without** a `redirectTo` (including
  anything triggered from the Supabase dashboard itself) and any `redirectTo`
  that is **not on the redirect allow-list**.
- **Steps:** Supabase Dashboard → project `iyvtbjjxdggiadzwwvdj` →
  **Authentication → URL Configuration**:
  1. **Site URL** → `https://crm.repset.ie`.
  2. **Additional Redirect URLs** → ensure BOTH generations are listed and stay
     listed while the legacy hosts serve: `https://crm.repset.ie/**`,
     `https://api.repset.ie/**`, `https://crm.un1tdublin.com/**`,
     `https://app.champfitness.ie/**`. (Removing the legacy entries would make
     legacy-host `redirectTo` values fall back to the Site URL — a silent
     cross-domain hop that breaks PKCE, which is browser+domain-bound; see the
     reset-password PKCE lesson.)
  3. **Do not touch signups** — Supabase signups stay OFF (load-bearing
     security invariant).
- **Verification:** trigger a staff password reset; the email link lands on
  `crm.repset.ie/reset-password` and completes. A legacy-host login/reset still
  works afterwards.

---

## 9. Postmark — *placeholder: see MCP inventory*

> Filled by the orchestrator from the Postmark MCP inventory (servers, message
> streams, and each server's webhook URLs — including the Supabase Edge shim
> indirection on the support-inbox inbound webhook, which must NOT be flattened
> to a direct Vercel URL; see `docs/architecture/INTEGRATIONS.md:17`).

## 10. Meta (WhatsApp + Instagram) — *placeholder: see MCP inventory*

> Filled by the orchestrator from the Meta asset map / MCP inventory (app
> webhook callback URLs for the `whatsapp_business_account` and `instagram`
> objects, verify tokens, Embedded Signup / Tech Provider surfaces, and the
> `/technical` page URL cited on the Access Verification form). Current
> registered callbacks are on the legacy host (`docs/whatsapp-setup.md`,
> `docs/instagram-setup.md:24`).

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
