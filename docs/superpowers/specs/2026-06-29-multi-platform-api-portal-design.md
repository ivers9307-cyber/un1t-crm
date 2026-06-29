# Multi-platform API portal (Swagger) — design

**Date:** 2026-06-29
**Status:** Approved (brainstorm) — pending spec review
**Repos touched:** `un1t-crm` (primary), `champ-app`
**Branch:** `feature/api-docs-portal` (un1t-crm); a sibling branch in champ-app for its half.

## Purpose

A single, browsable Swagger/OpenAPI reference for **all externally-meaningful APIs and
webhooks across our platforms**. Today the only consumable surface is partial: un1t-crm
ships a Swagger page but it documents 43 of 505 routes and omits every webhook, almost
every public endpoint, the device bridge, and champ-app entirely. This work completes the
un1t-crm integration surface and adds champ-app as a second platform behind a switcher.

## Current state (what already exists)

un1t-crm already has working OpenAPI infrastructure — this is an **extend**, not a build:

- `src/app/api-docs/route.js` — Swagger UI page (standalone HTML route handler, bypasses
  the app layout). Auth-gated globally via `src/proxy.js` (Next 16's middleware equivalent).
- `src/app/api/openapi.json/route.js` — serves the spec.
- `src/lib/openapi.js` (~1142 lines) — generates an **OpenAPI 3.1** spec from **Zod schemas**
  via `@asteasolutions/zod-to-openapi`. Single source of truth = the Zod schemas in
  `src/lib/schemas.js`; no hand-written JSON to drift.
  - Two security schemes defined: `BearerAuth` (`CRM_API_KEY`, for n8n/integrations) and
    `CookieAuth` (Supabase session).
  - Servers: `https://crm.un1tdublin.com` (prod), `http://localhost:3000` (dev).
  - 43 paths registered. Tags: Contacts, Deals, Staff, Schedule, Live HR, Automations,
    Google Business, Marketing, Public, Me.
- `src/lib/openapi.test.js` — asserts spec shape, both auth schemes, key paths, schemas.

champ-app has `zod` ^4.4.1 but **no** `@asteasolutions/zod-to-openapi` and no central
`schemas.js`; it has domain modules under `src/lib` (e.g. `challenges.js`). It is a separate
Next deploy (`app.champfitness.ie`).

## Scope (decided)

- **CRM = integration surface only.** Document the genuinely external/integration endpoints;
  keep the ~290 internal frontend-only CRUD routes and 43 cron jobs OUT (no schemas, pure
  noise). Result: a clean ~70-endpoint reference.
- **Platforms:** un1t-crm **and** champ-app in this pass, as one portal with a platform
  switcher. un1t-platform (3 routes) deferred.
- **Webhooks: both directions.** Inbound receivers documented now; an outbound-events
  section stubbed for the future.
- **Cross-origin:** champ-app serves its spec CORS-readable; the CRM portal fetches it
  directly (true single-page switcher). Spec exposes endpoint *shapes*, not data.

## Architecture

The portal home stays `un1t-crm/src/app/api-docs`. Swagger UI's native `urls` config turns
it into a platform switcher:

```
urls: [
  { url: '/api/openapi.json',                        name: 'UN1T CRM' },   // same origin
  { url: 'https://app.champfitness.ie/api/openapi.json', name: 'Champ App' }, // cross-origin
]
urls.primaryName: 'UN1T CRM'
```

Each spec carries its own `servers` block, so Swagger UI's "Try it out" targets the correct
host per platform. The two specs are independent documents generated in their own repos —
no build-time coupling.

```
                ┌────────────────────────────────────────┐
   browser ───▶ │ crm.un1tdublin.com/api-docs (Swagger UI)│
                │   switcher: [UN1T CRM] [Champ App]       │
                └───────────────┬─────────────┬───────────┘
                  fetch (same-origin)      fetch (CORS)
                                │             │
                ┌───────────────▼──┐   ┌──────▼─────────────────────┐
                │ crm /api/        │   │ champ-app /api/openapi.json │
                │ openapi.json     │   │ (CORS: allow CRM origin)    │
                │ src/lib/openapi  │   │ src/lib/openapi (new)       │
                └──────────────────┘   └─────────────────────────────┘
```

## un1t-crm work — extend `src/lib/openapi.js`

Add four tag-groups. Where a route already validates with Zod, derive the schema from that
same source so docs can't drift; for externally-owned payloads (Glofox, Meta) document a
representative passthrough schema since we don't own the shape.

### Tag: Public (anonymous, `security: []`)
leads, branding, events `[slug]` register / check-member / display, races `[slug]` register,
bookings `[slug]` + slots, deposit `[token]` + accept-and-pay, challenges `[locationId]`,
event-payments, event-registrations, tv `[token]` content, presentations `[token]` state,
bca `[token]`. (`book` already documented.) Each notes its rate-limit where one exists.

### Tag: Webhooks (Inbound) — 14 receivers, modeled as POST paths
Each documents its **verification model** as a dedicated security scheme (not just prose):
- `GlofoxHmac` — HMAC-SHA256 against the per-location `webhook_secret`.
- `MetaSignature` — Meta `hub.challenge` GET handshake + signed POST (whatsapp, instagram).
- `WebhookToken` — token/path-token or provider signature (postmark, twilio/status,
  revolut + revolut/race-payments, xero, strava, inbody, unifi-access, unifi-protect,
  invoices-inbound `[token]`, sequence `[token]`).

Receivers live in `paths` (third parties call **us**) under tag **Webhooks (Inbound)**.

> Spec correctness: OpenAPI 3.1's top-level `webhooks` keyword is for events the API
> *sends out*. Inbound receivers we host are normal `paths`. That split is exactly the
> "both directions" decision.

### Tag: Bridge (Pi devices, bearer device token)
scan, samples, heartbeat, inbody ingest / backfill-ingest / backfill-pending / pending.
Security scheme `BridgeAuth` (device bearer token).

### Tag: Mobile (Staff App)
today-feed, layout, device-tokens, me, radar, impersonate (+ stop / users),
checklists/today + `[id]`/items/`[itemId]`. Security = `CookieAuth` / staff session.

### Outbound webhooks stub (top-level `webhooks:`)
One example event (`lead.created`) with a sample payload, `description` marked **Planned —
not yet implemented**, so the section renders in Swagger UI and signals roadmap intent.

### Spec metadata
Bump `info.version`; refresh `info.description` to state the spec now covers the full
public + webhook + bridge integration surface.

### Tests (`src/lib/openapi.test.js`)
Extend to assert: new tags present; representative paths exist
(`/api/public/leads`, `/api/webhooks/glofox`, `/api/bridge/scan`, a mobile path); webhook
ops carry their own (non-Cookie/Bearer) security; `webhooks` keyword present with the stub
event; spec still serialises without circular refs.

### `src/app/api-docs/route.js`
Add the `urls` switcher; light UN1T branding (title + monochrome). Decide tryItOut per-tag:
keep it for read/public GETs; consider disabling for inbound-webhook POSTs (signature checks
would 401) and for any public POST that writes real data (leads/book create real rows).

## champ-app work — new generator (mirrors CRM)

- Add `@asteasolutions/zod-to-openapi`.
- Create `src/lib/openapi.js` + `src/app/api/openapi.json/route.js`. Cover: `social/*`
  (feed, friends + accept/decline/request + `[contactId]`, leaderboard, reactions, requests,
  search, settings, suggestions, challenge-boards), `mobile/*` (link-contact, push-token,
  review-login), `challenges`, `tier-status`, `sessions/[id]/report` + share,
  `oauth/strava/start` + callback.
- Auth scheme = member JWT / review-login token (`MemberAuth`).
- Server: `https://app.champfitness.ie` (+ localhost).
- Schemas derived from champ-app's existing zod domain modules where present.
- **CORS:** the `openapi.json` route returns `Access-Control-Allow-Origin` for the CRM origin
  (prod + localhost) and is readable without a champ-app session (spec only — no data). Allow
  it through champ-app's proxy/middleware for that path.
- Mirror `openapi.test.js`.
- Optional: a champ-app `/api-docs` page too (nice-to-have; the CRM portal is canonical).

## Security considerations

- The spec describes API **shape**, not data — consistent with how the existing CRM spec is
  already exposed to any authenticated user.
- CRM `/api-docs` + `/api/openapi.json` stay behind `proxy.js` (logged-in or bearer). Verify
  this is intact after edits — do not accidentally make the full surface anonymous.
- champ-app's `openapi.json` is the one deliberately-readable-cross-origin endpoint; restrict
  CORS to known origins and keep it spec-only.
- "Try it out" against real public POSTs / inbound webhooks can create rows or fail signature
  checks — gate per the tryItOut decision above.

## Out of scope (this pass)

- The ~290 internal CRM CRUD routes and 43 cron jobs.
- un1t-platform's 3 routes (auth/sign-out, branding, sentinel-runbook).
- Actually building an outbound-webhook delivery system (only the doc stub is in scope).
- champ-bridge (a client, serves nothing), un1t-sentinel, un1t-finance-agent.

## Open items to resolve during implementation

- Exact verification mechanism per inbound webhook (confirm by reading each route's header).
- champ-app per-route auth specifics (member JWT vs review-login token vs anonymous).
- Whether to disable tryItOut for write/webhook operations.
- champ-app proxy allowlist entry for the CORS spec route.
