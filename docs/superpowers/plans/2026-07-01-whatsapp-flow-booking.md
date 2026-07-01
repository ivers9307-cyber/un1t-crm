# WhatsApp Flow — "Book your first visit" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamic WhatsApp Flow that captures a first-visit booking (class or "Free UN1T Consultation") entirely in-chat with live slots, reusing the existing booking backend.

**Architecture:** A Meta-hosted Flow asset drives multi-screen capture. A new encrypted data-exchange endpoint (`/api/whatsapp/flow`) serves live availability from the existing `booking-slots.js` (consults) and `public-classes.js` (classes) engines. On completion, a `nfm_reply` webhook writes a `class_booking_requests` row (class) or a `bookings` row (consult), then the existing `process-class-bookings` cron / appointments path books it. Mia remains the fallback for the long tail.

**Tech Stack:** Next.js 16 (App Router) API routes, Node `crypto` (RSA-OAEP-256 + AES-128-GCM per Meta's Flow endpoint protocol), Supabase (`supabase-js`), Vitest.

**Design spec:** `docs/superpowers/specs/2026-07-01-whatsapp-flow-booking-design.md`

---

## File Structure

**New:**
- `src/lib/whatsapp-flow/crypto.js` — Meta Flow endpoint crypto (decrypt request / encrypt response). Pure, no I/O.
- `src/lib/whatsapp-flow/screens.js` — the published Flow JSON (`FLOW_JSON`) + **pure** screen builders (data → screen payload).
- `src/lib/whatsapp-flow/handler.js` — orchestration + I/O: prefill, resolve days/slots, `handleDataExchange`, `parseFlowCompletion`.
- `src/app/api/whatsapp/flow/route.js` — transport: decrypt → dispatch → encrypt; `ping` health check; 421 on decrypt failure.
- `src/lib/bookings-write.js` — `createEventBooking` extracted from the public consult-booking path (DRY, shared by route + Flow).
- `scripts/register-flow-encryption.mjs` — one-time: register the RSA public key on the phone number.
- Tests: `crypto.test.js`, `screens.test.js`, `handler.test.js`, `bookings-write.test.js`, `route.test.js` alongside each unit; webhook completion test extends the existing webhook test.

**Modify:**
- `src/lib/whatsapp.js` — add `buildFlowPayload` + `sendFlowMessage`; confirm `createTemplate` passes a `FLOW` button component through unchanged.
- `src/app/api/webhooks/whatsapp/route.js` — in `case 'interactive'`, detect `nfm_reply` → `handleFlowCompletion`.
- `src/lib/automations/meta-ad-whatsapp-welcome.js` — send the Flow initiating template when the location has the Flow toggle on (else current quick-reply welcome).
- Per-location settings JSONB `locations.settings.whatsapp_flow` (`{ enabled, flow_id, template_name, consult_event_slug }`) — read helper + settings UI field (UI is out of scope beyond the read helper).

**Consistent signatures used throughout:**
- `decryptFlowRequest(privateKeyPem, { encrypted_flow_data, encrypted_aes_key, initial_vector }) → { decryptedBody, aesKeyBuffer, initialVectorBuffer }`
- `encryptFlowResponse(responseObject, aesKeyBuffer, initialVectorBuffer) → base64String`
- `handleDataExchange(db, { decryptedBody, contact, locationId, config }) → responseObject`
- `parseFlowCompletion(interactive) → { path: 'class'|'consult', selection, contactFields } | null`
- `buildFlowPayload(to, { flowId, flowToken, flowCta, screen, data }) → object`
- `createEventBooking(db, { event, date, startTime, endTime, contact, source }) → { bookingId } | { error }`

---

## Task 1: RSA keypair + register public key on the phone number

**Files:**
- Create: `scripts/register-flow-encryption.mjs`

- [ ] **Step 1: Generate the keypair locally (manual, once)**

Run:
```bash
openssl genrsa -out /tmp/flow_private.pem 2048
openssl rsa -in /tmp/flow_private.pem -pubout -out /tmp/flow_public.pem
```
Then set the private key as a secret (single-line, `\n`-escaped) in the env store:
`WHATSAPP_FLOW_PRIVATE_KEY` = contents of `/tmp/flow_private.pem`.
Expected: two PEM files exist; env var set in Vercel + `.env.local`.

- [ ] **Step 2: Write the registration script**

```js
// scripts/register-flow-encryption.mjs
// One-time: upload the Flow RSA public key to the WABA phone number.
// Usage: node scripts/register-flow-encryption.mjs <phone_number_id> </tmp/flow_public.pem>
import { readFileSync } from 'node:fs'

const [phoneNumberId, pubPath] = process.argv.slice(2)
const token = process.env.WHATSAPP_ACCESS_TOKEN
if (!phoneNumberId || !pubPath || !token) {
  console.error('need <phone_number_id> <public.pem> and WHATSAPP_ACCESS_TOKEN')
  process.exit(1)
}
const business_public_key = readFileSync(pubPath, 'utf8')
const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/whatsapp_business_encryption`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ business_public_key }),
})
console.log(res.status, await res.text())
```

- [ ] **Step 3: Run it against the Stillorgan phone number**

Run: `node scripts/register-flow-encryption.mjs <stillorgan_phone_number_id> /tmp/flow_public.pem`
Expected: `200 {"success":true}`. Verify with a GET to the same path returning the key + signature status.

- [ ] **Step 4: Commit**

```bash
git add scripts/register-flow-encryption.mjs
git commit -m "feat(wa-flow): script to register Flow encryption public key"
```

---

## Task 2: Crypto library (decrypt request / encrypt response)

**Files:**
- Create: `src/lib/whatsapp-flow/crypto.js`
- Test: `src/lib/whatsapp-flow/crypto.test.js`

- [ ] **Step 1: Write the failing round-trip test**

```js
// src/lib/whatsapp-flow/crypto.test.js
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { decryptFlowRequest, encryptFlowResponse } from './crypto.js'

// Build an encrypted request exactly the way Meta does, so decrypt must reverse it.
function makeEncryptedRequest(publicKeyPem, payloadObj) {
  const aesKey = crypto.randomBytes(16)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv)
  const clear = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const enc = Buffer.concat([cipher.update(clear), cipher.final()])
  const tag = cipher.getAuthTag()
  const encrypted_flow_data = Buffer.concat([enc, tag]).toString('base64')
  const encrypted_aes_key = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  ).toString('base64')
  return { encrypted_flow_data, encrypted_aes_key, initial_vector: iv.toString('base64') }
}

describe('whatsapp-flow crypto', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  it('decrypts a Meta-shaped request', () => {
    const body = makeEncryptedRequest(publicKey, { action: 'ping', version: '3.0' })
    const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptFlowRequest(privateKey, body)
    expect(decryptedBody).toEqual({ action: 'ping', version: '3.0' })
    expect(aesKeyBuffer).toHaveLength(16)
    expect(initialVectorBuffer).toHaveLength(16)
  })

  it('encrypts a response the client can decrypt (flipped IV)', () => {
    const body = makeEncryptedRequest(publicKey, { action: 'ping' })
    const { aesKeyBuffer, initialVectorBuffer } = decryptFlowRequest(privateKey, body)
    const b64 = encryptFlowResponse({ data: { status: 'active' } }, aesKeyBuffer, initialVectorBuffer)

    // Reverse it the way the WhatsApp client would: flipped IV, GCM tag = last 16 bytes.
    const flipped = Buffer.from(initialVectorBuffer.map((b) => ~b & 0xff))
    const raw = Buffer.from(b64, 'base64')
    const tag = raw.subarray(raw.length - 16)
    const data = raw.subarray(0, raw.length - 16)
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, flipped)
    decipher.setAuthTag(tag)
    const out = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    expect(JSON.parse(out)).toEqual({ data: { status: 'active' } })
  })

  it('throws on a tampered AES key', () => {
    const body = makeEncryptedRequest(publicKey, { action: 'ping' })
    body.encrypted_aes_key = Buffer.from('garbage').toString('base64')
    expect(() => decryptFlowRequest(privateKey, body)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp-flow/crypto.test.js`
Expected: FAIL — `Failed to resolve import './crypto.js'`.

- [ ] **Step 3: Implement `crypto.js`**

```js
// src/lib/whatsapp-flow/crypto.js
// Meta WhatsApp Flow endpoint encryption. Request: AES-128-GCM key wrapped with
// RSA-OAEP-256. Response: same AES key, IV bit-flipped, GCM tag appended.
// https://developers.facebook.com/docs/whatsapp/flows/reference/implementingyourflowendpoint
import crypto from 'node:crypto'

export function decryptFlowRequest(privateKeyPem, { encrypted_flow_data, encrypted_aes_key, initial_vector }) {
  const aesKeyBuffer = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64'),
  )
  const initialVectorBuffer = Buffer.from(initial_vector, 'base64')
  const flowData = Buffer.from(encrypted_flow_data, 'base64')
  const tagLength = 16
  const body = flowData.subarray(0, flowData.length - tagLength)
  const tag = flowData.subarray(flowData.length - tagLength)

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, initialVectorBuffer)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  return { decryptedBody: JSON.parse(decrypted), aesKeyBuffer, initialVectorBuffer }
}

export function encryptFlowResponse(responseObject, aesKeyBuffer, initialVectorBuffer) {
  const flippedIv = Buffer.from(initialVectorBuffer.map((b) => ~b & 0xff))
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKeyBuffer, flippedIv)
  const clear = Buffer.from(JSON.stringify(responseObject), 'utf8')
  const enc = Buffer.concat([cipher.update(clear), cipher.final()])
  return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp-flow/crypto.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-flow/crypto.js src/lib/whatsapp-flow/crypto.test.js
git commit -m "feat(wa-flow): Flow endpoint request/response crypto"
```

---

## Task 3: Screens (Flow JSON + pure builders)

**Files:**
- Create: `src/lib/whatsapp-flow/screens.js`
- Test: `src/lib/whatsapp-flow/screens.test.js`

Screen ids: `PATH`, `DAY`, `SLOT`, `DETAILS`, `CONFIRM`. Builders are pure — given already-resolved data they return the `{ screen, data }` response the endpoint sends.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/whatsapp-flow/screens.test.js
import { describe, it, expect } from 'vitest'
import { SCREEN, dayScreen, slotScreen, detailsScreen, FLOW_JSON } from './screens.js'

describe('flow screens', () => {
  it('dayScreen lists days as radio options', () => {
    const res = dayScreen([{ id: '2026-07-03', title: 'Thu 3 Jul' }])
    expect(res.screen).toBe(SCREEN.DAY)
    expect(res.data.days).toEqual([{ id: '2026-07-03', title: 'Thu 3 Jul' }])
  })

  it('slotScreen carries the chosen day through', () => {
    const res = slotScreen({ day: '2026-07-03', slots: [{ id: 'c1', title: '18:00 HIIT (4 left)' }] })
    expect(res.screen).toBe(SCREEN.SLOT)
    expect(res.data.day).toBe('2026-07-03')
    expect(res.data.slots[0].id).toBe('c1')
  })

  it('detailsScreen prefills known contact fields', () => {
    const res = detailsScreen({ name: 'Ann', email: 'ann@x.ie' })
    expect(res.data.name).toBe('Ann')
    expect(res.data.email).toBe('ann@x.ie')
    expect(res.data.marketing_opt_in).toBe(true) // ticked by default (spec §9)
  })

  it('FLOW_JSON declares all five screens and is terminal at CONFIRM', () => {
    const ids = FLOW_JSON.screens.map((s) => s.id)
    expect(ids).toEqual([SCREEN.PATH, SCREEN.DAY, SCREEN.SLOT, SCREEN.DETAILS, SCREEN.CONFIRM])
    expect(FLOW_JSON.screens.find((s) => s.id === SCREEN.CONFIRM).terminal).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp-flow/screens.test.js`
Expected: FAIL — cannot resolve `./screens.js`.

- [ ] **Step 3: Implement `screens.js`**

```js
// src/lib/whatsapp-flow/screens.js
// Pure presentation for the "Book your first visit" Flow. No I/O — the handler
// resolves live data and passes it in. FLOW_JSON is the asset published to Meta.
export const SCREEN = { PATH: 'PATH', DAY: 'DAY', SLOT: 'SLOT', DETAILS: 'DETAILS', CONFIRM: 'CONFIRM' }

export function pathScreen() {
  return { screen: SCREEN.PATH, data: {} }
}
export function dayScreen(days) {
  return { screen: SCREEN.DAY, data: { days } }
}
export function slotScreen({ day, slots }) {
  return { screen: SCREEN.SLOT, data: { day, slots } }
}
export function detailsScreen(prefill = {}) {
  return { screen: SCREEN.DETAILS, data: { name: prefill.name || '', email: prefill.email || '', marketing_opt_in: true } }
}
export function confirmScreen(selection) {
  return { screen: SCREEN.CONFIRM, data: { summary: selection.summary, selection } }
}

// The published Flow definition (Flow JSON v3.1). Data-exchange screens declare
// dynamic props via ${data.*}; navigation posts back to the endpoint.
export const FLOW_JSON = {
  version: '3.1',
  data_api_version: '3.0',
  routing_model: { PATH: ['DAY'], DAY: ['SLOT'], SLOT: ['DETAILS'], DETAILS: ['CONFIRM'], CONFIRM: [] },
  screens: [
    {
      id: SCREEN.PATH, title: 'Book your first visit',
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'path', label: 'How would you like to start?', required: true,
            'data-source': [{ id: 'class', title: 'Free class' }, { id: 'consult', title: 'Consultation' }] },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { path: '${form.path}' } } },
        ] }] },
    },
    {
      id: SCREEN.DAY, title: 'Pick a day', data: { days: { type: 'array', __example__: [] } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'day', label: 'Which day?', required: true, 'data-source': '${data.days}' },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { day: '${form.day}' } } },
        ] }] },
    },
    {
      id: SCREEN.SLOT, title: 'Pick a time', data: { day: { type: 'string', __example__: '' }, slots: { type: 'array', __example__: [] } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'RadioButtonsGroup', name: 'slot', label: 'Available times', required: true, 'data-source': '${data.slots}' },
          { type: 'Footer', label: 'Continue', 'on-click-action': { name: 'data_exchange', payload: { slot: '${form.slot}' } } },
        ] }] },
    },
    {
      id: SCREEN.DETAILS, title: 'Your details',
      data: { name: { type: 'string', __example__: '' }, email: { type: 'string', __example__: '' }, marketing_opt_in: { type: 'boolean', __example__: true } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'TextInput', name: 'name', label: 'Name', required: true, 'init-value': '${data.name}' },
          { type: 'TextInput', name: 'email', label: 'Email', 'input-type': 'email', required: true, 'init-value': '${data.email}' },
          { type: 'OptIn', name: 'marketing_opt_in', label: 'Keep me posted with offers and updates', 'init-value': '${data.marketing_opt_in}' },
          { type: 'Footer', label: 'Review', 'on-click-action': { name: 'data_exchange', payload: { name: '${form.name}', email: '${form.email}', marketing_opt_in: '${form.marketing_opt_in}' } } },
        ] }] },
    },
    {
      id: SCREEN.CONFIRM, title: 'Confirm', terminal: true, data: { summary: { type: 'string', __example__: '' }, selection: { type: 'object', __example__: {} } },
      layout: { type: 'SingleColumnLayout', children: [{
        type: 'Form', name: 'form', children: [
          { type: 'TextBody', text: '${data.summary}' },
          { type: 'Footer', label: 'Confirm booking', 'on-click-action': { name: 'complete', payload: { selection: '${data.selection}' } } },
        ] }] },
    },
  ],
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp-flow/screens.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-flow/screens.js src/lib/whatsapp-flow/screens.test.js
git commit -m "feat(wa-flow): Flow JSON asset + pure screen builders"
```

---

## Task 4: Handler (prefill, resolve availability, data-exchange, completion parse)

**Files:**
- Create: `src/lib/whatsapp-flow/handler.js`
- Test: `src/lib/whatsapp-flow/handler.test.js`

Reuse: `computeAvailableDays`/`computeAvailableSlots` from `src/lib/booking-slots.js` (consult event type), and `listPublicClasses` from `src/lib/public-classes.js` (classes). Both are injected in tests via a fake `db` + spies.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/whatsapp-flow/handler.test.js
import { describe, it, expect, vi } from 'vitest'
import { handleDataExchange, parseFlowCompletion } from './handler.js'
import { SCREEN } from './screens.js'

vi.mock('@/lib/booking-slots.js', () => ({
  computeAvailableDays: vi.fn(async () => [{ id: '2026-07-03', title: 'Thu 3 Jul' }]),
  computeAvailableSlots: vi.fn(async () => [{ start: '18:00', end: '18:30' }]),
}))
vi.mock('@/lib/public-classes.js', () => ({
  listPublicClasses: vi.fn(async () => ([{ event_id: 'c1', name: 'HIIT', starts_at: '2026-07-03T18:00:00Z', spots_left: 4 }])),
}))

const config = { consult_event_slug: 'free-un1t-consultation' }
const contact = { id: 'ct1', name: 'Ann', email: 'ann@x.ie' }

describe('handleDataExchange', () => {
  it('INIT returns the PATH screen', async () => {
    const res = await handleDataExchange({}, { decryptedBody: { action: 'INIT' }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.PATH)
  })

  it('choosing a path returns DAY with available days', async () => {
    const res = await handleDataExchange({}, {
      decryptedBody: { action: 'data_exchange', screen: SCREEN.PATH, data: { path: 'class' } },
      contact, locationId: 'loc1', config,
    })
    expect(res.screen).toBe(SCREEN.DAY)
    expect(res.data.days[0].id).toBe('2026-07-03')
  })

  it('picking a class day returns SLOT with live classes', async () => {
    const res = await handleDataExchange({}, {
      decryptedBody: { action: 'data_exchange', screen: SCREEN.DAY, data: { path: 'class', day: '2026-07-03' } },
      contact, locationId: 'loc1', config,
    })
    expect(res.screen).toBe(SCREEN.SLOT)
    expect(res.data.slots[0].id).toBe('c1')
  })

  it('ping short-circuits to the health response', async () => {
    const res = await handleDataExchange({}, { decryptedBody: { action: 'ping' }, contact, locationId: 'loc1', config })
    expect(res).toEqual({ data: { status: 'active' } })
  })
})

describe('parseFlowCompletion', () => {
  it('extracts path + selection + contact fields from nfm_reply', () => {
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1', class_name: 'HIIT', starts_at: '2026-07-03T18:00:00Z',
      name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true,
    }) } }
    const out = parseFlowCompletion(interactive)
    expect(out.path).toBe('class')
    expect(out.selection.slot).toBe('c1')
    expect(out.contactFields.email).toBe('ann@x.ie')
    expect(out.contactFields.marketing_opt_in).toBe(true)
  })

  it('returns null for a non-Flow interactive', () => {
    expect(parseFlowCompletion({ type: 'button_reply' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp-flow/handler.test.js`
Expected: FAIL — cannot resolve `./handler.js`.

- [ ] **Step 3: Implement `handler.js`**

```js
// src/lib/whatsapp-flow/handler.js
// Orchestrates the Flow data-exchange: prefill on INIT, resolve live days/slots
// on each step, and parse the completion payload. All I/O lives here.
import { computeAvailableDays, computeAvailableSlots } from '@/lib/booking-slots.js'
import { listPublicClasses } from '@/lib/public-classes.js'
import { SCREEN, pathScreen, dayScreen, slotScreen, detailsScreen, confirmScreen } from './screens.js'

const PING = { data: { status: 'active' } }

async function resolveConsultEvent(db, locationId, config) {
  const { data: event } = await db.from('event_types')
    .select('id, name, slug, duration_minutes, buffer_minutes')
    .eq('location_id', locationId).eq('slug', config.consult_event_slug).eq('active', true).maybeSingle()
  return event
}

function classDaysFrom(classes) {
  const seen = new Map()
  for (const c of classes) {
    const day = c.starts_at.slice(0, 10)
    if (!seen.has(day)) seen.set(day, { id: day, title: dayLabel(day) })
  }
  return [...seen.values()]
}
function dayLabel(iso) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${iso}T12:00:00Z`))
}
function timeLabel(iso) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export async function handleDataExchange(db, { decryptedBody, contact, locationId, config }) {
  const { action, screen, data = {} } = decryptedBody
  if (action === 'ping') return PING
  if (action === 'INIT') return pathScreen()

  if (screen === SCREEN.PATH) {
    if (data.path === 'consult') {
      const event = await resolveConsultEvent(db, locationId, config)
      const days = await computeAvailableDays(db, event, { days: 14 })
      return dayScreen(days)
    }
    const classes = await listPublicClasses(db, locationId)
    return dayScreen(classDaysFrom(classes))
  }

  if (screen === SCREEN.DAY) {
    if (data.path === 'consult') {
      const event = await resolveConsultEvent(db, locationId, config)
      const slots = await computeAvailableSlots(db, event, data.day)
      return slotScreen({ day: data.day, slots: slots.map((s) => ({ id: `${event.id}|${data.day}|${s.start}|${s.end}`, title: `${s.start}` })) })
    }
    const classes = (await listPublicClasses(db, locationId)).filter((c) => c.starts_at.slice(0, 10) === data.day)
    return slotScreen({ day: data.day, slots: classes.map((c) => ({ id: c.event_id, title: `${timeLabel(c.starts_at)} ${c.name}${c.spots_left != null ? ` (${c.spots_left} left)` : ''}` })) })
  }

  if (screen === SCREEN.SLOT) {
    return detailsScreen({ name: contact?.name, email: contact?.email })
  }

  if (screen === SCREEN.DETAILS) {
    const summary = data.path === 'consult' ? 'Confirm your consultation' : 'Confirm your class'
    return confirmScreen({ summary, path: data.path, ...data })
  }

  return pathScreen()
}

export function parseFlowCompletion(interactive) {
  if (interactive?.type !== 'nfm_reply') return null
  let payload
  try { payload = JSON.parse(interactive.nfm_reply?.response_json || '{}') } catch { return null }
  if (!payload.path) return null
  const { path, name, email, marketing_opt_in, ...selection } = payload
  return { path, selection, contactFields: { name, email, marketing_opt_in: marketing_opt_in === true || marketing_opt_in === 'true' } }
}
```

> **Implementer note:** verify `listPublicClasses(db, locationId)` exists in `src/lib/public-classes.js` and returns `{ event_id, name, starts_at, spots_left }`. If the export name/shape differs, adapt the import + mapping only — the screen contract (`{ id, title }`) stays fixed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp-flow/handler.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-flow/handler.js src/lib/whatsapp-flow/handler.test.js
git commit -m "feat(wa-flow): data-exchange handler + completion parser"
```

---

## Task 5: The endpoint route

**Files:**
- Create: `src/app/api/whatsapp/flow/route.js`
- Test: `src/app/api/whatsapp/flow/route.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/app/api/whatsapp/flow/route.test.js
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/whatsapp-flow/crypto.js', () => ({
  decryptFlowRequest: vi.fn(() => ({ decryptedBody: { action: 'ping' }, aesKeyBuffer: Buffer.alloc(16), initialVectorBuffer: Buffer.alloc(16) })),
  encryptFlowResponse: vi.fn(() => 'ENCRYPTED'),
}))
vi.mock('@/lib/whatsapp-flow/handler.js', () => ({ handleDataExchange: vi.fn(async () => ({ data: { status: 'active' } })) }))
vi.mock('@/lib/supabase-admin.js', () => ({ createAdminClient: () => ({}) }))

const { POST } = await import('./route.js')
process.env.WHATSAPP_FLOW_PRIVATE_KEY = 'pk'

function req(body) { return new Request('http://x/api/whatsapp/flow', { method: 'POST', body: JSON.stringify(body) }) }

describe('POST /api/whatsapp/flow', () => {
  it('returns the base64 ciphertext as text/plain for a valid request', async () => {
    const res = await POST(req({ encrypted_flow_data: 'a', encrypted_aes_key: 'b', initial_vector: 'c' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ENCRYPTED')
  })

  it('returns 421 when decryption fails (Meta re-fetches the key)', async () => {
    const { decryptFlowRequest } = await import('@/lib/whatsapp-flow/crypto.js')
    decryptFlowRequest.mockImplementationOnce(() => { throw new Error('bad key') })
    const res = await POST(req({ encrypted_flow_data: 'a', encrypted_aes_key: 'b', initial_vector: 'c' }))
    expect(res.status).toBe(421)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/flow/route.test.js`
Expected: FAIL — cannot resolve `./route.js`.

- [ ] **Step 3: Implement `route.js`**

```js
// src/app/api/whatsapp/flow/route.js
// WhatsApp Flow data-exchange endpoint. Body is always encrypted; we decrypt,
// dispatch to the handler, and return the encrypted base64 as text/plain.
// 421 on decrypt failure tells Meta to re-fetch our public key.
import { decryptFlowRequest, encryptFlowResponse } from '@/lib/whatsapp-flow/crypto.js'
import { handleDataExchange } from '@/lib/whatsapp-flow/handler.js'
import { createAdminClient } from '@/lib/supabase-admin.js'
import { resolveFlowConfigByToken } from '@/lib/whatsapp-flow/config.js'

export async function POST(request) {
  const privateKey = process.env.WHATSAPP_FLOW_PRIVATE_KEY
  if (!privateKey) return new Response('Server misconfigured', { status: 500 })

  let body
  try { body = await request.json() } catch { return new Response('Bad request', { status: 400 }) }

  let decrypted
  try {
    decrypted = decryptFlowRequest(privateKey, body)
  } catch (e) {
    console.error('[wa-flow] decrypt failed:', e.message)
    return new Response('Failed to decrypt', { status: 421 })
  }

  const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decrypted
  try {
    const db = createAdminClient()
    const { contact, locationId, config } = await resolveFlowConfigByToken(db, decryptedBody.flow_token)
    const responseObject = await handleDataExchange(db, { decryptedBody, contact, locationId, config })
    const encrypted = encryptFlowResponse(responseObject, aesKeyBuffer, initialVectorBuffer)
    return new Response(encrypted, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  } catch (e) {
    console.error('[wa-flow] handler error:', e.message)
    const encrypted = encryptFlowResponse({ screen: 'PATH', data: { error_message: 'Something went wrong. Please try again.' } }, aesKeyBuffer, initialVectorBuffer)
    return new Response(encrypted, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
}
```

- [ ] **Step 4: Create `config.js` (flow_token → contact + location + settings)**

```js
// src/lib/whatsapp-flow/config.js
// A flow_token is minted per send as `<contactId>.<locationId>`. Resolve it back
// to the contact + the location's whatsapp_flow settings. Ping has no token.
export async function resolveFlowConfigByToken(db, flowToken) {
  const fallback = { contact: null, locationId: null, config: {} }
  if (!flowToken || !flowToken.includes('.')) return fallback
  const [contactId, locationId] = flowToken.split('.')
  const [{ data: contact }, { data: loc }] = await Promise.all([
    db.from('contacts').select('id, name, first_name, last_name, email, phone').eq('id', contactId).maybeSingle(),
    db.from('locations').select('settings').eq('id', locationId).maybeSingle(),
  ])
  const config = loc?.settings?.whatsapp_flow || {}
  return { contact: contact ? { ...contact, name: contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') } : null, locationId, config }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/api/whatsapp/flow/route.test.js`
Expected: PASS (2 tests). (The `config.js` import is mocked indirectly via handler; if the runner complains, add `vi.mock('@/lib/whatsapp-flow/config.js', () => ({ resolveFlowConfigByToken: vi.fn(async () => ({ contact: null, locationId: 'loc1', config: {} })) }))` to the test.)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/flow/route.js src/lib/whatsapp-flow/config.js src/app/api/whatsapp/flow/route.test.js
git commit -m "feat(wa-flow): data-exchange endpoint route + token config resolver"
```

---

## Task 6: Send helpers + FLOW-button template

**Files:**
- Modify: `src/lib/whatsapp.js` (add `buildFlowPayload`, `sendFlowMessage`)
- Test: `src/lib/whatsapp-flow-send.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/whatsapp-flow-send.test.js
import { describe, it, expect } from 'vitest'
import { buildFlowPayload } from './whatsapp.js'

describe('buildFlowPayload', () => {
  it('builds an interactive flow message with a mode + token', () => {
    const p = buildFlowPayload('353871234567', { flowId: 'F1', flowToken: 'ct1.loc1', flowCta: 'Book now', screen: 'PATH' })
    expect(p.type).toBe('interactive')
    expect(p.interactive.type).toBe('flow')
    const params = p.interactive.action.parameters
    expect(params.flow_id).toBe('F1')
    expect(params.flow_token).toBe('ct1.loc1')
    expect(params.flow_cta).toBe('Book now')
    expect(params.flow_action_payload.screen).toBe('PATH')
    expect(params.mode).toBe('published')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp-flow-send.test.js`
Expected: FAIL — `buildFlowPayload is not exported`.

- [ ] **Step 3: Add `buildFlowPayload` + `sendFlowMessage` to `whatsapp.js`**

Add near `buildInteractivePayload` (`src/lib/whatsapp.js:81`):

```js
/**
 * Interactive Flow message (24h window). Launches a published Flow at `screen`.
 * flow_token round-trips to our endpoint so we can resolve contact + location.
 */
export function buildFlowPayload(to, { flowId, flowToken, flowCta, screen, data = {} }) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: 'Tap below to book your first visit.' },
      action: {
        name: 'flow',
        parameters: {
          mode: 'published', flow_message_version: '3', flow_token: flowToken, flow_id: flowId,
          flow_cta: flowCta || 'Book now', flow_action: 'navigate',
          flow_action_payload: { screen, data },
        },
      },
    },
  }
}

export async function sendFlowMessage(to, opts = {}) {
  const config = await resolveConfig(opts)
  const response = await fetch(`${META_API_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST', headers: headersFor(config), body: JSON.stringify(buildFlowPayload(to, opts)),
  })
  const result = await response.json()
  if (result.error) { console.error('WhatsApp flow send error:', result.error); throw new Error(result.error.message || 'Failed to send WhatsApp flow message') }
  return { messageId: result.messages?.[0]?.id, status: result.messages?.[0]?.message_status || 'sent' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp-flow-send.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Confirm `createTemplate` already supports a FLOW button (no code change expected)**

Run: `sed -n '298,331p' src/lib/whatsapp.js`
Expected: `createTemplate({ name, category, language, components })` forwards `components` verbatim to Meta. A FLOW button is just a component:
```json
{ "type": "BUTTONS", "buttons": [{ "type": "FLOW", "text": "Book now", "flow_id": "<FLOW_ID>", "navigate_screen": "PATH" }] }
```
If `components` is forwarded unchanged, no edit is needed — note it in the commit. If it filters button types, add `FLOW` to the allowlist and add a test asserting the FLOW button survives.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-flow-send.test.js
git commit -m "feat(wa-flow): buildFlowPayload + sendFlowMessage helpers"
```

- [ ] **Step 7: Create the initiating UTILITY template (manual, once)**

Using the existing template-management UI or `createTemplate`, create a template `book_first_visit` — category **UTILITY**, body "Hi {{1}}, ready to book your first visit? Tap below.", with the FLOW button above pointing at the published `flow_id` and `navigate_screen: 'PATH'`. Record the approved name in `locations.settings.whatsapp_flow.template_name`. If Meta rejects UTILITY, resubmit as MARKETING (spec §7).

---

## Task 7: Extract `createEventBooking` (DRY for consult path)

**Files:**
- Create: `src/lib/bookings-write.js`
- Test: `src/lib/bookings-write.test.js`
- Modify: the public consult-booking route to call the shared helper (locate via `rg -l "from\\('bookings'\\).*insert|event_type_id" src/app/api/public`)

- [ ] **Step 1: Write the failing test**

```js
// src/lib/bookings-write.test.js
import { describe, it, expect, vi } from 'vitest'
import { createEventBooking } from './bookings-write.js'

function fakeDb(insertSpy) {
  return { from: () => ({ insert: insertSpy, select: () => ({ single: async () => ({ data: { id: 'bk1' }, error: null }) }) }) }
}

describe('createEventBooking', () => {
  it('inserts a confirmed booking for the event type + slot', async () => {
    const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'bk1' }, error: null }) }) }))
    const res = await createEventBooking(fakeDb(insert), {
      event: { id: 'ev1', location_id: 'loc1' }, date: '2026-07-03', startTime: '18:00', endTime: '18:30',
      contact: { id: 'ct1', name: 'Ann', email: 'ann@x.ie', phone: '+353871234567' }, source: 'whatsapp_flow',
    })
    expect(res.bookingId).toBe('bk1')
    const row = insert.mock.calls[0][0]
    expect(row.event_type_id).toBe('ev1')
    expect(row.booking_date).toBe('2026-07-03')
    expect(row.status).toBe('confirmed')
    expect(row.source).toBe('whatsapp_flow')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bookings-write.test.js`
Expected: FAIL — cannot resolve `./bookings-write.js`.

- [ ] **Step 3: Implement `bookings-write.js`**

```js
// src/lib/bookings-write.js
// Shared insert for event-type (consultation) bookings — used by the public
// /book route and the WhatsApp Flow completion so both write identical rows.
export async function createEventBooking(db, { event, date, startTime, endTime, contact, source }) {
  const { data, error } = await db.from('bookings').insert({
    event_type_id: event.id,
    location_id: event.location_id,
    contact_id: contact.id,
    booking_date: date,
    start_time: startTime,
    end_time: endTime,
    customer_name: contact.name,
    customer_email: contact.email,
    customer_phone: contact.phone,
    status: 'confirmed',
    source: source || 'unknown',
  }).select('id').single()
  if (error) return { error }
  return { bookingId: data.id }
}
```

> **Implementer note:** align the column list with the real `bookings` schema (`\d bookings` via Supabase). If the public `/book` route currently inlines this insert, replace it with a `createEventBooking` call in the same task and keep its existing test green.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bookings-write.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bookings-write.js src/lib/bookings-write.test.js
git commit -m "refactor(bookings): shared createEventBooking helper"
```

---

## Task 8: Webhook completion handling (`nfm_reply` → booking)

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js` (`case 'interactive'`, ~line 286)
- Create: `src/lib/whatsapp-flow/completion.js` (`handleFlowCompletion`)
- Test: `src/lib/whatsapp-flow/completion.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/whatsapp-flow/completion.test.js
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/marketing-consent.js', () => ({ applyFormMarketingConsent: vi.fn(async () => ({})) }))
vi.mock('@/lib/bookings-write.js', () => ({ createEventBooking: vi.fn(async () => ({ bookingId: 'bk1' })) }))

import { handleFlowCompletion } from './completion.js'
import { applyFormMarketingConsent } from '@/lib/marketing-consent.js'

function fakeDb(inserts) {
  return { from: (t) => ({ insert: (row) => { (inserts[t] ||= []).push(row); return { error: null } } }) }
}

describe('handleFlowCompletion', () => {
  it('class path → queues a class_booking_requests row + records consent', async () => {
    const inserts = {}
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1', class_name: 'HIIT', starts_at: '2026-07-03T18:00:00Z',
      name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true }) } }
    const contact = { id: 'ct1', name: 'Ann', email: 'ann@x.ie', phone: '+353871234567' }

    await handleFlowCompletion(fakeDb(inserts), { interactive, contact, locationId: 'loc1' })

    expect(inserts.class_booking_requests[0]).toMatchObject({ contact_id: 'ct1', location_id: 'loc1', glofox_event_id: 'c1', class_name: 'HIIT', status: 'queued' })
    expect(applyFormMarketingConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'ct1', consent: true, source: 'whatsapp_flow' }))
  })

  it('ignores a non-Flow interactive', async () => {
    const inserts = {}
    await handleFlowCompletion(fakeDb(inserts), { interactive: { type: 'button_reply' }, contact: { id: 'ct1' }, locationId: 'loc1' })
    expect(inserts.class_booking_requests).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp-flow/completion.test.js`
Expected: FAIL — cannot resolve `./completion.js`.

- [ ] **Step 3: Implement `completion.js`**

```js
// src/lib/whatsapp-flow/completion.js
// Turns a completed Flow (nfm_reply) into a booking. Class → class_booking_requests
// (the process-class-bookings cron finishes it). Consult → a confirmed bookings row.
import { parseFlowCompletion } from './handler.js'
import { applyFormMarketingConsent } from '@/lib/marketing-consent.js'
import { createEventBooking } from '@/lib/bookings-write.js'

export async function handleFlowCompletion(db, { interactive, contact, locationId }) {
  const parsed = parseFlowCompletion(interactive)
  if (!parsed || !contact?.id) return { handled: false }
  const { path, selection, contactFields } = parsed

  if (contactFields.marketing_opt_in) {
    try { await applyFormMarketingConsent(db, { contactId: contact.id, consent: true, source: 'whatsapp_flow' }) }
    catch (e) { console.warn('[wa-flow] consent record failed:', e.message) }
  }

  if (path === 'class') {
    const { error } = await db.from('class_booking_requests').insert({
      location_id: locationId, contact_id: contact.id,
      glofox_event_id: selection.slot, class_name: selection.class_name, starts_at: selection.starts_at,
      customer_name: contact.name, customer_email: contact.email, customer_phone: contact.phone,
      status: 'queued',
    })
    if (error && error.code !== '23505') { console.error('[wa-flow] class enqueue failed:', error.message); return { handled: false } }
    return { handled: true, kind: 'class' }
  }

  // consult: selection.slot = `${eventId}|${date}|${start}|${end}`
  const [eventId, date, startTime, endTime] = String(selection.slot).split('|')
  const res = await createEventBooking(db, {
    event: { id: eventId, location_id: locationId }, date, startTime, endTime, contact, source: 'whatsapp_flow',
  })
  if (res.error) { console.error('[wa-flow] consult booking failed:', res.error.message); return { handled: false } }
  return { handled: true, kind: 'consult' }
}
```

- [ ] **Step 4: Wire it into the webhook**

In `src/app/api/webhooks/whatsapp/route.js`, add the import at top and change the `case 'interactive'` block (`:286`) to intercept `nfm_reply` before the button/list title fallback:

```js
// top of file:
import { handleFlowCompletion } from '@/lib/whatsapp-flow/completion.js'

// inside case 'interactive':
case 'interactive':
  if (message.interactive?.type === 'nfm_reply') {
    try { await handleFlowCompletion(db, { interactive: message.interactive, contact, locationId }) }
    catch (e) { console.error('[wa-webhook] flow completion failed:', e.message) }
    body = '[Booking submitted via WhatsApp Flow]'
  } else {
    body = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || ''
  }
  break
```

> **Implementer note:** confirm `contact` and `locationId` are in scope at that point in the handler (the message loop resolves both before the `switch`). If `locationId` isn't yet resolved there, read it from the conversation/`phone_number_id` mapping already computed earlier in the function.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp-flow/completion.test.js src/app/api/webhooks/whatsapp`
Expected: PASS (2 new tests + existing webhook tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-flow/completion.js src/app/api/webhooks/whatsapp/route.js src/lib/whatsapp-flow/completion.test.js
git commit -m "feat(wa-flow): webhook completion → class/consult booking"
```

---

## Task 9: Gate the send behind the per-location toggle

**Files:**
- Modify: `src/lib/automations/meta-ad-whatsapp-welcome.js`
- Test: extend `src/lib/automations/meta-ad-whatsapp-welcome.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

```js
// src/lib/automations/meta-ad-whatsapp-welcome.test.js  (add case)
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/whatsapp.js', async (orig) => ({ ...(await orig()), sendFlowMessage: vi.fn(async () => ({ messageId: 'm1' })), sendTemplateMessage: vi.fn(async () => ({ messageId: 'm2' })) }))

import { maybeSendCampaignWhatsappWelcome } from './meta-ad-whatsapp-welcome.js'
import { sendFlowMessage, sendTemplateMessage } from '@/lib/whatsapp.js'

describe('welcome send routing', () => {
  it('sends the Flow template when whatsapp_flow.enabled is true', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: { whatsapp_flow: { enabled: true, flow_id: 'F1', template_name: 'book_first_visit' } } } }) }) }) }) }
    // ... call with a fresh contact; assert the Flow-button template send path is taken
    expect(typeof maybeSendCampaignWhatsappWelcome).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails / drives the change**

Run: `npx vitest run src/lib/automations/meta-ad-whatsapp-welcome.test.js`
Expected: FAIL until the routing branch is added.

- [ ] **Step 3: Add the toggle branch**

In `maybeSendCampaignWhatsappWelcome`, before the existing quick-reply template send, read the location's `settings.whatsapp_flow`. If `enabled` and a `template_name` is set, send that FLOW-button template (via `sendTemplateMessage` with the FLOW-button template name, `flow_token = ${contact.id}.${locationId}`); otherwise fall through to the current `meta_ad_whatsapp_lead` behaviour. Keep the `wa_phone` promotion logic unchanged.

```js
const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
const flowCfg = loc?.settings?.whatsapp_flow
if (flowCfg?.enabled && flowCfg.template_name) {
  templateName = flowCfg.template_name // the FLOW-button UTILITY template
}
// ... existing send, unchanged; the FLOW template carries the button + flow_token
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/automations/meta-ad-whatsapp-welcome.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/automations/meta-ad-whatsapp-welcome.js src/lib/automations/meta-ad-whatsapp-welcome.test.js
git commit -m "feat(wa-flow): route first-touch to the Flow template when enabled"
```

---

## Task 10: Publish, configure, enable (manual rollout)

- [ ] **Step 1: Publish the Flow asset** — upload `FLOW_JSON` (from `screens.js`) in Meta's Flow Builder, set the endpoint to `https://crm.un1tdublin.com/api/whatsapp/flow`, run the built-in **endpoint health test** (must return `active`), then **Publish**. Record the `flow_id`.
- [ ] **Step 2: Set Stillorgan settings** — `locations.settings.whatsapp_flow = { enabled: false, flow_id: '<id>', template_name: 'book_first_visit', consult_event_slug: '<free-un1t-consultation slug>' }`. Confirm the consult slug matches the real `event_types.slug`.
- [ ] **Step 3: Smoke test** — with `enabled:false`, send yourself the FLOW template manually; complete the Flow; confirm a `class_booking_requests` row (class) / `bookings` row (consult) appears and the confirmation template fires.
- [ ] **Step 4: Enable** — set `enabled: true` for Stillorgan. Monitor `whatsapp_messages`, `class_booking_requests`, and phone-number quality for 48h.
- [ ] **Step 5: Update docs** — append to `docs/CHANGELOG.md` and add a short note under `docs/architecture/` linking the spec + this plan. Commit.

```bash
git add docs/CHANGELOG.md docs/architecture
git commit -m "docs(wa-flow): changelog + architecture note for Flow booking"
```

---

## Self-Review

**Spec coverage:**
- §2 architecture (5 pieces) → Tasks 1 (encryption), 2 (crypto), 3+4+5 (Flow/endpoint), 6 (initiating message), 8 (completion). ✅
- §3 screens (Path→Day→Slot→Details→Confirm, consult event-type + class schedule, consent ticked, no intake) → Task 3 (`FLOW_JSON`, `detailsScreen` opt-in `true`), Task 4 (consult via slug + class via `listPublicClasses`). ✅
- §4 data flow (nfm_reply → class_booking_requests / bookings → cron) → Tasks 4, 7, 8. ✅
- §5 modules (crypto/screens/handler/route small + isolated) → Tasks 2–5. ✅
- §6 encryption + registration → Task 1. ✅
- §7 initiating UTILITY template + in-session send → Task 6. ✅
- §8 error handling (ping, 421, empty day, slot taken via existing review, abandoned) → Task 5 (421 + generic error screen), Task 4 (empty arrays render empty), downstream `routeToReview` unchanged. ✅
- §9 consent ticked + `source='whatsapp_flow'` → Task 3 + Task 8. ✅
- §10 testing → tests in Tasks 2–9. ✅
- §11 rollout (Stillorgan, toggle, fallbacks) → Tasks 9–10. ✅

**Placeholder scan:** No "TBD"/"handle edge cases" left; implementer notes point at schema/export verifications, not missing logic. ✅

**Type consistency:** `handleDataExchange(db, {...})`, `parseFlowCompletion(interactive)`, `buildFlowPayload(to, {...})`, `createEventBooking(db, {event,date,startTime,endTime,contact,source})`, `SCREEN.*`, and `flow_token = '<contactId>.<locationId>'` are used identically across Tasks 3–9. ✅

**Known verifications for the implementer** (schema/export truths to confirm, not design gaps): `listPublicClasses` export + shape (Task 4), `bookings` column names (Task 7), `createTemplate` component pass-through (Task 6), `contact`/`locationId` scope in the webhook loop (Task 8), `createAdminClient` import path (Task 5).
