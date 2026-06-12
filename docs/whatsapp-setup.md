# WhatsApp Cloud API — Setup Runbook

Configures the Meta WhatsApp integration for un1t-crm. The platform code is already
complete: webhook handler at `src/app/api/webhooks/whatsapp/route.js`, sending via
Graph API v21.0 (`src/lib/whatsapp.js`), template management against
`{WABA_ID}/message_templates`, and per-location number config
(`whatsapp_numbers` table, mig 176) with global env-var fallback
(`src/lib/whatsapp-config.js`).

This runbook covers everything outside the codebase: Meta portal tasks, Vercel
env vars, and verification.

---

## 0. Approach

The business number is currently on the **WhatsApp Business app**. This runbook
performs a **full migration**: the number is deleted from the app and registered
on the Cloud API. All sending/receiving moves to the CRM inbox; the phone app is
no longer used for this number. Use `source = cloud_api` on the
`whatsapp_numbers` row.

## 0.5 Test BEFORE migrating (recommended — zero downtime)

Adding the WhatsApp product to your Meta app (step 1.1) auto-creates a **test
WABA + test phone number** with pre-approved templates and free sends to up to
5 verified recipient numbers. Use it to validate the whole platform pipeline
*before* touching the real number:

1. Complete 1.1–1.2, then in **WhatsApp → API Setup** add your personal number
   as a recipient (it gets a WhatsApp confirmation code).
2. Set the Vercel env vars (section 2.1) using the **test number's**
   Phone Number ID + test WABA ID (a temporary 24h token is fine for this).
3. Configure the webhook (1.7) — webhook setup does **not** affect the number
   still on the WhatsApp Business app (confirmed in Meta docs).
4. Send the `hello_world` template from API Setup; reply to it from your phone.
   Confirm: inbound lands in the CRM inbox, statuses update, no signature
   warnings in Vercel logs.
5. Only then do 1.3 (delete the app account) and swap the env vars / DB row to
   the real number's IDs. The real number's downtime is minutes, not hours.

---

## 1. Meta portal tasks

Prerequisite: Meta Business Manager is **verified** (done ✓).

### 1.1 Create the Meta app
1. https://developers.facebook.com → **Create App** → type **Business**.
2. Link it to the verified UN1T Business Manager.
3. Add the **WhatsApp** product to the app.

### 1.2 Record App ID + App Secret
App Dashboard → **Settings → Basic**:
- **App ID** → `WHATSAPP_APP_ID` (needed for the Resumable Upload API — image/video/document template headers)
- **App Secret** → `WHATSAPP_APP_SECRET` (webhook HMAC verification — the webhook **fails closed** without it)

### 1.3 Free the phone number
1. ⚠️ **Two-step verification PIN — do this FIRST.** If 2FA is enabled in the
   WhatsApp Business app, the PIN survives account deletion and Cloud API
   registration will demand it. Either note the PIN, or disable it before
   deleting: app → **Settings → Account → Two-step verification → Turn off**.
   (If you get stuck post-deletion: WhatsApp Manager → Phone numbers → gear →
   Two-step verification → Turn off, sent via email link.)
2. Export any chat history you want — it is NOT migrated to the API.
3. WhatsApp Business app → **Settings → Account → Delete account**.
4. Wait ~5 minutes before registering. (Meta docs: numbers in use on the
   WhatsApp Messenger/Business apps cannot be registered until deleted.)

### 1.4 Register the number
Eligibility (per Meta docs): you own the number, it has a country + area code
(no short codes), and it can receive the verification **SMS or voice call**.
The number can still be used for normal calls/SMS after registration.

1. App Dashboard → **WhatsApp → API Setup** → **Add phone number**.
2. Verify ownership via SMS or voice code.
3. Set a new **two-step verification PIN** when prompted (Cloud API requires
   one at registration) — store it in your password manager.
4. Record from this page:
   - **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID (WABA ID)** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
4. Set the **display name** (e.g. "UN1T Dublin") — Meta reviews it; usually fast for verified businesses.

### 1.5 Create a System User + permanent token
The platform expects a **permanent system-user token**, not the 24-hour temp token
shown on the API Setup page.

1. https://business.facebook.com → **Settings → Users → System users** → **Add**.
   - Name: `un1t-crm-api`, role: **Admin**.
2. **Assign assets** to the system user:
   - The Meta app — full control.
   - The WABA — full control.
3. **Generate token**:
   - App: select the app from 1.1
   - Expiry: **Never**
   - Permissions (Meta docs specify three — search "business" in the picker):
     `whatsapp_business_messaging`, `whatsapp_business_management`,
     `business_management`
4. Copy the token once → `WHATSAPP_ACCESS_TOKEN`. Store it only in Vercel env /
   the `whatsapp_numbers` row — never in the repo.

### 1.6 Add a payment method
WhatsApp Manager → the WABA → **Payment settings** → add card.
Without it, sending is capped at test volumes. Template/marketing messages bill per message.

### 1.7 Configure the webhook — AFTER section 2 is deployed
Meta pings the live endpoint during verification, so env vars must be deployed first.
Notes from Meta docs: one callback endpoint per Meta app; endpoint must have a
valid TLS cert (Vercel ✓); configuring webhooks does not affect a number still
on the WhatsApp Business app.

1. App Dashboard → **WhatsApp → Configuration → Edit** callback URL:
   - **Callback URL:** `https://<production-domain>/api/webhooks/whatsapp`
   - **Verify token:** the exact `WHATSAPP_WEBHOOK_VERIFY_TOKEN` value
2. Click **Verify and Save**.
3. **Subscribe to the `messages` webhook field** — this single field carries both
   inbound messages and status updates (sent/delivered/read/failed); the handler
   processes both.

### 1.8 Switch the app to Live mode
Toggle at the top of the App Dashboard. Production webhooks only flow in Live mode.

### 1.9 Messaging limits (awareness)
New numbers start at **250 business-initiated conversations / 24h**. With the
business verified ✓ and the display name approved, the limit moves to 1,000 and
then auto-scales with volume + quality rating. Inbound replies (customer-service
window) are unlimited. Monitor in WhatsApp Manager → Phone numbers → Insights.

---

## 2. Platform configuration

### 2.1 Vercel env vars
Project → Settings → Environment Variables (Production), then **redeploy**:

```bash
WHATSAPP_ACCESS_TOKEN=         # 1.5 — permanent system-user token
WHATSAPP_PHONE_NUMBER_ID=      # 1.4
WHATSAPP_BUSINESS_ACCOUNT_ID=  # 1.4 — WABA ID
WHATSAPP_APP_ID=               # 1.2
WHATSAPP_APP_SECRET=           # 1.2
WHATSAPP_WEBHOOK_VERIFY_TOKEN= # generated below
```

Generated verify token for this setup (rotate if this doc leaks):

```
f5d67430518fe37681d7e7aa64b2f95e74a0cfc9b265adb656897cd29f192ff9
```

To regenerate: `openssl rand -hex 32`

### 2.2 Per-location config (preferred — WA-MULTI)
CRM → **Settings → Locations → [location] → Integrations → WhatsApp → Add number**:

| Field | Value |
|-------|-------|
| Label | e.g. `Stillorgan main` |
| Phone Number ID | from 1.4 |
| WABA ID | from 1.4 |
| App ID | from 1.2 |
| Access token | from 1.5 |
| Source | `cloud_api` |
| Default | ✓ |

Notes:
- Locations with zero rows fall back to the global `WHATSAPP_*` env vars.
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` are **env-only**
  (webhook-level, not per-number) — set them in Vercel regardless.
- Inbound routing: the webhook maps Meta's `phone_number_id` → owning location
  via the `whatsapp_numbers` unique index.

### 2.3 Now complete Meta step 1.7 (webhook verification).

### 2.4 Templates
- Create/submit via the platform template manager (posts to `{WABA_ID}/message_templates`)
  or directly in WhatsApp Manager.
- Approval: minutes to ~24h.
- Required for any outbound **outside the 24-hour customer-service window** —
  broadcasts and drip sequences depend on approved templates.
- GDPR (Irish jurisdiction): marketing templates must include an opt-out line.

---

## 3. Verification checklist

1. **Inbound:** WhatsApp the business number from a personal phone → message appears
   in the CRM inbox. Confirms webhook URL, verify token, and HMAC signature check.
2. **Outbound free-form:** reply from the inbox → confirms token + phone number ID
   (works because step 1 opened the 24h window).
3. **Template send:** test broadcast with an approved template → confirms template
   path; delivered/read ticks should update broadcast metrics via status webhooks.
4. **Failure check:** `vercel logs` (or Vercel dashboard) — no
   `[security] WHATSAPP_APP_SECRET is not set` or signature-rejection warnings.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Registration asks for a PIN you don't know | Old 2FA PIN from the WhatsApp Business app — reset via WhatsApp Manager → Phone numbers → gear → Two-step verification (email link) |
| "Number cannot be registered" | Account not yet deleted from the app, or deletion still propagating — wait and retry |
| Webhook verification fails in Meta dashboard | Verify token mismatch, or deploy without `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |
| Inbound returns 403 | `WHATSAPP_APP_SECRET` doesn't match the app, or wrong app's webhook pointed here |
| Inbound returns 500 | `WHATSAPP_APP_SECRET` unset (handler fails closed; Meta retries ~24h — just set the var) |
| Sends fail with auth error | Token missing permissions or system user lacks WABA asset assignment |
| Template submit fails for media headers | `WHATSAPP_APP_ID` / `app_id` not set (Resumable Upload API needs it) |
| Messages land in wrong location's inbox | `phone_number_id` not registered in `whatsapp_numbers` → falls back to first location |
