# Multi-platform API Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the un1t-crm OpenAPI spec to cover the full external integration surface (public, inbound webhooks, bridge, mobile + an outbound-webhook stub) and add champ-app as a second platform behind a Swagger UI switcher.

**Architecture:** Extend the existing Zod-driven generator `un1t-crm/src/lib/openapi.js` (no new tooling there). Add a parallel generator in champ-app exposing a CORS-readable `/api/openapi.json`. The existing `un1t-crm/src/app/api-docs` page gains Swagger UI's `urls` switcher pointing at both specs.

**Tech Stack:** Next.js 16 (App Router, route handlers), `@asteasolutions/zod-to-openapi` v8, Zod v4, Vitest, Swagger UI (CDN).

---

## Conventions used throughout

- **Registration pattern** (already used in `openapi.js`): `registry.registerPath({ method, path, tags, security, summary, description, request, responses })`. Paths use OpenAPI `{param}` form, e.g. `/api/public/events/{slug}`.
- **Security on a path:** omit `security` (or `security: []`) = anonymous. Otherwise `security: [{ SchemeName: [] }]`.
- **Schema reuse:** if a route already validates via an exported Zod schema, import and reuse it (no drift). Otherwise define an inline `z.object({...}).openapi('Name')` next to the registration, matching the route's documented body/response. Externally-owned payloads (Glofox/Meta/Twilio) use `z.object({}).passthrough().openapi('Name')` with the shape described in `description`.
- **Shared primitives** are in `un1t-crm/src/lib/schemas.js`: `uuidLike, isoDate, timeOfDay, email, phone, money` etc. Import what you need.
- **Test file** for CRM: `un1t-crm/src/lib/openapi.test.js`. Run a single file with `npx vitest run src/lib/openapi.test.js` from the un1t-crm worktree.
- **Commits:** end every commit message body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Prerequisites (workspace)

- **un1t-crm work** happens in the existing worktree `/Users/richardivers/code/un1t-crm/.claude/worktrees/api-docs-portal` on branch `feature/api-docs-portal` (already created off fresh `origin/main`). All Phase A paths below are relative to that worktree.
- **champ-app work** (Phase B) happens in a separate worktree created in Task B0.

---

# Phase A — un1t-crm

## Task A1: New security schemes for webhooks + bridge

**Files:**
- Modify: `src/lib/openapi.js` (after the existing `CookieAuth` registration, ~line 197)
- Test: `src/lib/openapi.test.js`

- [ ] **Step 1: Write the failing test** — add to `openapi.test.js`:

```js
it('declares webhook + bridge auth schemes', () => {
  const s = spec.components.securitySchemes
  expect(s).toHaveProperty('GlofoxHmac')
  expect(s).toHaveProperty('MetaSignature')
  expect(s).toHaveProperty('WebhookToken')
  expect(s).toHaveProperty('BridgeAuth')
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: FAIL — `GlofoxHmac` missing.

- [ ] **Step 3: Add the schemes** in `openapi.js` right after the `CookieAuth` block:

```js
registry.registerComponent('securitySchemes', 'GlofoxHmac', {
  type: 'apiKey', in: 'header', name: 'X-Glofox-Signature',
  description: 'HMAC-SHA256 of the raw body, keyed by the per-location webhook secret. Verified in src/lib/glofox.js verifyGlofoxSignature.',
})
registry.registerComponent('securitySchemes', 'MetaSignature', {
  type: 'apiKey', in: 'header', name: 'X-Hub-Signature-256',
  description: 'Meta webhook signature. GET handshake echoes hub.challenge; POST carries X-Hub-Signature-256 over the raw body.',
})
registry.registerComponent('securitySchemes', 'WebhookToken', {
  type: 'apiKey', in: 'header', name: 'Authorization',
  description: 'Provider-specific shared secret or signature header (Postmark/Twilio/Revolut/Xero/Strava/InBody/UniFi), or a path token for tokenised receivers.',
})
registry.registerComponent('securitySchemes', 'BridgeAuth', {
  type: 'http', scheme: 'bearer',
  description: 'Per-bridge device token. Verified in src/lib/bridge-auth.js verifyBridgeToken.',
})
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "feat(openapi): add webhook + bridge security schemes"
```

---

## Task A2: Public tag-group

**Files:**
- Modify: `src/lib/openapi.js` (add a new "Public surface" section of registrations)
- Test: `src/lib/openapi.test.js`

These are all **anonymous** (`security: []`). `/api/public/book` is already registered — do not duplicate it.

- [ ] **Step 1: Write the failing test:**

```js
it('documents the public surface anonymously', () => {
  for (const p of [
    '/api/public/leads',
    '/api/public/branding',
    '/api/public/events/{slug}/register',
    '/api/public/bookings/{slug}/slots',
  ]) {
    expect(spec.paths, `missing ${p}`).toHaveProperty(p)
  }
  const op = spec.paths['/api/public/leads'].post
  expect(op.security ?? []).toHaveLength(0)
  expect(op.tags).toContain('Public')
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: FAIL — `/api/public/leads` missing.

- [ ] **Step 3: Implement.** Worked example for `leads` (reuse the route's real schema — `LeadSchema` from `@/lib/leads`):

```js
import { LeadSchema } from '@/lib/leads' // add to imports at top of openapi.js

registry.registerPath({
  method: 'post',
  path: '/api/public/leads',
  tags: ['Public'],
  summary: 'Public waitlist / lead capture',
  description: 'Anonymous. Rate-limited to 8 requests per IP per 15 min. Studio resolved server-side from publicPath — caller cannot target an arbitrary location.',
  request: { body: { content: { 'application/json': { schema: LeadSchema } } } },
  responses: {
    200: { description: 'Lead captured' },
    400: { description: 'Validation failed or studio not accepting sign-ups', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

Then register each remaining public endpoint following that exact shape (all `tags: ['Public']`, no `security`). For each, set the `summary` from the route's top comment and add a `request.params`/`request.query`/`request.body` block where the route reads them. Path params become `{param}`. Endpoints (exact method + path):

| Method | OpenAPI path | Notes for summary/body |
|---|---|---|
| GET | `/api/public/branding` | branding config by `publicPath` query |
| GET | `/api/public/bookings/{slug}` | booking page config |
| GET | `/api/public/bookings/{slug}/slots` | available slots; query may include date |
| GET | `/api/public/challenges/{locationId}` | public challenge board |
| GET | `/api/public/events/{slug}` | event detail |
| POST | `/api/public/events/{slug}/register` | event signup; body = name/email/phone (+ team fields) |
| POST | `/api/public/events/{slug}/check-member` | membership check before register |
| GET | `/api/public/events/{slug}/display` | public display feed |
| GET | `/api/public/events/checkin-qr` | QR payload/image; query = signed token |
| GET | `/api/public/event-payments/{id}` | payment status |
| GET | `/api/public/event-registrations/{id}` | registration status |
| POST | `/api/public/races/{slug}/register` | race signup |
| GET | `/api/public/deposit/{token}` | deposit request detail |
| POST | `/api/public/deposit/{token}/accept-and-pay` | accept + pay deposit |
| GET | `/api/public/live/{locationId}` | public live/TV state feed |
| GET | `/api/public/tv/{token}/content` | TV content for a paired display |
| GET | `/api/public/presentations/{token}/state` | slideshow state |
| GET | `/api/public/bca/{token}/merged` | merged BCA doc |
| GET | `/api/public/bca/{token}/file/{slug}` | BCA file |

Use `z.object({}).passthrough().openapi('NameResponse')` for response bodies you don't want to fully model; always document a `200` plus the error codes the route returns (typically 400/404).

- [ ] **Step 4: Run test, verify pass** — Run: `npx vitest run src/lib/openapi.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "feat(openapi): document the public API surface"
```

---

## Task A3: Webhooks (Inbound) tag-group

**Files:**
- Modify: `src/lib/openapi.js`
- Test: `src/lib/openapi.test.js`

Inbound receivers are normal `paths` under tag `Webhooks (Inbound)`. Each carries its provider security scheme (NOT Cookie/Bearer). Payloads are externally owned → `passthrough` schemas with the shape described in prose.

- [ ] **Step 1: Write the failing test:**

```js
it('documents inbound webhooks with provider auth', () => {
  for (const p of ['/api/webhooks/glofox', '/api/webhooks/whatsapp', '/api/webhooks/postmark', '/api/webhooks/twilio/status']) {
    expect(spec.paths, `missing ${p}`).toHaveProperty(p)
  }
  const glofox = spec.paths['/api/webhooks/glofox'].post
  expect(glofox.tags).toContain('Webhooks (Inbound)')
  expect(glofox.security).toContainEqual({ GlofoxHmac: [] })
  // Not gated by the browser/integration schemes:
  expect(glofox.security).not.toContainEqual({ CookieAuth: [] })
})
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/lib/openapi.test.js` → FAIL.

- [ ] **Step 3: Implement.** Worked example (`glofox`):

```js
const GlofoxEvent = z.object({}).passthrough().openapi('GlofoxWebhookEvent', {
  description: 'Glofox booking/membership/member/access event. branchId resolves the location; event_id dedupes retried deliveries.',
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/glofox',
  tags: ['Webhooks (Inbound)'],
  security: [{ GlofoxHmac: [] }],
  summary: 'Inbound Glofox events',
  description: 'Glofox → CRM. HMAC-SHA256 verified against the per-location webhook secret (resolved by branchId). Idempotent via glofox_webhook_events.event_id.',
  request: { body: { content: { 'application/json': { schema: GlofoxEvent } } } },
  responses: {
    200: { description: 'Accepted (and processed unless dark-launched)' },
    401: { description: 'Bad / missing signature', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

Register the rest following the same shape. For receivers exporting **both GET and POST**, the GET is a verification/challenge handshake — register it too with a short `summary` ("verification handshake") and `200` response. Endpoints:

| Methods | OpenAPI path | Security scheme | Summary / verification |
|---|---|---|---|
| POST | `/api/webhooks/postmark` | WebhookToken | Postmark delivery/bounce/open events |
| POST | `/api/webhooks/inbody` | WebhookToken | InBody body-scan results |
| GET, POST | `/api/webhooks/instagram` | MetaSignature | GET = `hub.challenge`; POST = DM/comment events |
| GET, POST | `/api/webhooks/whatsapp` | MetaSignature | GET = `hub.challenge`; POST = message/status events |
| GET, POST | `/api/webhooks/strava` | WebhookToken | GET = subscription validation; POST = activity events |
| GET, POST | `/api/webhooks/xero` | WebhookToken | GET = intent-to-receive; POST = accounting events |
| GET, POST | `/api/webhooks/revolut` | WebhookToken | payment events |
| POST, GET | `/api/webhooks/revolut/race-payments` | WebhookToken | race deposit payment events |
| POST | `/api/webhooks/twilio/status` | WebhookToken | Twilio SMS delivery status |
| POST | `/api/webhooks/unifi-access` | WebhookToken | UniFi Access door events |
| POST | `/api/webhooks/unifi-protect` | WebhookToken | UniFi Protect events |
| POST | `/api/webhooks/invoices-inbound/{token}` | WebhookToken | tokenised inbound invoice email/forward |
| POST | `/api/webhooks/sequence/{token}` | WebhookToken | tokenised sequence callback |

(Confirm each provider's exact verification by skimming the route's header comment; set `description` accordingly. All use a `passthrough` body schema.)

- [ ] **Step 4: Run test, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "feat(openapi): document inbound webhook receivers"
```

---

## Task A4: Bridge tag-group

**Files:**
- Modify: `src/lib/openapi.js`
- Test: `src/lib/openapi.test.js`

All `security: [{ BridgeAuth: [] }]`, tag `Bridge`.

- [ ] **Step 1: Write the failing test:**

```js
it('documents the bridge device API', () => {
  expect(spec.paths).toHaveProperty('/api/bridge/scan')
  const op = spec.paths['/api/bridge/scan'].post
  expect(op.tags).toContain('Bridge')
  expect(op.security).toContainEqual({ BridgeAuth: [] })
})
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement.** Worked example (`scan`):

```js
const StrapScan = z.object({
  straps: z.array(z.object({
    device_key: z.string().openapi({ example: 'ble:AA:BB:CC:DD:EE:FF' }),
    name: z.string().nullable().optional(),
    rssi: z.number().nullable().optional(),
    last_bpm: z.number().nullable().optional(),
  })).max(100),
}).openapi('StrapScan')

registry.registerPath({
  method: 'post',
  path: '/api/bridge/scan',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'Report currently-visible straps',
  description: 'Pi bridge → CRM. Overwrites ble_bridges.last_seen_straps. Polled ~every 5s during coach pairing. Max 100 straps.',
  request: { body: { content: { 'application/json': { schema: StrapScan } } } },
  responses: {
    200: { description: 'Stored' },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

Register the rest (all `Bridge` + `BridgeAuth`):

| Method | OpenAPI path | Summary |
|---|---|---|
| POST | `/api/bridge/samples` | Batch of HR samples for live sessions |
| POST | `/api/bridge/heartbeat` | Bridge liveness ping |
| POST | `/api/bridge/inbody/ingest` | Push a fresh InBody scan |
| POST | `/api/bridge/inbody/backfill-ingest` | Push a historical InBody scan |
| GET | `/api/bridge/inbody/backfill-pending` | List scans pending backfill |
| GET | `/api/bridge/inbody/pending` | List scans pending ingest |

- [ ] **Step 4: Run test, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "feat(openapi): document the Pi bridge device API"
```

---

## Task A5: Mobile (Staff App) tag-group

**Files:**
- Modify: `src/lib/openapi.js`
- Test: `src/lib/openapi.test.js`

All `security: [{ CookieAuth: [] }]`, tag `Mobile`.

- [ ] **Step 1: Write the failing test:**

```js
it('documents the staff mobile API', () => {
  expect(spec.paths).toHaveProperty('/api/mobile/today-feed')
  const op = spec.paths['/api/mobile/today-feed'].get
  expect(op.tags).toContain('Mobile')
  expect(op.security).toContainEqual({ CookieAuth: [] })
})
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement.** Register these (exact method + path; `tags: ['Mobile']`, `security: [{ CookieAuth: [] }]`):

| Method(s) | OpenAPI path | Summary |
|---|---|---|
| GET | `/api/mobile/today-feed` | Coach "today" feed |
| PUT | `/api/mobile/layout` | Save the mobile home layout |
| GET | `/api/mobile/me` | Current staff profile + permissions |
| GET | `/api/mobile/radar` | Lead/churn radar summary |
| POST, DELETE | `/api/mobile/device-tokens` | Register / remove a push token |
| POST | `/api/mobile/impersonate` | Start impersonation |
| POST | `/api/mobile/impersonate/stop` | Stop impersonation |
| GET | `/api/mobile/impersonate/users` | List impersonatable users |
| GET | `/api/mobile/checklists/today` | Today's checklists |
| POST, DELETE | `/api/mobile/checklists/{id}/items/{itemId}` | Tick / untick a checklist item |

Worked example:

```js
registry.registerPath({
  method: 'get',
  path: '/api/mobile/me',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Current staff profile + permissions',
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: z.object({}).passthrough() } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 4: Run test, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "feat(openapi): document the staff mobile API"
```

---

## Task A6: Outbound webhooks stub

**Files:**
- Modify: `src/lib/openapi.js` (inside `buildSpec()`)
- Test: `src/lib/openapi.test.js`

We attach a top-level `webhooks` block (OpenAPI 3.1) describing a *planned* outbound event. Done by post-processing the generated document — version-proof regardless of helper availability.

- [ ] **Step 1: Write the failing test:**

```js
it('includes an outbound webhooks stub', () => {
  expect(spec).toHaveProperty('webhooks')
  expect(spec.webhooks).toHaveProperty('lead.created')
  expect(spec.webhooks['lead.created'].post.description).toMatch(/planned/i)
})
```

- [ ] **Step 2: Run it, verify it fails** — FAIL (`webhooks` undefined).

- [ ] **Step 3: Implement** — in `buildSpec()`, capture the doc and attach `webhooks` before returning:

```js
function buildSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions)
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: { /* unchanged */ },
    servers: [ /* unchanged */ ],
  })
  // Outbound events we PLAN to push to subscribers. 3.1 `webhooks` keyword:
  // the API is the source; the reader implements the receiver. Not yet built.
  doc.webhooks = {
    'lead.created': {
      post: {
        tags: ['Webhooks (Outbound)'],
        summary: 'Lead created (planned)',
        description: 'PLANNED — not yet implemented. Fired when a new lead is captured. ' +
          'Your endpoint receives this payload; respond 2xx to acknowledge.',
        requestBody: {
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              event: { type: 'string', example: 'lead.created' },
              contact_id: { type: 'string', format: 'uuid' },
              location_id: { type: 'string', format: 'uuid' },
              created_at: { type: 'string', format: 'date-time' },
            },
          } } },
        },
        responses: { '2xx': { description: 'Acknowledged by your endpoint' } },
      },
    },
  }
  return doc
}
```

- [ ] **Step 4: Run test, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "feat(openapi): add planned outbound webhooks stub"
```

---

## Task A7: Bump metadata + upgrade the /api-docs page to a platform switcher

**Files:**
- Modify: `src/lib/openapi.js` (`info` block in `buildSpec()`)
- Modify: `src/app/api-docs/route.js`
- Test: `src/app/api-docs/route.test.js` (Create)

- [ ] **Step 1: Write the failing test** — Create `src/app/api-docs/route.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { GET } from './route.js'

describe('GET /api-docs', () => {
  it('renders a Swagger UI page with a CRM + Champ App switcher', async () => {
    const res = await GET()
    const html = await res.text()
    expect(html).toContain('swagger-ui')
    expect(html).toContain("name: 'UN1T CRM'")
    expect(html).toContain("name: 'Champ App'")
    expect(html).toContain('/api/openapi.json')
    expect(html).toContain('app.champfitness.ie/api/openapi.json')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/app/api-docs/route.test.js`
Expected: FAIL — switcher names absent.

- [ ] **Step 3: Implement.** In `api-docs/route.js`, replace the single `url:` config with the `urls` switcher (keep the rest of the HTML/styles):

```js
        window.ui = SwaggerUIBundle({
          urls: [
            { url: '/api/openapi.json', name: 'UN1T CRM' },
            { url: 'https://app.champfitness.ie/api/openapi.json', name: 'Champ App' },
          ],
          'urls.primaryName': 'UN1T CRM',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis],
          layout: 'BaseLayout',
          docExpansion: 'list',
          defaultModelsExpandDepth: 1,
          tryItOutEnabled: true,
        })
```

Also update `<title>` to `UN1T — API Portal`. In `openapi.js` `info`, bump `version` to `'1.1.0'` and append to `description`: `' Covers the public, inbound-webhook, bridge and mobile integration surface; planned outbound events appear under webhooks.'`

**tryItOut decision (resolves the spec's open item):** keep `tryItOutEnabled: true` globally for v1. The page is auth-gated and used internally; live calls against public POSTs (create real rows) or inbound webhooks (fail signature checks → 401) are acceptable and visible. Revisit only if operators start hitting write endpoints by accident.

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/app/api-docs/route.test.js src/lib/openapi.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/app/api-docs/route.js src/app/api-docs/route.test.js
git commit -m "feat(api-docs): platform switcher + spec metadata bump"
```

---

## Task A8: Phase A verification

- [ ] **Step 1: Full unit suite for the spec**

Run: `npx vitest run src/lib/openapi.test.js src/app/api-docs/route.test.js`
Expected: PASS, no console errors.

- [ ] **Step 2: Confirm the spec still serialises and the proxy still gates** — Run:

```bash
grep -nE "api-docs|openapi" src/proxy.js || echo "proxy.js does not special-case api-docs (it falls under the default auth gate — confirm /api-docs requires a session in a manual check after deploy)"
```

Expected: either a matching gate, or the printed reminder to manually confirm `/api-docs` is auth-gated (it must NOT be anonymous).

- [ ] **Step 3: Production build sanity (optional, slow)**

Run: `npm run build` (or the repo's build script) — expect success. Skip if the worktree shares a hot dev server.

- [ ] **Step 4: Nothing to commit if green.** If Step 2 surfaced a gating gap, add `/api/openapi.json` + `/api-docs` to the proxy's authenticated matcher and commit:

```bash
git add src/proxy.js
git commit -m "fix(api-docs): ensure spec + docs page stay behind auth"
```

---

# Phase B — champ-app

## Task B0: champ-app worktree + dependency

**Files:**
- Modify: `champ-app/package.json`

- [ ] **Step 1: Create an isolated worktree off fresh origin/main**

```bash
cd /Users/richardivers/code/champ-app
git fetch origin --quiet
git worktree add -b feature/api-docs-openapi .claude/worktrees/api-docs-openapi origin/main
cd .claude/worktrees/api-docs-openapi
```

All Phase B paths below are relative to this champ-app worktree.

- [ ] **Step 2: Add the generator dependency**

Run: `npm install --save @asteasolutions/zod-to-openapi@^8`
Expected: `package.json` + lockfile updated.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @asteasolutions/zod-to-openapi"
```

---

## Task B1: champ-app spec generator

**Files:**
- Create: `src/lib/openapi.js`
- Test: `src/lib/openapi.test.js` (Create)

- [ ] **Step 1: Write the failing test** — Create `src/lib/openapi.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest'
import { getOpenApiSpec } from './openapi.js'

describe('champ-app getOpenApiSpec', () => {
  let spec
  beforeAll(async () => { spec = await getOpenApiSpec() })

  it('is a 3.1 spec for the Champ App', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('Champ App API')
    expect(spec.servers.map(s => s.url)).toContain('https://app.champfitness.ie')
  })
  it('declares member auth', () => {
    expect(spec.components.securitySchemes).toHaveProperty('MemberAuth')
  })
  it('documents key member endpoints', () => {
    for (const p of ['/api/challenges', '/api/tier-status', '/api/social/leaderboard', '/api/social/friends']) {
      expect(spec.paths, `missing ${p}`).toHaveProperty(p)
    }
    expect(spec.paths['/api/challenges'].get.security).toContainEqual({ MemberAuth: [] })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/openapi.js` (mirror the CRM pattern; champ-app routes return ad-hoc JSON so model responses as `passthrough`):

```js
import { z } from 'zod'
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)
const registry = new OpenAPIRegistry()

const ErrorResponse = z.object({ error: z.string() }).openapi('ErrorResponse')
const Json = (name) => z.object({}).passthrough().openapi(name)

registry.registerComponent('securitySchemes', 'MemberAuth', {
  type: 'http', scheme: 'bearer',
  description: 'Supabase member session. Mobile sends Authorization: Bearer <access_token>; web uses the session cookie.',
})

function path(method, p, summary, { security = [{ MemberAuth: [] }], body } = {}) {
  registry.registerPath({
    method, path: p, tags: ['Champ App'], security, summary,
    ...(body ? { request: { body: { content: { 'application/json': { schema: body } } } } } : {}),
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: Json(summary.replace(/\W+/g, '') + 'Response') } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    },
  })
}

// Member surface
path('get',  '/api/challenges',              'Active challenges + gym board')
path('get',  '/api/tier-status',             'Member tier + monthly target')
path('get',  '/api/social/feed',             'Activity feed')
path('get',  '/api/social/friends',          'Friend list')
path('post', '/api/social/friends/request',  'Send a friend request', { body: z.object({ contactId: z.string() }) })
path('post', '/api/social/friends/accept',   'Accept a friend request', { body: z.object({ contactId: z.string() }) })
path('post', '/api/social/friends/decline',  'Decline a friend request', { body: z.object({ contactId: z.string() }) })
path('post', '/api/social/friends/{contactId}', 'Add friend by id', { body: z.object({}).passthrough() })
path('delete','/api/social/friends/{contactId}', 'Remove a friend')
path('get',  '/api/social/requests',         'Incoming friend requests')
path('get',  '/api/social/search',           'Search members')
path('get',  '/api/social/suggestions',      'Suggested friends')
path('get',  '/api/social/leaderboard',      'Leaderboard')
path('get',  '/api/social/challenge-boards', 'Challenge boards')
path('post', '/api/social/reactions',        'Add a reaction', { body: z.object({}).passthrough() })
path('delete','/api/social/reactions',       'Remove a reaction', { body: z.object({}).passthrough() })
path('get',  '/api/social/settings',         'Social settings')
path('put',  '/api/social/settings',         'Update social settings', { body: z.object({}).passthrough() })
path('get',  '/api/sessions/{id}/report',    'Session report')
path('post', '/api/sessions/{id}/share',     'Create a share card', { body: z.object({}).passthrough() })
path('delete','/api/sessions/{id}/share',    'Delete a share card')
path('post', '/api/mobile/link-contact',     'Link the signed-in user to a contact')
path('post', '/api/mobile/push-token',       'Register a push token', { body: z.object({}).passthrough() })
path('delete','/api/mobile/push-token',      'Remove a push token', { body: z.object({}).passthrough() })
path('post', '/api/mobile/review-login',     'App-review reviewer login', { security: [], body: z.object({}).passthrough() })
// OAuth (anonymous — provider redirects; HMAC-signed state)
path('get',  '/api/oauth/strava/start',      'Begin Strava OAuth', { security: [] })
path('get',  '/api/oauth/strava/callback',   'Strava OAuth callback', { security: [] })

let cachedSpec = null
function buildSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions)
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Champ App API', version: '1.0.0',
      description: 'Customer fitness app API (engagement, social, sessions). Auth = Supabase member session (Bearer on mobile, cookie on web).',
    },
    servers: [
      { url: 'https://app.champfitness.ie', description: 'Production' },
      { url: 'http://localhost:8081', description: 'Local dev' },
    ],
  })
}
export async function getOpenApiSpec() {
  if (!cachedSpec) cachedSpec = buildSpec()
  return cachedSpec
}
```

(Verify the dev `server` URL/port against champ-app's web dev script; adjust if not 8081.)

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "feat(openapi): add Champ App spec generator"
```

---

## Task B2: champ-app openapi.json route (CORS)

**Files:**
- Create: `src/app/api/openapi.json/route.js`
- Test: `src/app/api/openapi.json/route.test.js` (Create)

- [ ] **Step 1: Write the failing test** — Create `route.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { GET, OPTIONS } from './route.js'

describe('GET /api/openapi.json', () => {
  it('serves the spec with CORS for the CRM origin', async () => {
    const res = await GET()
    expect(res.headers.get('access-control-allow-origin')).toBe('https://crm.un1tdublin.com')
    const body = await res.json()
    expect(body.info.title).toBe('Champ App API')
  })
  it('answers preflight', async () => {
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://crm.un1tdublin.com')
  })
})
```

- [ ] **Step 2: Run it, verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement** `src/app/api/openapi.json/route.js`:

```js
import { NextResponse } from 'next/server'
import { getOpenApiSpec } from '@/lib/openapi'

export const runtime = 'nodejs'

// Spec-only (endpoint shapes, no data). Readable cross-origin so the
// un1t-crm /api-docs portal switcher can fetch it. Must be in PUBLIC_PATHS.
const CORS = {
  'Access-Control-Allow-Origin': 'https://crm.un1tdublin.com',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300',
}

export async function GET() {
  const spec = await getOpenApiSpec()
  return NextResponse.json(spec, { headers: CORS })
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}
```

- [ ] **Step 4: Run test, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/openapi.json/route.js src/app/api/openapi.json/route.test.js
git commit -m "feat(openapi): serve champ-app spec with CORS"
```

---

## Task B3: Make the spec route public in middleware

**Files:**
- Modify: `src/middleware.js` (the `PUBLIC_PATHS` array, ~line 17)

- [ ] **Step 1: Add the spec path to PUBLIC_PATHS.** Change:

```js
const PUBLIC_PATHS = ['/login', '/auth/callback', '/share', '/api/oauth']
```

to:

```js
const PUBLIC_PATHS = ['/login', '/auth/callback', '/share', '/api/oauth', '/api/openapi.json']
```

- [ ] **Step 2: Allow OPTIONS preflight through** — at the top of the `middleware` function body (after `const { pathname } = ...`), add an early return so CORS preflight (which carries no auth) is never bounced:

```js
  if (request.method === 'OPTIONS') return NextResponse.next()
```

(Place it before the auth checks. If a `NextResponse` isn't already imported in middleware.js, add `import { NextResponse } from 'next/server'`.)

- [ ] **Step 3: Verify the spec is reachable unauthenticated** — start the champ-app web dev server and curl it:

```bash
npm run dev &   # or the repo's web dev script
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/api/openapi.json   # expect 200, not 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/api/social/feed     # expect 401 (still gated)
```

Expected: `/api/openapi.json` → 200; a normal member route → 401. Stop the dev server afterward.

- [ ] **Step 4: Commit**

```bash
git add src/middleware.js
git commit -m "feat(openapi): expose champ-app spec route publicly (spec only)"
```

---

## Task B4 (optional): champ-app standalone /api-docs page

**Files:**
- Create: `src/app/api-docs/route.js`

- [ ] **Step 1:** Copy the un1t-crm `api-docs/route.js` Swagger UI HTML, set `<title>` to `Champ App — API Reference`, and a single `url: '/api/openapi.json'` (no switcher needed here). Add `/api-docs` to `PUBLIC_PATHS` if you want it viewable without login (otherwise it stays member-gated).
- [ ] **Step 2:** Manually load it in a browser; confirm it renders the spec.
- [ ] **Step 3: Commit**

```bash
git add src/app/api-docs/route.js src/middleware.js
git commit -m "feat(api-docs): standalone champ-app API reference page"
```

---

## Task B5: Phase B verification

- [ ] **Step 1: champ-app spec tests**

Run: `npx vitest run src/lib/openapi.test.js src/app/api/openapi.json/route.test.js`
Expected: PASS.

- [ ] **Step 2: Cross-origin smoke test (after both deploy, or against local).** With un1t-crm `/api-docs` open, the "Champ App" entry in the switcher should load champ-app's spec. If the browser console shows a CORS error, re-check Task B2's `Access-Control-Allow-Origin` matches the CRM origin exactly (scheme + host, no trailing slash) and Task B3 made the route public.

---

## Final integration check (both repos)

- [ ] Open `https://crm.un1tdublin.com/api-docs` (logged in). The top-right dropdown lists **UN1T CRM** and **Champ App**.
- [ ] UN1T CRM spec shows tags: Public, Webhooks (Inbound), Webhooks (Outbound), Bridge, Mobile (plus the pre-existing Contacts/Deals/Staff/Schedule/Live HR/Automations/Google Business).
- [ ] Switching to Champ App loads its spec with the Champ App tag and the `app.champfitness.ie` server selected.
- [ ] `/api-docs` and both `/api/openapi.json` endpoints behave per their intended auth (CRM gated; champ-app spec readable cross-origin, champ-app data routes still 401).
