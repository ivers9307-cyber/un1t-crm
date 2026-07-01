# WhatsApp Flow — "Book your first visit" (in-chat booking capture)

- **Date:** 2026-07-01
- **Status:** Design — approved in brainstorm, pending spec review → implementation plan
- **Location scope:** Stillorgan only (behind the automations-hub toggle, OFF by default)
- **Related:** [meta-paid-ads-program], `/free-class` + `/start` funnels, `class_booking_requests`, `process-class-bookings` cron, Mia agent

## 1. Context & goal

Today the paid-ads funnel captures a booking on a **web landing page** (`/free-class`, `/start`),
creates a `class_booking_requests` row, sends the `meta_ad_whatsapp_lead` welcome template
(quick-reply buttons), and Mia converses to finish. The `process-class-bookings` cron books
the class in Glofox and sends `booking_class_confirmed`.

**Goal:** make a **WhatsApp Flow** the *primary* booking-capture surface — a multi-screen form
**inside** the chat that pulls **live** class/consult slots and books an exact slot in one go.
The web landing pages are retained only as a fallback for organic/direct traffic. The entire
downstream booking path (`class_booking_requests` → `processClassBookingRequest` → Glofox →
confirmation template) is **reused unchanged**; the Flow is a new capture front-end.

### Decisions locked in brainstorm
- **Scope:** one combined "Book your first visit" Flow (branches internally to consult vs class). *(Option A.)*
- **Type:** dynamic Flow with a **data-exchange endpoint** (live slots), not a static Flow. *(Option A.)*
- **Funnel role:** Flow everywhere as primary capture; web LP = fallback.
- **Goal screen removed** — start straight at the consult-vs-class choice.
- **Marketing-consent opt-in ticked by default** — to match the `/start` web funnel. See §9 for the GDPR caveat (legal-review item, not a blocker).

## 2. Architecture (5 pieces)

| Piece | Responsibility | New / Reuse |
|---|---|---|
| **Flow asset** | Multi-screen form (Flow JSON), published against the WABA, Meta-hosted | New (asset + publish step) |
| **Data-exchange endpoint** | `POST /api/whatsapp/flow` — answers `ping`, serves screen data on `INIT`/`data_exchange`/`BACK` | New |
| **Encryption** | RSA-2048 keypair; public key registered on the phone number; private key in secret | New |
| **Initiating message** | Template with a `FLOW` button (cold/first-touch) + in-session `interactive:flow` send | New (`whatsapp.js` + `createTemplate`) |
| **Completion handler** | Parses the `nfm_reply` webhook → writes `class_booking_requests` (class) / consult booking | Extends webhook |

## 3. Screens (Goal removed)

1. **Path** — "How would you like to start?" → *Free class* / *Consultation* (RadioButtonsGroup).
2. **Day** — days-with-availability for the chosen path (`data_exchange` → `computeAvailableDays`).
3. **Slot** — bookable times for that day. **Consults:** slots from the **"Free UN1T Consultation"**
   event type (resolved by slug via the existing `bookings/[slug]` availability engine —
   `computeAvailableSlots` over `event_types` + `bookings` + `blocked_times`). **Classes:** the Glofox
   class schedule (`api/public/classes`) with remaining capacity. Empty day → "none left, pick another day."
4. **Details** — name + email, **pre-filled from the contact on `INIT`**; marketing-consent OptIn
   **ticked by default**. **No goal/injury intake at v1** — the member is coming on-site, so goals and
   injuries are captured by the coach on the day.
5. **Confirm** — review chosen slot → completes the Flow → emits the response payload.

State between screens is carried in the Flow's `data` and echoed to the endpoint on each
`data_exchange`; no server session store is required.

## 4. Data flow

```
Click-to-WhatsApp ad opens chat  ─┐
(or cold lead → initiating         ├─▶ user taps the Flow button
 template with FLOW button)       ─┘
        │
        ▼
INIT  ──▶ /api/whatsapp/flow (decrypt) ──▶ prefill contact fields ──▶ Screen "Path"
        │
   each "next" ──▶ endpoint serves live days/slots from booking-slots.js / Glofox
        │
        ▼
Confirm ──▶ Meta sends messages webhook (interactive.type = nfm_reply)
        │
        ▼
handleFlowCompletion ──▶ insert class_booking_requests row (+ recordMarketingConsent source='whatsapp_flow')
        │
        ▼
process-class-bookings cron ──▶ processClassBookingRequest ──▶ Glofox booking ──▶ booking_class_confirmed template
```

**Mia remains the fallback** for anything off the happy path (abandoned Flow, slot taken,
edge questions). The Flow owns the structured ~80%; Mia owns the long tail.

## 5. Modules (small, isolated, testable)

New directory `src/lib/whatsapp-flow/`:

- **`crypto.js`** — implements Meta's Flow endpoint crypto: RSA-OAEP-256 unwrap of the AES key,
  AES-128-GCM decrypt of the request, and encrypt of the response (IV flipped per spec).
  Pure functions over `(privateKey, encryptedBody) → clearRequest` and `(aesKey, iv, clearResponse) → encryptedBase64`.
- **`screens.js`** — the Flow JSON definition **and** a **pure** screen state machine:
  `next({ screen, action, data }) → { screen, data }`. No I/O — fully unit-testable.
- **`handler.js`** — business logic the state machine calls out to: for consults, resolve the
  **"Free UN1T Consultation"** event type by its slug (a per-location setting, not hardcoded) and
  delegate to `booking-slots.js`; for classes, query the Glofox class schedule; plus prefill the
  contact and build the completion record.
- **`api/whatsapp/flow/route.js`** — thin transport: verify + decrypt (via `crypto.js`), handle
  `ping` health check, dispatch to `screens.js`/`handler.js`, encrypt + return. Returns **421** on
  decrypt failure (triggers Meta public-key re-fetch).

Additions elsewhere:
- **`whatsapp.js`** — `buildFlowPayload(to, { flowId, flowToken, flowCta, screen, data })` +
  `sendFlowMessage(...)` for the in-session `interactive:flow` message; extend `createTemplate`
  component handling to allow a `FLOW`-type button.
- **`webhooks/whatsapp/route.js`** — in the existing `case 'interactive'`, detect
  `message.interactive?.type === 'nfm_reply'` and dispatch to `handleFlowCompletion` instead of
  treating it as a button title.

**Reused unchanged:** `booking-slots.js`, `class_booking_requests` + `process-class-bookings` +
`processClassBookingRequest`, `marketing-consent.js` (`source: 'whatsapp_flow'`),
`getOrCreateConversation`, webhook HMAC verification, `booking_class_confirmed` /
consult-confirm templates.

## 6. Encryption & registration (one-time setup)

- Generate an RSA-2048 keypair. Store the **private** key as `WHATSAPP_FLOW_PRIVATE_KEY` (secret).
- Register the **public** key: `POST /{phone_number_id}/whatsapp_business_encryption`.
- Per request, Meta sends `encrypted_aes_key` (RSA-OAEP), `encrypted_flow_data` + `initial_vector`
  (AES-128-GCM). Decrypt → business logic → encrypt response with the same AES key and the
  **bit-flipped** IV. This is the standard Meta Flows endpoint protocol — `crypto.js` owns it.

## 7. Initiating the Flow

- **Cold / first-touch (outside 24h window):** a template with a `FLOW` button, submitted as
  **UTILITY** (cheaper, higher trust). Sent by the same path as `maybeSendCampaignWhatsappWelcome`,
  using the E.164 phone → `wa_phone` promotion pattern. If Meta rejects the UTILITY categorisation,
  fall back to resubmitting as MARKETING.
- **In-session (window open):** `sendFlowMessage` posts an `interactive:flow` message directly.
- The current `meta_ad_whatsapp_lead` quick-reply welcome is kept as a **fallback** if the Flow
  send is rejected (template paused, region gap, etc.).

## 8. Error handling

- Endpoint **must** answer Meta's `ping` health check, else Meta disables the Flow.
- Decrypt failure → **HTTP 421** (Meta re-fetches the public key and retries).
- No slots for a chosen day → Slot screen renders an empty-state, user picks another day.
- Slot taken between selection and confirm → completion routes to `routeToReview` (existing
  race handling) and Mia offers an alternative — no silent failure.
- Abandoned Flow → no booking row written; existing welcome/nurture + Mia nudge continue.
- Any endpoint exception → generic error screen returned, logged server-side, nothing leaked.

## 9. Consent & GDPR (recorded decision)

The marketing-consent OptIn is **pre-ticked**, matching the `/start` web funnel. On completion,
`recordMarketingConsent({ contact, consent, source: 'whatsapp_flow' })` writes the `consent_log`
audit row and sets `contacts.whatsapp_marketing`.

> **Legal-review item (not a blocker):** under GDPR / ePrivacy (CJEU *Planet49*), a pre-ticked
> box is generally **not** valid consent — consent must be an unambiguous affirmative act. This
> mirrors an existing decision on the web funnel and is recorded here for legal sign-off, not to
> block the build. If legal requires it, flip the default to unticked in `screens.js` (one-line change).

## 10. Testing

- **Unit:** `crypto.js` round-trip against Meta's published test vectors; `screens.js` state
  machine (`screen + action + data → next`); `nfm_reply → class_booking_requests` parser.
- **Integration:** `ping` health check; `INIT` prefill; `data_exchange` serves live slots
  (mock `booking-slots.js`); completion webhook writes the booking row and records consent.
- **Reuse:** existing `class-booking-processor` tests cover the downstream booking unchanged.
- **Manual E2E:** Meta Flow Builder preview + the endpoint test tool before publish.

## 11. Rollout

- Stillorgan only, gated by the **automations-hub toggle** (OFF by default, per-location).
- Graph API v21.0 already supports Flows (available since v17).
- Web LP + `meta_ad_whatsapp_lead` quick-reply path retained as fallbacks.
- Sequence: (1) endpoint + crypto + keys registered; (2) Flow asset published; (3) initiating
  template approved; (4) toggle on for Stillorgan; (5) monitor completions + number quality.

## 12. Out of scope (this spec)

- Separate per-journey Flows (Option B) and class-only-first (Option C).
- WhatsApp Pay / catalog messages (collides with the Pulse/Glofox payment boundary).
- MM Lite send optimisation and the Calling API — tracked separately in the WhatsApp platform audit.
- Reworking Mia's conversational booking (unchanged; it's the fallback).

## Resolved in spec review (2026-07-01)

1. **Consult journey = day + slot only.** No goal/injury intake screens at v1 — the member is
   coming on-site, so the coach captures goals and injuries on the day. Same shape as the class journey.
2. **Initiating template category = UTILITY** (fall back to MARKETING only if Meta rejects it).
3. **Consult availability = the "Free UN1T Consultation" event type**, resolved by slug through the
   existing `bookings/[slug]` availability engine. Classes use the Glofox class schedule.
