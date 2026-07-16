# WhatsApp Coexistence — Design (2026-07-16)

**Status:** Approved design, pre-implementation.
**Decision owner:** Richard (2026-07-16 session).
**Builds on:** the WhatsApp Tech Provider / Embedded Signup work shipped this
session (PR #921) — the ES `config_id`, FB JS SDK loader, exchange route,
webhook idempotency, and `whatsapp_numbers.source='coexistence'` enum already
exist. This design is the *delta* to support coexistence, not a from-scratch
build. Prior planning: `~/code/whatsapp-coexistence-{build-plan,integration-findings,phase0-steps}.md`
(June 2026 — largely superseded by the shipped ES infra; see reconciliation below).

---

## 1. Goal

Let a client who already runs their number on the **WhatsApp Business app** link
that number to the Cloud API (**coexistence**) through the Connect flow — the
number stays live on their phone while the CRM sends/receives on it and mirrors
phone-side activity into the inbox. All CRM code is built and fixture-tested
now; it goes live the day App Review is approved and three extra webhook fields
are subscribed.

**Coexistence vs the Cloud API onboarding we already ship:** same two
permissions (`whatsapp_business_messaging` + `whatsapp_business_management`), same
`config_id`. The difference is a launch-time flag
(`featureType='whatsapp_business_app_onboarding'`), the number is NOT registered
(it's already live on the app), and three extra webhook fields carry phone-side
state. Per Meta's current docs (verified 2026-07-16) coexistence needs **no
separate App Review or Tech-Provider enablement** — the gate is Meta's per-number
eligibility check on the *client's* Business-app account (tenure + quality),
which is out of our hands.

## 2. Build order (4 PRs, all shippable + testable now)

- **CX.1 — Exchange branch** (backend core): coexistence path through the
  existing exchange route. Minimum for the number to send/receive.
- **CX.2 — Webhook handlers**: `smb_message_echoes`, `smb_app_state_sync`,
  `history` ingestion. Inbox correctness.
- **CX.3 — Frontend**: the coexistence launch mode (second Connect button).
- **CX.4 — History sync + status**: history-sync state machine, progress badge,
  the 24h-window handling, coexistence status/notes in settings.

CX.1–CX.4 are pure CRM code with no live Meta dependency — fully unit-tested
against fixtures/mocks before approval. Only the final live E2E (onboard a real
eligible number) waits on Meta.

## 3. Frontend (CX.3)

`src/components/settings/integrations/WhatsAppIntegrationTab.jsx` gains a second,
clearly-labelled button beside the existing Cloud API "Connect":
**"Connect existing WhatsApp Business number"**. The mode is fixed at launch, so
two distinct buttons rather than a post-hoc toggle.

- Reuses the existing `loadFacebookSdk` + launch-config fetch (`configured`,
  `app_id`, `config_id`) from the Cloud API card.
- Launches with `FB.login(cb, { config_id, response_type: 'code',
  override_default_response_type: true, extras: { setup: {},
  featureType: 'whatsapp_business_app_onboarding' } })`.
  (Confirm the exact `extras`/`sessionInfoVersion` shape against Meta's current
  ES docs at implementation time — the behaviour contract here is fixed; the
  field spelling drifts.)
- The `message` listener (origin-validated, same hardened check as the Cloud API
  card) captures the coexistence session-info event
  (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) → `waba_id` (and
  `phone_number_id` if Meta includes it; the exchange route resolves it
  server-side regardless).
- POSTs `{ mode: 'coexistence', code, waba_id, phone_number_id? }` to the
  exchange route. Abandoned dialog = no-op. Success → silent list refresh (same
  pattern as the Cloud API card), shows a "Coexistence — importing history…"
  state.

## 4. Exchange route (CX.1)

Extend the existing `POST /api/locations/[id]/whatsapp/embedded-signup` with an
optional `mode: 'cloud_api' | 'coexistence'` field (default `'cloud_api'` — the
Zod schema adds the enum; existing callers unaffected). Reuses the master-or-owner
gate, `validateBody`, `assertLocationAccess`, the persistence planner, and
`publicShape`. Branch on mode:

**Shared (both modes):**
1. Exchange `code` → business token (`exchangeCodeForBusinessToken`).
2. Ownership/409 conflict check by `phone_number_id` (before any Meta mutation).
3. `subscribeAppToWaba`.

**Coexistence-only:**
4. Resolve `phone_number_id` + `display_phone_number` from
   `GET /{waba_id}/phone_numbers` (a new `getWabaPhoneNumber` helper in
   `whatsapp-embedded-signup.js`). Do NOT probe/`/register` — a coexistence
   number is already registered, and firing `/register` would be wrong.
5. Persist with `source='coexistence'`, `token_type='business'`,
   `connected_via='embedded_signup'`, and `signup_meta` stamped with
   `{ coexistence: true, history_sync: { status: 'pending', started_at } }` —
   which starts the 24h history-import clock (CX.4).

**Cloud API-only:** unchanged (probe → conditional `/register` → persist
`source='cloud_api'`).

New pure lib functions (tested, no route): `getWabaPhoneNumber({ wabaId, token })`.

## 5. Webhook handlers (CX.2)

Extend `src/app/api/webhooks/whatsapp/route.js`, adding cases before the current
`if (change.field !== 'messages') continue` skip. Every handler uses the existing
`recordWebhookEvent` idempotency and returns 200 (unhandled/failed events never
non-2xx — Meta auto-disables hooks otherwise). Pure decision/parse logic is
extracted to a testable `whatsapp-coexistence.js` lib; the route stays thin.

- **`smb_message_echoes`** (most load-bearing) — messages the operator sends
  *from the phone app* after linking. Insert as **`direction='outbound'`** rows,
  **deduped by `wa_message_id`** so a message we sent via Cloud API (whose
  returned `wa_message_id` we already store) is never double-inserted. Thread to
  the contact via the existing phone-matcher. Without this, phone-side replies
  are invisible in the CRM inbox and it desyncs from what the customer sees.

- **`smb_app_state_sync`** (contact sync — Richard's rule) — for each synced
  contact, **match against existing `contacts` by phone only** (reuse the
  webhook's `wa_phone`/`phone` `.or()` matcher). If matched: ensure the
  `wa_phone` linkage is set and **leave marketing preferences untouched**
  (inherit the existing contact's consent state). **If not matched: ignore it —
  never create a new contact.** No phone-book personal data enters the DB; no
  consent basis needed because we only enrich people already lawfully in the CRM.

- **`history`** — backfill up to ~6 months of prior 1:1 chats into
  `whatsapp_conversations`/`whatsapp_messages`, deduped by `wa_message_id`
  against echoes and go-forward messages. Correct `direction` per payload.
  Threads to existing contacts and creates conversation rows as needed, but
  follows the same **match-only** rule for contact identity (a history message
  from an unknown number creates the conversation/message but does not create a
  marketing-eligible contact). Consumed by CX.4's sync state machine.

## 6. Data

**No migration for the basics.** `source='coexistence'` exists (mig 176);
onboarding + history-sync status live in `signup_meta` JSONB (mig 405).
Echoes/history reuse `whatsapp_messages.direction` + the `wa_message_id` unique
index for dedup. If a "sent from phone" marker proves useful for inbox
rendering, that's a small additive column decided during CX.2 when the inbox
render is in view — not assumed up front.

## 7. External (Meta console — Richard, one step)

App Dashboard → WhatsApp → Configuration → subscribe the WABA to **`history`**,
**`smb_app_state_sync`**, **`smb_message_echoes`** (in addition to `messages`).
Harmless to do anytime — unhandled fields are ignored until CX.2 ships. Added to
`docs/whatsapp-setup.md` §4.

## 8. Data flow

Coexistence Connect click → Meta dialog (client confirms via a pairing code sent
to their Business app) → `code` + `waba_id` back → server exchange (skip
register, read phone_number_id, store `source='coexistence'`) → number live.
Inbound customer messages ride the existing `messages` webhook. Phone-side
operator sends ride `smb_message_echoes` → outbound rows. Past chats ride
`history` → backfill. Contacts ride `smb_app_state_sync` → match-existing-only.

## 9. Error handling

- Exchange failures (code/subscribe/phone-number-read): 502 with Meta's message;
  nothing persisted (same "nothing before all Meta calls succeed" property as the
  Cloud API path).
- Webhook handler errors: caught per-event, logged, 200 returned (idempotent
  replay-safe).
- History window missed (>24h, or link never completed): number still works
  go-forward; `history_sync.status='expired'` surfaced in the UI; no retry (the
  window is one-shot per Meta).
- Token revocation later: caught by existing number-health polling.

## 10. Testing

- **Pure-lib (vitest, mocked):** `getWabaPhoneNumber`; the coexistence
  exchange-branch decision (asserts `/register` never called, row stores
  `source='coexistence'`, history-sync stamped); each webhook parser with a
  fixture — echo → outbound + dedup; sync → updates a matched contact, creates
  NOTHING when unmatched, never mutates marketing prefs; history → threaded +
  deduped.
- **Manual E2E (post-approval):** onboard a real eligible Business-app number,
  send/receive both ways, reply from the phone and confirm it mirrors, confirm
  history backfilled, confirm an unknown phone-book contact was NOT imported.

## 11. Constraints surfaced in the UI

- Coexistence numbers are capped at **5 messages/second** — noted in settings;
  broadcast/drip pacing on these numbers is a follow-up (affects speed, not
  correctness).
- Meta **hides the display name** on coexistence numbers unless Meta-Verified —
  a note in the settings card so operators aren't surprised.

## 12. Out of scope (v1)

- Offboarding / reconnect flow (Meta supports it; polish, later).
- Automated business-token refresh/expiry handling (polish; health polling
  covers detection meanwhile).
- Broadcast pacing changes for the 5 msg/sec cap.
- Marketing Messages Lite API (EU-gated; N/A).
- Auto-importing unmatched phone-book contacts (explicitly rejected — see §5).

## 13. Reconciliation with the June plan

The June `whatsapp-coexistence-build-plan.md` assumed Phases 0–2 were unbuilt.
As of this session: Tech Provider + `config_id` + FB SDK + exchange route +
webhook idempotency + `source` enum + env vars are all **done**. So June Phase 1
(launch) collapses into CX.3, June Phase 2 (exchange) into CX.1 (a branch, not a
new route), June Phase 3 into CX.2, June Phase 4 into CX.4. June's "build the
webhook handlers first, they have no Meta dependency" insight still holds — CX.2
is the most independently-testable piece.
