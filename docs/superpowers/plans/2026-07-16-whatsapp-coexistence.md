# WhatsApp Coexistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client already on the WhatsApp Business *app* link that number to the Cloud API (coexistence) through the existing Embedded Signup Connect flow — number stays live on their phone, CRM sends/receives and mirrors phone-side activity.

**Architecture:** Extends the shipped ES infra (PR #921). A `mode` branch on the existing exchange route; three new webhook handlers (echoes/contact-sync/history); a second Connect button. Pure logic lives in new libs (`whatsapp-coexistence.js`, `whatsapp-coexistence-ingest.js`) so it's fully unit-tested against fixtures before Meta approval. The live inbound path (`handleIncomingMessage`) is NOT refactored — the coexistence ingest helpers are self-contained to keep that path untouched.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role), Zod, Vitest (pure-lib, mocked), Graph API v21 (`META_API_URL` from `whatsapp-config.js`), Facebook JS SDK (client, on demand).

**Spec:** `docs/superpowers/specs/2026-07-16-whatsapp-coexistence-design.md`. **Worktree:** `~/code/un1t-crm-coex`, branch `whatsapp-coexistence-v2`.

**Repo conventions (executor MUST follow):** supabase-js builders are thenables (`try/await/catch`, never `.catch()`); every insert/update awaited; response shape `{ success, data?, error? }`; no new `console.log` in prod paths (`console.warn`/`.error` OK); webhook handlers idempotent + always 200; zsh single-quotes bracketed `[id]` paths; branch is off fresh `origin/main`.

**Verified facts this plan builds on:**
- Exchange route: `src/app/api/locations/[id]/whatsapp/embedded-signup/route.js` — POST does exchange → ownership/409 → `subscribeAppToWaba` → probe → conditional `registerNumber` → persist. `guardMasterOrOwner` is imported from `@/lib/auth`.
- ES lib exports: `exchangeCodeForBusinessToken, subscribeAppToWaba, probeNumber, needsRegistration, generatePin, registerNumber, planPersistence, buildSignupMeta` in `src/lib/whatsapp-embedded-signup.js`.
- Webhook dispatch: `src/app/api/webhooks/whatsapp/route.js` checks `NUMBER_EVENT_FIELDS` / `FLOW_EVENT_FIELDS` / `user_preferences`, then `if (change.field !== 'messages') continue`. Idempotency via `recordWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.WHATSAPP, eventId })`.
- `whatsapp_messages` insert columns: `conversation_id, contact_id, location_id, wa_message_id, direction, message_type, body, media_external_id, media_mime_type, status, sent_at`. Unique index on `wa_message_id`.
- `whatsapp_conversations` insert columns: `location_id, contact_id, wa_phone, wa_profile_name, status, ctwa_clid`.
- Contact match (in `handleIncomingMessage`): `.or(\`wa_phone.eq.${without},wa_phone.eq.${withPlus},phone.eq.${without},phone.eq.${withPlus}\`)`; `wa_phone` stored WITHOUT `+`.
- `whatsapp_numbers.source` CHECK already allows `'coexistence'` (mig 176). `signup_meta` JSONB exists (mig 405).
- Test mock-db pattern: see `src/lib/whatsapp-config.test.js` (`mockDb`, `globalThis.fetch` swap).

---

## CX.1 — Exchange branch (backend core)

### Task 1: `getWabaPhoneNumber` + `initialHistorySyncState` lib helpers

**Files:**
- Modify: `src/lib/whatsapp-embedded-signup.js`
- Test: `src/lib/whatsapp-embedded-signup.test.js` (append)

- [ ] **Step 1: Write failing tests** (append)

```js
import {
  getWabaPhoneNumber, initialHistorySyncState,
} from './whatsapp-embedded-signup.js'

describe('getWabaPhoneNumber', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  function mockFetch(json) {
    const calls = []
    globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { json: async () => json } }
    return calls
  }
  it('returns the first phone number id + display number for the WABA', async () => {
    const calls = mockFetch({ data: [{ id: '109998', display_phone_number: '+353 1 555 0000', verified_name: 'UN1T Hatch' }] })
    const out = await getWabaPhoneNumber({ wabaId: '555', token: 'T' })
    expect(out).toEqual({ phoneNumberId: '109998', displayPhone: '+353 1 555 0000', verifiedName: 'UN1T Hatch' })
    expect(calls[0].url).toContain('/555/phone_numbers')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer T')
  })
  it('throws with meta metadata on error', async () => {
    mockFetch({ error: { message: 'no access', code: 10, type: 'OAuthException' } })
    await expect(getWabaPhoneNumber({ wabaId: '5', token: 'T' })).rejects.toMatchObject({ message: 'no access', metaCode: 10 })
  })
  it('throws when the WABA has no phone numbers', async () => {
    mockFetch({ data: [] })
    await expect(getWabaPhoneNumber({ wabaId: '5', token: 'T' })).rejects.toThrow(/no phone number/i)
  })
})

describe('initialHistorySyncState', () => {
  it('returns a pending state stamped with the given time', () => {
    expect(initialHistorySyncState('2026-07-16T10:00:00.000Z')).toEqual({ status: 'pending', started_at: '2026-07-16T10:00:00.000Z' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/code/un1t-crm-coex && npx vitest run src/lib/whatsapp-embedded-signup.test.js
```
Expected: FAIL — `getWabaPhoneNumber`/`initialHistorySyncState` not exported.

- [ ] **Step 3: Implement** (append to `src/lib/whatsapp-embedded-signup.js`)

```js
/**
 * Coexistence: read the phone number already registered on the client's
 * WABA. Unlike Cloud API onboarding, the phone_number_id isn't minted by us
 * — the number is already live on the WhatsApp Business app, so we read it
 * off the WABA rather than registering a new one.
 */
export async function getWabaPhoneNumber({ wabaId, token }) {
  const res = await fetch(
    `${META_API_URL}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const json = await res.json()
  if (json.error) throw metaError(json, 'WABA phone-number lookup failed')
  const first = json.data?.[0]
  if (!first?.id) throw new Error('WABA returned no phone number (is coexistence linking complete?)')
  return { phoneNumberId: first.id, displayPhone: first.display_phone_number || null, verifiedName: first.verified_name || null }
}

/** Initial history-sync state stamped into signup_meta at coexistence onboarding. */
export function initialHistorySyncState(nowIso) {
  return { status: 'pending', started_at: nowIso }
}
```

(Note: `metaError` and `META_API_URL` are already defined/imported in this file — reuse them.)

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run src/lib/whatsapp-embedded-signup.test.js
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-embedded-signup.js src/lib/whatsapp-embedded-signup.test.js
git commit -m "WA-COEX.1a — getWabaPhoneNumber + initialHistorySyncState helpers"
```

---

### Task 2: Coexistence branch in the exchange route

**Files:**
- Modify: `src/app/api/locations/[id]/whatsapp/embedded-signup/route.js`

No route-level unit test (repo convention — routes are covered via their pure libs, which Task 1 did). Verified by `npm run build` + `check:route-guards` + the manual E2E post-approval.

- [ ] **Step 1: Add `mode` to the Zod schema**

Replace `ExchangeSchema` with:

```js
const ExchangeSchema = z.object({
  mode: z.enum(['cloud_api', 'coexistence']).default('cloud_api'),
  code: z.string().min(1),
  waba_id: z.string().regex(/^\d+$/, 'waba_id must be a numeric Meta id'),
  // Cloud API supplies phone_number_id from the ES session; coexistence
  // resolves it server-side from the WABA, so it's optional here.
  phone_number_id: z.string().regex(/^\d+$/, 'phone_number_id must be a numeric Meta id').optional(),
})
```

- [ ] **Step 2: Import the new helpers**

Add `getWabaPhoneNumber, initialHistorySyncState` to the existing import from `@/lib/whatsapp-embedded-signup`.

- [ ] **Step 3: Restructure POST to branch on mode**

After `const { code, waba_id, phone_number_id } = result.data` becomes `const { mode, code, waba_id, phone_number_id: bodyPhoneNumberId } = result.data`. Keep the env check and the code-exchange (step 1) unchanged. Then insert, immediately after the successful `exchangeCodeForBusinessToken` and BEFORE the ownership lookup, a resolution of the effective phone number id:

```js
  // Coexistence resolves the phone_number_id from the WABA (the number is
  // already registered on the Business app); Cloud API takes it from the body.
  let phone_number_id = bodyPhoneNumberId
  let coexistenceNumber = null
  if (mode === 'coexistence') {
    try {
      coexistenceNumber = await getWabaPhoneNumber({ wabaId: waba_id, token })
      phone_number_id = coexistenceNumber.phoneNumberId
    } catch (e) {
      return NextResponse.json({ success: false, error: `Coexistence phone-number lookup failed: ${e.message}` }, { status: 502 })
    }
  }
  if (!phone_number_id) {
    return NextResponse.json({ success: false, error: 'phone_number_id is required for Cloud API onboarding.' }, { status: 400 })
  }
```

- [ ] **Step 4: Skip probe/register for coexistence**

Replace the register block (step 3 in the route) with:

```js
  // Coexistence numbers are already registered on the Business app — probing
  // + /register is a Cloud-API-only concern and would be wrong here.
  let probe = null
  let pin = null
  if (mode === 'cloud_api') {
    try {
      probe = await probeNumber({ phoneNumberId: phone_number_id, token })
    } catch (e) {
      return NextResponse.json({ success: false, error: `Number probe failed: ${e.message}` }, { status: 502 })
    }
    if (needsRegistration(probe)) {
      pin = existingRow?.signup_meta?.pin || generatePin()
      try {
        await registerNumber({ phoneNumberId: phone_number_id, token, pin })
      } catch (e) {
        return NextResponse.json({ success: false, error: `Number registration failed: ${e.message}` }, { status: 502 })
      }
    }
  }
```

- [ ] **Step 5: Stamp coexistence + history-sync into signup_meta, and set source**

After `buildSignupMeta(...)` builds `signupMeta`, extend it for coexistence:

```js
  const signupMeta = buildSignupMeta({
    wabaId: waba_id, pin, existingMeta: existingRow?.signup_meta,
    userId: user.id, probe, connectedAt: new Date().toISOString(),
  })
  if (mode === 'coexistence') {
    signupMeta.coexistence = true
    signupMeta.history_sync = existingRow?.signup_meta?.history_sync || initialHistorySyncState(new Date().toISOString())
  }
  const numberSource = mode === 'coexistence' ? 'coexistence' : 'cloud_api'
```

Then in BOTH the `update` and `insert` writes, replace `source: 'cloud_api'` with `source: numberSource`, and for the insert's `label`/`display_phone` use the coexistence values when present:

```js
      label: (probe?.verified_name) || coexistenceNumber?.verifiedName || `WhatsApp ${probe?.display_phone_number || coexistenceNumber?.displayPhone || phone_number_id}`,
      display_phone: probe?.display_phone_number || coexistenceNumber?.displayPhone || null,
```

(The `update` branch already omits label/display_phone — leave it, but add `source: numberSource` to its update object.)

- [ ] **Step 6: Build + route-guards + lint**

```bash
npm run build && npm run check:route-guards && npm run lint
```
Expected: build succeeds; route-guards clean; lint 0 errors.

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/locations/[id]/whatsapp/embedded-signup/route.js'
git commit -m "WA-COEX.1b — coexistence branch: skip register, resolve phone from WABA, source=coexistence"
```

---

## CX.2 — Webhook handlers (echoes / contact-sync / history)

### Task 3: Pure coexistence parsers + phone normaliser

**Files:**
- Create: `src/lib/whatsapp-coexistence.js`
- Test: `src/lib/whatsapp-coexistence.test.js`

- [ ] **Step 1: Write failing tests**

```js
// src/lib/whatsapp-coexistence.test.js
import { describe, it, expect } from 'vitest'
import { normalizeWaPhone, parseEchoMessages, parseSyncContacts, parseHistoryMessages } from './whatsapp-coexistence.js'

describe('normalizeWaPhone', () => {
  it('yields both + and no-+ forms, stripping non-digits', () => {
    expect(normalizeWaPhone('+353 87 314 7675')).toEqual({ withPlus: '+353873147675', without: '353873147675' })
    expect(normalizeWaPhone('353873147675')).toEqual({ withPlus: '+353873147675', without: '353873147675' })
  })
  it('returns null for empty', () => {
    expect(normalizeWaPhone('')).toBeNull()
    expect(normalizeWaPhone(null)).toBeNull()
  })
})

describe('parseEchoMessages', () => {
  it('maps smb_message_echoes into outbound message descriptors', () => {
    const value = { metadata: { phone_number_id: '999' }, message_echoes: [
      { id: 'wamid.ECHO1', from: '353111', to: '353222', type: 'text', text: { body: 'sent from phone' }, timestamp: '1700000000' },
    ] }
    expect(parseEchoMessages(value)).toEqual([
      { waMessageId: 'wamid.ECHO1', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'sent from phone', tsSeconds: 1700000000 },
    ])
  })
  it('returns [] when no echoes', () => {
    expect(parseEchoMessages({})).toEqual([])
  })
})

describe('parseSyncContacts', () => {
  it('extracts phone + name from smb_app_state_sync contact upserts', () => {
    const value = { state_sync: [
      { type: 'contact', action: 'add', contact: { full_name: 'Jane Doe', phone_number: '+353861234567' } },
      { type: 'contact', action: 'remove', contact: { phone_number: '+353860000000' } },
    ] }
    expect(parseSyncContacts(value)).toEqual([{ phone: '+353861234567', name: 'Jane Doe' }])
  })
  it('ignores non-contact / non-upsert entries', () => {
    expect(parseSyncContacts({ state_sync: [{ type: 'settings' }] })).toEqual([])
  })
})

describe('parseHistoryMessages', () => {
  it('flattens history threads into message descriptors with direction', () => {
    const value = { history: [ { threads: [
      { messages: [
        { id: 'wamid.H1', from: '353222', to: '353111', type: 'text', text: { body: 'old inbound' }, timestamp: '1699000000' },
        { id: 'wamid.H2', from: '353111', to: '353222', type: 'text', text: { body: 'old outbound' }, timestamp: '1699000100' },
      ] },
    ] } ], metadata: { phone_number_id: '999' } }
    const out = parseHistoryMessages(value, '353111')
    expect(out).toEqual([
      { waMessageId: 'wamid.H1', peerPhone: '353222', direction: 'inbound', messageType: 'text', body: 'old inbound', tsSeconds: 1699000000 },
      { waMessageId: 'wamid.H2', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'old outbound', tsSeconds: 1699000100 },
    ])
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/lib/whatsapp-coexistence.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/whatsapp-coexistence.js`**

```js
// src/lib/whatsapp-coexistence.js
//
// WA-COEX.2 — pure parsers for the three coexistence webhook fields.
// Each turns a Meta `change.value` payload into normalised descriptors the
// ingest layer (whatsapp-coexistence-ingest.js) persists. No DB, no fetch —
// unit-tested against fixtures.

/** Both phone forms Meta/our DB use. `without` is what we store in wa_phone. */
export function normalizeWaPhone(raw) {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (!digits) return null
  return { withPlus: `+${digits}`, without: digits }
}

function textBody(msg) {
  if (msg.type === 'text') return msg.text?.body || ''
  if (msg.type === 'image') return msg.image?.caption || ''
  if (msg.type === 'video') return msg.video?.caption || ''
  if (msg.type === 'document') return msg.document?.caption || msg.document?.filename || ''
  return `[${msg.type || 'text'} message]`
}

/** smb_message_echoes → outbound descriptors (owner sent these FROM the phone). */
export function parseEchoMessages(value) {
  const echoes = value?.message_echoes || []
  return echoes.filter(m => m?.id).map(m => ({
    waMessageId: m.id,
    peerPhone: normalizeWaPhone(m.to)?.without || null,
    direction: 'outbound',
    messageType: m.type || 'text',
    body: textBody(m),
    tsSeconds: m.timestamp ? parseInt(m.timestamp, 10) : null,
  }))
}

/** smb_app_state_sync → contacts to MATCH (add/upsert only; removals ignored). */
export function parseSyncContacts(value) {
  const items = value?.state_sync || []
  return items
    .filter(s => s?.type === 'contact' && s?.action !== 'remove' && s?.contact?.phone_number)
    .map(s => ({ phone: s.contact.phone_number, name: s.contact.full_name || null }))
}

/**
 * history → flat message descriptors. `ownPhone` (the coexistence number's
 * own msisdn, digits only) decides direction: from==own → outbound, else inbound.
 */
export function parseHistoryMessages(value, ownPhone) {
  const own = normalizeWaPhone(ownPhone)?.without || null
  const out = []
  for (const h of value?.history || []) {
    for (const thread of h?.threads || []) {
      for (const m of thread?.messages || []) {
        if (!m?.id) continue
        const from = normalizeWaPhone(m.from)?.without || null
        const to = normalizeWaPhone(m.to)?.without || null
        const direction = from && own && from === own ? 'outbound' : 'inbound'
        const peerPhone = direction === 'outbound' ? to : from
        out.push({
          waMessageId: m.id, peerPhone, direction,
          messageType: m.type || 'text', body: textBody(m),
          tsSeconds: m.timestamp ? parseInt(m.timestamp, 10) : null,
        })
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run src/lib/whatsapp-coexistence.test.js
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-coexistence.js src/lib/whatsapp-coexistence.test.js
git commit -m "WA-COEX.2a — pure parsers for echoes/contact-sync/history webhook fields"
```

---

### Task 4: Coexistence ingest layer (DB) — match-only contacts, dedup messages

**Files:**
- Create: `src/lib/whatsapp-coexistence-ingest.js`
- Test: `src/lib/whatsapp-coexistence-ingest.test.js`

Self-contained conversation-upsert + message-insert for coexistence, so the live `handleIncomingMessage` path is not touched. Uses a mock db in tests (mirror `whatsapp-config.test.js`'s `mockDb`).

- [ ] **Step 1: Write failing tests**

```js
// src/lib/whatsapp-coexistence-ingest.test.js
import { describe, it, expect, vi } from 'vitest'
import { syncContactMatchOnly, ingestCoexistenceMessage } from './whatsapp-coexistence-ingest.js'

// Minimal chainable mock db. Each .from() returns a builder whose terminal
// awaited call resolves to the queued result for that table+op.
function makeDb(handlers) {
  return {
    from(table) {
      const ctx = { table, filters: [] }
      const builder = {
        select() { return builder }, insert(v) { ctx.op = 'insert'; ctx.values = v; return builder },
        update(v) { ctx.op = 'update'; ctx.values = v; return builder },
        eq() { return builder }, is() { return builder }, or() { return builder },
        limit() { return builder }, order() { return builder },
        maybeSingle() { return Promise.resolve(handlers(ctx)) },
        single() { return Promise.resolve(handlers(ctx)) },
        then(res) { return Promise.resolve(handlers(ctx)).then(res) },
      }
      return builder
    },
  }
}

describe('syncContactMatchOnly', () => {
  it('updates wa_phone on an EXISTING contact and never creates', async () => {
    const updates = []
    const db = makeDb((ctx) => {
      if (ctx.table === 'contacts' && ctx.op === 'update') { updates.push(ctx.values); return { data: null, error: null } }
      if (ctx.table === 'contacts') return { data: { id: 'c1', wa_phone: null }, error: null } // match found
      return { data: null, error: null }
    })
    const r = await syncContactMatchOnly(db, { phone: '+353861234567' })
    expect(r).toEqual({ matched: true, contactId: 'c1' })
    expect(updates).toEqual([{ wa_phone: '353861234567' }])
  })
  it('creates NOTHING when the contact is not already in the CRM', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.op === 'insert') { inserts.push(ctx); return { data: { id: 'X' }, error: null } }
      if (ctx.table === 'contacts') return { data: null, error: null } // no match
      return { data: null, error: null }
    })
    const r = await syncContactMatchOnly(db, { phone: '+353860000000' })
    expect(r).toEqual({ matched: false, contactId: null })
    expect(inserts).toEqual([]) // never inserts a contact
  })
})

describe('ingestCoexistenceMessage', () => {
  it('dedups on wa_message_id — a message we already have is skipped', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.table === 'whatsapp_messages' && ctx.op !== 'insert') return { data: { id: 'existing' }, error: null } // dupe found
      if (ctx.op === 'insert') { inserts.push(ctx.table); return { data: { id: 'n' }, error: null } }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.DUP', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: false, reason: 'duplicate' })
    expect(inserts).toEqual([]) // no conversation, no message
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/lib/whatsapp-coexistence-ingest.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/whatsapp-coexistence-ingest.js`**

```js
// src/lib/whatsapp-coexistence-ingest.js
//
// WA-COEX.2 — DB ingest for coexistence webhooks. Self-contained so the live
// handleIncomingMessage path stays untouched. Contact rule (Richard): match
// existing contacts ONLY, never create; inherit their marketing prefs
// (we never write consent here). Messages dedup on wa_message_id.

import { normalizeWaPhone } from './whatsapp-coexistence'

/**
 * Match a synced contact to an EXISTING CRM contact by phone. If found,
 * ensure wa_phone linkage (stored without +) and return it. If not found,
 * do nothing (never create). Never touches marketing preferences.
 */
export async function syncContactMatchOnly(db, { phone }) {
  const n = normalizeWaPhone(phone)
  if (!n) return { matched: false, contactId: null }
  const { data: contact } = await db
    .from('contacts')
    .select('id, wa_phone')
    .or(`wa_phone.eq.${n.without},wa_phone.eq.${n.withPlus},phone.eq.${n.without},phone.eq.${n.withPlus}`)
    .limit(1)
    .maybeSingle()
  if (!contact?.id) return { matched: false, contactId: null }
  if (!contact.wa_phone) {
    await db.from('contacts').update({ wa_phone: n.without }).eq('id', contact.id)
  }
  return { matched: true, contactId: contact.id }
}

/**
 * Insert one coexistence message (echo or history), deduped on wa_message_id.
 * Threads to an existing contact if one matches the peer phone (match-only —
 * an unknown peer still gets a conversation/message row so the inbox is
 * complete, but no marketing-eligible contact is created).
 */
export async function ingestCoexistenceMessage(db, { locationId, descriptor }) {
  const { waMessageId, peerPhone, direction, messageType, body, tsSeconds } = descriptor
  if (!waMessageId) return { inserted: false, reason: 'no_id' }

  // Dedup: our own Cloud API sends already store their wa_message_id.
  const { data: dupe } = await db
    .from('whatsapp_messages').select('id').eq('wa_message_id', waMessageId).limit(1).maybeSingle()
  if (dupe?.id) return { inserted: false, reason: 'duplicate' }

  const n = peerPhone ? normalizeWaPhone(peerPhone) : null
  let contactId = null
  if (n) {
    const { data: contact } = await db
      .from('contacts').select('id')
      .or(`wa_phone.eq.${n.without},wa_phone.eq.${n.withPlus},phone.eq.${n.without},phone.eq.${n.withPlus}`)
      .limit(1).maybeSingle()
    contactId = contact?.id || null
  }

  const waPhone = n?.without || peerPhone || 'unknown'
  const { data: existingConv } = await db
    .from('whatsapp_conversations').select('id').eq('location_id', locationId).eq('wa_phone', waPhone).limit(1).maybeSingle()
  let conversationId = existingConv?.id
  if (!conversationId) {
    const { data: newConv } = await db
      .from('whatsapp_conversations')
      .insert({ location_id: locationId, contact_id: contactId, wa_phone: waPhone, status: 'active' })
      .select('id').single()
    conversationId = newConv?.id
  }
  if (!conversationId) return { inserted: false, reason: 'no_conversation' }

  const sentAt = tsSeconds ? new Date(tsSeconds * 1000).toISOString() : new Date().toISOString()
  await db.from('whatsapp_messages').insert({
    conversation_id: conversationId, contact_id: contactId, location_id: locationId,
    wa_message_id: waMessageId, direction, message_type: messageType, body,
    status: direction === 'outbound' ? 'sent' : 'delivered', sent_at: sentAt,
  })
  return { inserted: true, conversationId, contactId }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run src/lib/whatsapp-coexistence-ingest.test.js
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-coexistence-ingest.js src/lib/whatsapp-coexistence-ingest.test.js
git commit -m "WA-COEX.2b — coexistence ingest: match-only contacts, dedup messages"
```

---

### Task 5: Wire the three handlers into the webhook route

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js`

- [ ] **Step 1: Import the parsers + ingest + a coexistence field set**

At the top of the file, add:

```js
import { parseEchoMessages, parseSyncContacts, parseHistoryMessages } from '@/lib/whatsapp-coexistence'
import { syncContactMatchOnly, ingestCoexistenceMessage } from '@/lib/whatsapp-coexistence-ingest'
```

Near the other `*_EVENT_FIELDS` sets, add:

```js
const COEXISTENCE_EVENT_FIELDS = new Set(['smb_message_echoes', 'smb_app_state_sync', 'history'])
```

- [ ] **Step 2: Add dispatch before the `messages` check**

In the change-dispatch loop, immediately BEFORE `if (change.field !== 'messages') continue`, add:

```js
        if (COEXISTENCE_EVENT_FIELDS.has(change.field)) {
          try { await handleCoexistenceEvent(db, change.field, change.value) }
          catch (e) { console.error(`[wa-webhook] coexistence ${change.field} failed:`, e?.message) }
          continue
        }
```

- [ ] **Step 3: Add the handler function** (near `handleFlowEvent`, module scope)

```js
// WA-COEX.2 — coexistence webhook fields. Echoes = owner's phone-side sends
// (outbound, deduped). state_sync = contacts (match existing only). history =
// backfill (deduped). The number's owning location comes from phone_number_id;
// unknown ids are dropped, mirroring the messages path.
async function handleCoexistenceEvent(db, field, value) {
  const phoneNumberId = value?.metadata?.phone_number_id
  const owner = phoneNumberId ? await resolveWhatsAppNumberByPhoneNumberId(phoneNumberId).catch(() => null) : null
  const routing = classifyInboundOwner(owner)
  if (routing.action === 'drop') {
    console.warn(`[wa-webhook] dropping coexistence ${field} for unregistered phone_number_id ${phoneNumberId}`)
    return
  }
  let locationId = routing.action === 'location' ? routing.locationId : null
  if (!locationId) {
    const { data: locations } = await db.from('locations').select('id').limit(1)
    locationId = locations?.[0]?.id || null
  }
  if (!locationId) return

  if (field === 'smb_app_state_sync') {
    for (const c of parseSyncContacts(value)) {
      try { await syncContactMatchOnly(db, c) } catch (e) { console.error('[wa-webhook] sync contact failed:', e?.message) }
    }
    return
  }

  // echoes + history are both message descriptors; each deduped per wa_message_id.
  const ownPhone = owner?.displayPhone || null
  const descriptors = field === 'smb_message_echoes'
    ? parseEchoMessages(value)
    : parseHistoryMessages(value, ownPhone)
  for (const d of descriptors) {
    if (!d.waMessageId) continue
    const dedup = await recordWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.WHATSAPP, eventId: `coex:${d.waMessageId}` })
    if (dedup.seen) continue
    try { await ingestCoexistenceMessage(db, { locationId, descriptor: d }) }
    catch (e) { console.error('[wa-webhook] coexistence ingest failed:', e?.message) }
  }
}
```

(Note: `resolveWhatsAppNumberByPhoneNumberId` and `classifyInboundOwner` are already imported in this file from `@/lib/whatsapp-config`; confirm and add to the import if missing.)

- [ ] **Step 4: Full test suite + build + guards**

```bash
npm test && npm run build && npm run check:route-guards && npm run lint
```
Expected: all pass (new lib tests green; build compiles the route).

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/webhooks/whatsapp/route.js'
git commit -m "WA-COEX.2c — dispatch smb_message_echoes/smb_app_state_sync/history to coexistence handlers"
```

---

## CX.3 — Frontend coexistence launch

### Task 6: "Connect existing WhatsApp Business number" button

**Files:**
- Modify: `src/components/settings/integrations/WhatsAppIntegrationTab.jsx`

No unit test (component; repo tests are pure-lib). Verified by lint + build. Reuse the existing `ConnectWhatsAppCard` machinery (SDK loader, launch-config fetch, origin-validated message listener) — read that component first and mirror its idiom exactly.

- [ ] **Step 1: Add a `mode`-aware launch to the connect card**

Read `ConnectWhatsAppCard`. Generalise it (or add a sibling) so it can launch either flow. The coexistence launch differs in two ways:
- `extras` includes `featureType: 'whatsapp_business_app_onboarding'`.
- the session-info listener also accepts the coexistence finish event.

Concretely, extend the `connect()` FB.login options and the POST body with a `mode` param. For the coexistence button:

```jsx
FB.login((response) => resolve(response?.authResponse?.code || null), {
  config_id: launch.config_id,
  response_type: 'code',
  override_default_response_type: true,
  extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' },
})
```

and the message listener's captured event set includes both `WA_EMBEDDED_SIGNUP` finish events (the coexistence one is `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; capture `waba_id`, and `phone_number_id` if present). The POST becomes:

```jsx
body: JSON.stringify({ mode: 'coexistence', code: authCode, waba_id, phone_number_id })
```

(For coexistence, `phone_number_id` may be absent — the server resolves it. Only require `waba_id` before POSTing in coexistence mode.)

- [ ] **Step 2: Render the second button**

Directly beside the existing Cloud API Connect button, add a second labelled **"Connect existing WhatsApp Business number"** (same `Button`/chip idiom, `type="button"`, disabled when `!canEdit || busy || !launch?.configured`). Add a one-line helper caption: "Already using the WhatsApp Business app on this number? Link it without moving off your phone." Show the same success/error/not-configured chips. On success, surface a "Coexistence connected — importing recent history…" chip.

- [ ] **Step 3: Lint + guardrails + build**

```bash
npm run lint && npm run check:guardrails && npm run build
```
Expected: clean (chips use `bg-*-500/10 text-*-700`; non-submit buttons `type="button"`).

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/integrations/WhatsAppIntegrationTab.jsx
git commit -m "WA-COEX.3 — Connect existing WhatsApp Business number (coexistence launch)"
```

---

## CX.4 — History-sync status, coexistence notes, runbook

### Task 7: Coexistence status badge + constraint notes in settings

**Files:**
- Modify: `src/components/settings/integrations/WhatsAppIntegrationTab.jsx`

- [ ] **Step 1: Surface coexistence state on each number row**

The numbers list already renders `whatsapp_numbers` rows via `publicShape` (which includes `source`, `token_type`, `connected_via`). Add, for a row where `source === 'coexistence'`:
- a chip "Coexistence" (`bg-blue-500/10 text-blue-700`).
- when `signup_meta.history_sync.status` is available (extend `publicShape` to pass a coarse `history_sync_status` string — NOT the raw signup_meta, which holds the PIN), a small "History: importing…/imported/expired" note.

First extend `src/lib/whatsapp-numbers-shape.js` `publicShape` to add ONLY:

```js
    history_sync_status: row.signup_meta?.history_sync?.status || null,
```

(Do not expose any other `signup_meta` field — the PIN must stay server-side. Add a test to `whatsapp-numbers-shape.test.js` asserting the PIN is still absent and `history_sync_status` is surfaced.)

- [ ] **Step 2: Add the 5 msg/sec + display-name notes**

Under the coexistence chip, render a muted caption: "Coexistence numbers send at up to 5 messages/second, and WhatsApp hides the display name unless the business is Meta-Verified." Operator-facing, static.

- [ ] **Step 3: shape test + lint + build**

```bash
npx vitest run src/lib/whatsapp-numbers-shape.test.js && npm run lint && npm run build
```
Expected: pass; PIN still absent; `history_sync_status` present.

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp-numbers-shape.js src/lib/whatsapp-numbers-shape.test.js src/components/settings/integrations/WhatsAppIntegrationTab.jsx
git commit -m "WA-COEX.4a — coexistence status chip + history-sync note + constraint notes"
```

---

### Task 8: Runbook + CHANGELOG + OpenAPI

**Files:**
- Modify: `docs/whatsapp-setup.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Append the coexistence section to `docs/whatsapp-setup.md`** (§5, following §4 Tech Provider)

Document: (a) subscribe the WABA to `history`, `smb_app_state_sync`, `smb_message_echoes` in App Dashboard → WhatsApp → Configuration; (b) the client's number must be coexistence-eligible (Business app ≥ 2.24.17, good quality, linked to a Page); (c) the operator uses the "Connect existing WhatsApp Business number" button; (d) history import is one-shot within 24h; (e) the 5 msg/sec + display-name caveats.

- [ ] **Step 2: Update the openapi `embedded-signup` POST entry**

The request body now has an optional `mode: 'cloud_api' | 'coexistence'` and `phone_number_id` is optional. Update the registered schema in `src/lib/openapi.js` to match (mirror the existing entry's idiom).

- [ ] **Step 3: CHANGELOG entry** (next number after the current top entry — read the top of `docs/CHANGELOG.md` first)

Summarise WA-COEX.1–.4: coexistence branch on the exchange route, three webhook handlers (echoes/contact-sync-match-only/history), coexistence launch button, status chip. Note contact-sync is match-existing-only; history is one-shot 24h.

- [ ] **Step 4: Build + full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/whatsapp-setup.md docs/CHANGELOG.md src/lib/openapi.js
git commit -m "WA-COEX.4b — coexistence runbook, OpenAPI mode param, CHANGELOG"
```

---

### Task 9: PR (do NOT merge — hold for App Review approval)

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin whatsapp-coexistence-v2
gh pr create --base main --title "WA-COEX — WhatsApp Business app coexistence support" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-07-16-whatsapp-coexistence-design.md.

- Exchange route: `mode: 'coexistence'` branch — skips /register, resolves phone_number_id from the WABA, stores source='coexistence', stamps a 24h history-sync clock.
- Webhook handlers: smb_message_echoes (phone-side sends → outbound, deduped), smb_app_state_sync (contacts — MATCH EXISTING ONLY, never create, marketing prefs inherited), history (6-month backfill, deduped). Live handleIncomingMessage path untouched (ingest is self-contained).
- Frontend: second "Connect existing WhatsApp Business number" button (featureType flag).
- Status chip + history-sync note + 5 msg/sec / display-name caveats. Runbook + OpenAPI + CHANGELOG.

All CRM code is fixture/mock-tested; no live Meta dependency. **HOLD — do not merge until WhatsApp App Review is approved** (coexistence rides the same two permissions; building against a not-yet-approved app risks rework). After approval: subscribe the WABA to the three webhook fields, then live E2E with a real eligible number.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Report the PR URL.** Do NOT merge.

---

## Post-merge (operator + assistant, after App Review approval)

1. Meta console: subscribe the WABA to `history`, `smb_app_state_sync`, `smb_message_echoes` (runbook §5).
2. Live E2E: onboard a real eligible Business-app number via the coexistence button; verify send/receive both ways, phone-side echo mirroring, history backfill, and that an unknown phone-book contact was NOT imported.
3. Update memory `wa-tech-provider-onboarding` / a new coexistence memory with outcomes.

## Self-review notes (applied)

- Spec §3 (frontend) → Task 6; §4 (exchange branch) → Tasks 1–2; §5 (webhook handlers) → Tasks 3–5; §6 (data/no-migration) → confirmed (signup_meta, no migration); §7 (external) → Task 8 runbook; §10 (testing) → Tasks 1,3,4,7 tests; §11 (constraints UI) → Task 7; §12 (out of scope) → not built.
- Type consistency: descriptor shape `{ waMessageId, peerPhone, direction, messageType, body, tsSeconds }` is identical across `parseEchoMessages`/`parseHistoryMessages`/`ingestCoexistenceMessage`. `syncContactMatchOnly` returns `{ matched, contactId }`; `ingestCoexistenceMessage` returns `{ inserted, ... }`.
- No migration required (verified: `source='coexistence'` in mig 176; `signup_meta` in mig 405).
- Contact-sync match-only rule enforced in `syncContactMatchOnly` (asserted: never inserts when unmatched) and history ingest (unknown peer → conversation/message but `contact_id=null`, no contact created).
