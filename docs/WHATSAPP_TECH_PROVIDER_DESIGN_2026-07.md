# WhatsApp Tech Provider Onboarding — Design (2026-07-16)

**Status:** Approved design, pre-implementation.
**Decision owner:** Richard (2026-07-16 session).
**Context:** Meta has approved UN1T to start the Tech Provider testing/configuring
phase. Goal chosen: **"both, SaaS later"** — re-onboard UN1T's own numbers through
the Tech Provider flow first, with the architecture built so external businesses
can be onboarded later. The Tech Provider track runs on the **existing live Meta
app** (the one powering Mia, broadcasts, and the `/api/webhooks/whatsapp` webhook).

---

## 1. Goal

The existing Meta app becomes a Tech Provider app. The CRM gains a self-serve
**"Connect WhatsApp"** flow (Embedded Signup v4) that onboards a WABA + phone
number end-to-end: Meta dialog → code exchange → business token stored → app
subscribed to the WABA → number live in the existing send/receive machinery.

- **Phase 1 (standard access):** onboard businesses UN1T admins — i.e. UN1T's own
  portfolio (Hatch / a test number becomes client #1). This is exactly what
  Meta's "testing and configuring" phase permits.
- **Phase 2 (advanced access):** App Review unlocks `whatsapp_business_messaging`
  + `whatsapp_business_management` advanced access so external businesses can
  onboard. Access Verification afterwards lifts the onboarding cap (10 → 200
  clients/week) — not urgent.

**Non-negotiable constraint:** the live Stillorgan integration is untouched.
The live Stillorgan number's `whatsapp_numbers` row and the env-var fallback
path (`WHATSAPP_ACCESS_TOKEN` in `src/lib/whatsapp-config.js`) are both
untouched by this work; its routing behaviour is unchanged in every path
(verified in final review).

## 2. Persistence decision (approved)

**Option A — extend `whatsapp_numbers` (mig 176).** Embedded Signup is simply a
new way to create a `whatsapp_numbers` row. Clients become organizations/
locations in the CRM (they are CRM tenants in the SaaS vision anyway), so the
existing per-location model fits. The alternative (a dedicated
`waba_connections` table, storing the business token once per client business)
was rejected for now as YAGNI; graduate to it via a later migration only when a
client with multiple numbers on one WABA actually exists.

## 3. Track 1 — Meta console (ops)

Business verification is already done (prerequisite ✓, per
`docs/whatsapp-setup.md`). Sequence:

1. **App preflight** — Settings → Basic: privacy policy URL, app icon, category,
   business portfolio connected. App Review blocks without these.
2. **Embedded Signup v4 configuration** — create a Facebook Login for Business
   configuration on the app → yields the `config_id`; whitelist
   `crm.un1tdublin.com` in JS SDK allowed domains. Build against **ES v4 only**
   (v2 is deprecated 2026-10-15).
3. **In-house E2E test** under standard access (see §7).
4. **App Review submission** — advanced access to `whatsapp_business_messaging`
   and `whatsapp_business_management`. Requires two screencasts (a message send
   reaching a WhatsApp client, and template creation) — primary source is our
   own E2E test (§7); Meta also accepts API Setup cURL / WhatsApp Manager
   recordings as a fallback — plus written justifications (drafted as part of
   this work).
5. **Access Verification** — after review passes. Raises onboarding limits;
   deferred until external clients are real.

Deliverable for this track: a click-by-click runbook appended to
`docs/whatsapp-setup.md` (or a sibling doc), produced while actually performing
the steps. Console steps are account-settings changes → each state-changing
step is confirmed with Richard before it is taken, whether driven by Claude
via browser or performed by Richard from the runbook.

App Review does **not** disturb the live integration: own-asset access via the
System User token continues on standard access throughout.

## 4. Track 2 — CRM implementation

### 4.1 Frontend

`src/components/settings/integrations/WhatsAppIntegrationTab.jsx` gains a
**"Connect with WhatsApp"** button (location context comes from the settings
page it lives in):

- Loads the Facebook JS SDK on demand (not globally).
- Launches Embedded Signup v4 via `FB.login` with `config_id`
  (`WHATSAPP_ES_CONFIG_ID` exposed through a server-provided config, not
  hard-coded), `response_type: 'code'`, `override_default_response_type: true`.
- Listens for the `WA_EMBEDDED_SIGNUP` session-info message event to capture
  `waba_id` + `phone_number_id`; captures the response `code` from the login
  callback. Exact `extras`/session-info-version fields are confirmed against
  Meta's current ES v4 docs at implementation time (they drift; the behaviour
  contract here is fixed).
- POSTs `{ code, waba_id, phone_number_id }` to the exchange endpoint below
  (location travels in the route path); renders success (row appears in the
  existing numbers list) or the surfaced error.
- Abandoned dialog (no code) = no-op, no partial state.

### 4.2 API — `POST /api/locations/[id]/whatsapp/embedded-signup`

Standard mutation-route skeleton (`getCurrentUser()` → `assertLocationAccess`
→ master-or-owner gate, matching the numbers CRUD route → `validateBody`
(Zod) → `createServerClient()`), registered in `src/lib/openapi.js` (Task 6).
Server-side steps, in order:

1. **Exchange** `code` → **business token**: `GET {graph}/oauth/access_token`
   with `client_id` (`WHATSAPP_APP_ID`), `client_secret` (`WHATSAPP_APP_SECRET`),
   `code`. Failure → 502 with Meta's error message; nothing persisted.
2. **Subscribe app to the client WABA**: `POST /{waba_id}/subscribed_apps` with
   the business token. This is what routes the client's webhooks to our
   existing `/api/webhooks/whatsapp` endpoint.
3. **Register the number** (`POST /{phone_number_id}/register` with a generated
   6-digit two-step PIN) — only if not already registered (probe
   `GET /{phone_number_id}` and inspect `status`/`platform_type` first; a
   number already on Cloud API, like re-onboarded own numbers, skips this).
   Registration failures (e.g. 133016 register-rate-limit: 10 per number per
   72h) surface Meta's message verbatim.
4. **Persist** to `whatsapp_numbers` keyed on the unique `phone_number_id`:
   - New number → insert row: `access_token` = business token,
     `token_type='business'`, `connected_via='embedded_signup'`,
     `signup_meta` = `{ waba_id, pin, connected_by, connected_at, probe:
     { status, platform_type } }`, `source='cloud_api'`, `is_active=true`,
     `is_default=true` only if the location has no default.
   - Existing row, **same location** → refresh token/`signup_meta`/flags
     (re-connect flow), never a duplicate.
   - Existing row, **different location** → 409; surfaced, never silently
     reassigned.

Steps 2–3 failing after step 1 must not strand state: nothing is written until
step 4, and the endpoint is safe to re-run with a fresh code.

### 4.3 Migration (forward-only, via Supabase MCP → un1t-crm project)

Add to `whatsapp_numbers`:

| column | type | default | purpose |
|---|---|---|---|
| `token_type` | TEXT CHECK (`system_user` \| `business`) | `system_user` | existing rows keep meaning |
| `connected_via` | TEXT CHECK (`manual` \| `embedded_signup`) | `manual` | provenance |
| `signup_meta` | JSONB | `NULL` | `{ waba_id, pin, connected_by, connected_at, probe: { status, platform_type } }` |

No changes to existing rows. `get_advisors` (security) after DDL, per invariant.

### 4.4 Env

One new var: `WHATSAPP_ES_CONFIG_ID`. Follows the no-silent-fallback rule — the
connect button renders a "not configured" state if unset; the exchange route
throws.

### 4.5 Webhook hardening (load-bearing)

`src/app/api/webhooks/whatsapp/route.js` currently **falls back to
first-location** when an inbound `phone_number_id` isn't recognised. Acceptable
single-tenant; in a multi-tenant Tech Provider setup it is a cross-tenant data
leak (a client's customer messages landing in UN1T's inbox). Tighten to:

- `phone_number_id` matches a `whatsapp_numbers` row → that row's location
  (existing behaviour).
- Matches the env-config number → env config (existing behaviour).
- Otherwise → log a warning and drop the event, still returning 200 (Meta
  auto-disables webhooks on non-2xx, per invariant).

This lands **before** the first real client onboards; regression-tested (§7).

### 4.6 Permissions / parity

No new permission key expected — the flow lives inside the existing
settings-integrations surface and inherits its guard. If implementation does
add a key, it gets a `WEB_ONLY_OK` entry (reason: ES requires the Facebook JS
SDK in a browser; no mobile counterpart).

## 5. Data flow

Connect click → Meta dialog (client creates/selects WABA + number, accepts
Meta's terms **themselves** — their WABA, their payment method, they pay Meta
directly) → `code` + session-info back to our page → server exchange →
business token stored → app subscribed to their WABA → outbound rides the
existing `getWhatsAppConfig` tiers; inbound rides
`resolveWhatsAppNumberByPhoneNumberId`. **No new routing machinery.**

## 6. Error handling summary

| Failure | Behaviour |
|---|---|
| Dialog abandoned | No-op; nothing sent to server |
| Code exchange fails | 502 + Meta error; nothing persisted |
| `subscribed_apps` / register fails | Error surfaced with Meta message; nothing persisted; endpoint re-runnable with a fresh code |
| `phone_number_id` owned by another location | 409, surfaced, no reassignment |
| Token revoked later | Caught by existing number-health webhooks/polling (`whatsapp-number-events.js`, `whatsapp-number-health.js`) |
| Unknown `phone_number_id` on webhook | Log + drop + 200 (post-hardening) |

## 7. Testing

- **Vitest** (pure-lib, mocked Graph API): exchange-endpoint happy path, each
  failure row in §6, upsert/409 semantics, webhook-fallback tightening
  regression (unknown id no longer lands in first location).
- **Manual E2E** (dev, standard access): onboard a test/second UN1T number
  through the real dialog → send + receive → confirm inbox routing to the
  right location → confirm Stillorgan env path unaffected.
- The **App Review screencasts** are recorded from this E2E — testing and
  review prep are one motion.
- CI mirror + `npm run build` before pushing (tests are mocked; only the build
  catches import-resolution failures), per repo invariants.

## 8. Risks & mitigations

- **Live-app blast radius:** all changes are additive (new ES config on the
  app, new columns with defaults, new route). The live Stillorgan number's
  row and the env fallback path are both untouched by this work; its
  routing behaviour is unchanged in every path (verified in final review).
- **ES v2 deprecation 2026-10-15:** build v4 from the start; nothing to
  migrate later.
- **Temp-token trap (historical):** business tokens from ES are long-lived and
  are NOT the API-Setup 24h temporary tokens that killed agent sends before —
  but health polling still covers revocation.
- **Register rate limit** (10/number/72h, err 133016): probe before register;
  surface verbatim.
- **BSUID/usernames rollout** (see memory `meta-wa-feature-audit-2026-07`):
  orthogonal to this work; no phone-keying changes here.

## 9. Out of scope

- Client-side billing/payment methods (clients add their own to their WABA —
  Meta requirement, their relationship).
- `waba_connections` graduation (only when multi-number-per-client is real).
- Access Verification (post-App-Review, pre-external-clients).
- SaaS packaging/pricing of the CRM itself.
- Coexistence-source onboarding via ES (WhatsApp Business **app** users);
  Cloud API numbers only in v1.
