# Zoom Phone Contact Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push every distinct member/lead phone number from the CRM into Zoom Phone's external contacts directory, and keep it correct, so inbound calls show a name instead of a raw number.

**Architecture:** A nightly `CRON_SECRET`-guarded cron builds the desired state from Supabase, pages Zoom's external-contacts list, computes a pure diff, applies a deletion guard, and enqueues one QStash job per write. A signature-verified worker route applies a single create/update/delete. No new tables — Zoom holds the state and it is re-derived every run.

**Tech Stack:** Next.js App Router (Node runtime), Supabase JS, Upstash QStash, Zoom Server-to-Server OAuth, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-zoom-contact-sync-design.md`

---

## Codebase invariants you must respect

Read these before writing a line. Each has bitten this repo before and is recorded in `CLAUDE.md`.

1. **Supabase builders are thenables, not Promises.** They have `.then` but no `.catch`. `await db.from(...).select().catch(() => {})` throws and the query never runs. Always `try { await … } catch {}`.
2. **1,000-row select cap.** Every `.select()` returns at most 1000 rows *regardless of `.limit()`*. We read ~6,700 contacts, so pagination is mandatory: `.range()` with an explicit `.order()`. The canonical example is `src/lib/pipeline-reclassify.js:135-155`.
3. **QStash dedup ids are dash-only.** QStash 400s on colons in `Upstash-Deduplication-Id` — undocumented, bit the repo on 2026-07-17 (see the JSDoc on `publishQueuePush` in `src/lib/qstash.js`). Every id in this plan uses dashes only.
4. **Ownership marker carries no colon either.** The spec wrote `crm:<e164>`; this plan uses `crm-<digits>` (no `+`, no colon) so the same string is safe as a Zoom id, a dedup id fragment, and a log token. This is a deliberate amendment to the spec.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/zoom/normalise-phone.js` | Raw string → E.164 or `null`. Pure, no imports. |
| `src/lib/zoom/client.js` | Server-to-Server OAuth token (cached to expiry) + `zoomFetch()` with 429 handling. |
| `src/lib/zoom/external-contacts.js` | list / create / update / delete against `/phone/external_contacts`. |
| `src/lib/zoom/desired-contacts.js` | Paged contacts read → desired `Map`. Owns ClassPass exclusion + oldest-wins. |
| `src/lib/zoom/reconcile.js` | Pure `diffContacts()` + `applyDeletionGuard()` + the `runZoomContactSync()` orchestrator. |
| `src/app/api/cron/zoom-contact-sync/route.js` | `CRON_SECRET` wrapper, heartbeat, `?limit` / `?dry`. |
| `src/app/api/webhooks/qstash/zoom-contacts/route.js` | Applies exactly one write. |
| `src/lib/qstash.js` | *Modify* — add worker path + queue constants. |
| `src/lib/phone-validate.js` | *Modify* — fix the `353`+`0` double-prefix bug. |
| `vercel.json` | *Modify* — register the cron. |

Tests are colocated as `<name>.test.js`, per house convention. Run a single file with `npx vitest run <path>`.

---

### Task 1: Phone normaliser

**Files:**
- Create: `src/lib/zoom/normalise-phone.js`
- Test: `src/lib/zoom/normalise-phone.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/zoom/normalise-phone.test.js
import { describe, it, expect } from 'vitest'
import { normaliseForZoom } from './normalise-phone'

describe('normaliseForZoom', () => {
  it('keeps a well-formed E.164 number as-is', () => {
    expect(normaliseForZoom('+353871234567')).toBe('+353871234567')
  })

  it('strips separators', () => {
    expect(normaliseForZoom('+353 (87) 123-4567')).toBe('+353871234567')
  })

  it('converts a 00 international prefix to +', () => {
    expect(normaliseForZoom('00353871234567')).toBe('+353871234567')
  })

  // The 106-row defect: country code 353 followed by the national trunk 0.
  // Must drop the trunk zero, NOT pass through as a valid foreign number.
  it('repairs the 353-then-trunk-zero double prefix', () => {
    expect(normaliseForZoom('+3530871234567')).toBe('+353871234567')
    expect(normaliseForZoom('3530871234567')).toBe('+353871234567')
  })

  it('adds + to bare country-coded digits', () => {
    expect(normaliseForZoom('353871234567')).toBe('+353871234567')
  })

  it('expands an Irish national number', () => {
    expect(normaliseForZoom('0871234567')).toBe('+353871234567')
  })

  // Landlines matter here even though toMobileE164() rejects them — a landline
  // that rings the studio still deserves a name on the handset.
  it('keeps an Irish landline', () => {
    expect(normaliseForZoom('012345678')).toBe('+35312345678')
  })

  it('keeps a UK number', () => {
    expect(normaliseForZoom('+447700900123')).toBe('+447700900123')
  })

  it('assumes Ireland for bare national digits with no trunk zero', () => {
    expect(normaliseForZoom('871234567')).toBe('+353871234567')
  })

  it('rejects the ClassPass placeholder', () => {
    expect(normaliseForZoom('+10000000000')).toBeNull()
  })

  it('rejects junk', () => {
    expect(normaliseForZoom('')).toBeNull()
    expect(normaliseForZoom(null)).toBeNull()
    expect(normaliseForZoom('   ')).toBeNull()
    expect(normaliseForZoom('n/a')).toBeNull()
    expect(normaliseForZoom('12345')).toBeNull()          // too short
    expect(normaliseForZoom('+1111111111111')).toBeNull() // all same digit
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/zoom/normalise-phone.test.js`
Expected: FAIL — `Failed to resolve import "./normalise-phone"`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/zoom/normalise-phone.js
//
// ZOOMSYNC.1 — raw CRM phone string → E.164, or null when unusable.
//
// Deliberately NOT src/lib/phone-validate.js's toMobileE164(): that helper
// gates public forms on WhatsApp reachability so it rejects every landline,
// and a landline that rings the studio still deserves a name on the handset.
//
// The trunk-zero rule is the one that matters. 106 rows are stored as country
// code 353 followed by the national trunk 0 (+3530871234567). Left alone those
// look like a well-formed foreign number and would be published against a real
// member's name.

const MIN_DIGITS = 8
const MAX_DIGITS = 15

export function normaliseForZoom(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null

  const hasPlus = s.startsWith('+')
  let digits = s.replace(/\D/g, '')
  if (!digits) return null

  // 00 is the other way of writing +.
  if (!hasPlus && digits.startsWith('00')) digits = digits.slice(2)

  // Irish country code followed by the national trunk zero. The trunk zero is
  // only ever used in place of the country code, never after it.
  if (digits.startsWith('3530')) digits = `353${digits.slice(4)}`

  // A leading 0 with no country code is a national number; UN1T is Dublin, so
  // national means Ireland.
  if (!hasPlus && !digits.startsWith('353') && digits.startsWith('0')) {
    digits = `353${digits.slice(1)}`
  }

  // Bare national digits, no trunk zero and no country code (e.g. 871234567).
  // Only assume Ireland when the length makes it a plausible IE subscriber
  // number — otherwise we would mangle a foreign number typed without its +.
  if (!hasPlus && digits.length === 9 && !digits.startsWith('353')) {
    digits = `353${digits}`
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null
  if (digits.startsWith('0')) return null      // no country code starts with 0
  if (/^(\d)\1+$/.test(digits)) return null    // 1111…, 0000…

  // The ClassPass placeholder. Excluded by lead_source upstream too; belt and
  // braces, because it is a syntactically valid US number.
  if (digits === '10000000000') return null

  return `+${digits}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/zoom/normalise-phone.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/normalise-phone.js src/lib/zoom/normalise-phone.test.js
git commit -m "ZOOMSYNC.1 — E.164 normaliser with trunk-zero repair"
```

---

### Task 2: Fix the double-prefix bug in the shared validator

This is a live bug on the public forms, independent of the sync. `toMobileE164('+3530871234567')` currently returns the number verbatim because it fails the Irish-mobile test and falls through to the permissive international branch.

**Files:**
- Modify: `src/lib/phone-validate.js`
- Test: `src/lib/phone-validate.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/phone-validate.test.js`:

```javascript
describe('toMobileE164 — 353 with national trunk zero', () => {
  it('repairs the double prefix rather than passing it through', () => {
    expect(toMobileE164('+3530871234567')).toBe('+353871234567')
    expect(toMobileE164('3530871234567')).toBe('+353871234567')
    expect(toMobileE164('003530871234567')).toBe('+353871234567')
  })

  it('still rejects a 353-prefixed non-mobile', () => {
    expect(toMobileE164('+35315551234')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/phone-validate.test.js`
Expected: FAIL — received `'+3530871234567'`, expected `'+353871234567'`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/phone-validate.js`, immediately after the `if (!digits) return null` line and before the `IE_MOBILE_E164` check, insert:

```javascript
  // A country code is never followed by the national trunk zero. Strip it
  // before the mobile tests, otherwise +3530871234567 fails IE_MOBILE_E164
  // and gets waved through by the generic international branch below as a
  // valid foreign number. 106 rows in `contacts` are stored this way.
  if (digits.startsWith('3530')) digits = `353${digits.slice(4)}`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/phone-validate.test.js`
Expected: PASS, all pre-existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/phone-validate.js src/lib/phone-validate.test.js
git commit -m "ZOOMSYNC.1 — fix 353+trunk-zero passing validation as a foreign number"
```

---

### Task 3: Zoom OAuth client

**Files:**
- Create: `src/lib/zoom/client.js`
- Test: `src/lib/zoom/client.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/zoom/client.test.js
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { zoomConfigured, zoomFetch, __resetTokenCache } from './client'

const OK_TOKEN = { access_token: 'tok-abc', expires_in: 3600 }

function mockFetchSequence(responses) {
  const fn = vi.fn()
  for (const r of responses) fn.mockResolvedValueOnce(r)
  global.fetch = fn
  return fn
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  }
}

describe('zoom client', () => {
  beforeEach(() => {
    __resetTokenCache()
    process.env.ZOOM_ACCOUNT_ID = 'acct'
    process.env.ZOOM_CLIENT_ID = 'cid'
    process.env.ZOOM_CLIENT_SECRET = 'secret'
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('reports unconfigured when any secret is missing', () => {
    delete process.env.ZOOM_CLIENT_SECRET
    expect(zoomConfigured()).toBe(false)
    process.env.ZOOM_CLIENT_SECRET = 'secret'
    expect(zoomConfigured()).toBe(true)
  })

  it('fetches a token then calls the API with it', async () => {
    const fetchFn = mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ external_contacts: [] }),
    ])
    const res = await zoomFetch('/phone/external_contacts')
    expect(res.ok).toBe(true)
    expect(res.body).toEqual({ external_contacts: [] })
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-abc')
  })

  it('reuses the cached token across calls', async () => {
    const fetchFn = mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ a: 1 }),
      jsonResponse({ b: 2 }),
    ])
    await zoomFetch('/one')
    await zoomFetch('/two')
    // 1 token call + 2 API calls, not 2 token calls.
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('retries once on 429, honouring Retry-After', async () => {
    mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ error: 'rate' }, 429, { 'retry-after': '0' }),
      jsonResponse({ ok: true }),
    ])
    const res = await zoomFetch('/phone/external_contacts')
    expect(res.ok).toBe(true)
  })

  it('surfaces a non-retryable error without throwing', async () => {
    mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ message: 'Bad Request' }, 400),
    ])
    const res = await zoomFetch('/phone/external_contacts')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/zoom/client.test.js`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/zoom/client.js
//
// ZOOMSYNC.1 — Zoom Server-to-Server OAuth + a thin fetch wrapper.
//
// Ships dark: with any of the three secrets unset, zoomConfigured() is false
// and callers no-op rather than erroring. Same pattern as the Homey client.

const TOKEN_URL = 'https://zoom.us/oauth/token'
const API_BASE = 'https://api.zoom.us/v2'
const TIMEOUT_MS = 15_000
const EXPIRY_SKEW_MS = 60_000 // refresh a minute early

let tokenCache = { token: null, expiresAt: 0 }

/** Test-only. Vitest shares module state across cases in a file. */
export function __resetTokenCache() {
  tokenCache = { token: null, expiresAt: 0 }
}

export function zoomConfigured() {
  return Boolean(
    process.env.ZOOM_ACCOUNT_ID &&
    process.env.ZOOM_CLIENT_ID &&
    process.env.ZOOM_CLIENT_SECRET
  )
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token

  const basic = Buffer
    .from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`)
    .toString('base64')
  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`zoom token ${resp.status}: ${text.slice(0, 200)}`)

  const body = JSON.parse(text)
  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
  }
  return tokenCache.token
}

/**
 * @returns {Promise<{ok: true, status: number, body: any} | {ok: false, status: number, error: string, body: any}>}
 * Never throws for HTTP-level failures — callers branch on `.ok`. Only a
 * network/token failure throws.
 */
export async function zoomFetch(path, { method = 'GET', body, _retried = false } = {}) {
  const token = await getToken()
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const text = await resp.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }

  if (resp.status === 429 && !_retried) {
    const wait = Number(resp.headers.get('retry-after') ?? 1)
    await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 0), 30) * 1000))
    return zoomFetch(path, { method, body, _retried: true })
  }

  // A 401 after a cached token means the token died early — drop it so the
  // single retry re-mints rather than replaying the dead one.
  if (resp.status === 401 && !_retried) {
    __resetTokenCache()
    return zoomFetch(path, { method, body, _retried: true })
  }

  if (!resp.ok) {
    return { ok: false, status: resp.status, error: text.slice(0, 300), body: parsed }
  }
  return { ok: true, status: resp.status, body: parsed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/zoom/client.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/client.js src/lib/zoom/client.test.js
git commit -m "ZOOMSYNC.1 — Zoom Server-to-Server OAuth client"
```

---

### Task 4: External contacts API surface

**Files:**
- Create: `src/lib/zoom/external-contacts.js`
- Test: `src/lib/zoom/external-contacts.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/zoom/external-contacts.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ zoomFetch: vi.fn() }))
import { zoomFetch } from './client'
import {
  listOwnedContacts, createContact, updateContact, deleteContact, OWNED_PREFIX, markerFor,
} from './external-contacts'

beforeEach(() => { vi.mocked(zoomFetch).mockReset() })

describe('markerFor', () => {
  it('is dash-only and drops the plus', () => {
    expect(markerFor('+353871234567')).toBe('crm-353871234567')
    expect(markerFor('+353871234567')).not.toContain(':')
    expect(markerFor('+353871234567').startsWith(OWNED_PREFIX)).toBe(true)
  })
})

describe('listOwnedContacts', () => {
  it('pages until the token runs out and keeps only CRM-marked entries', async () => {
    vi.mocked(zoomFetch)
      .mockResolvedValueOnce({ ok: true, body: {
        next_page_token: 'p2',
        external_contacts: [
          { external_contact_id: 'z1', id: 'crm-353871111111', name: 'Aoife Ryan', phone_numbers: ['+353871111111'] },
          { external_contact_id: 'z2', id: 'plumber-joe', name: 'Joe the Plumber', phone_numbers: ['+353861111111'] },
        ],
      } })
      .mockResolvedValueOnce({ ok: true, body: {
        next_page_token: '',
        external_contacts: [
          { external_contact_id: 'z3', id: 'crm-353872222222', name: 'Cian Byrne', phone_numbers: ['+353872222222'] },
        ],
      } })

    const res = await listOwnedContacts()
    expect(res.ok).toBe(true)
    expect(res.contacts.size).toBe(2)
    expect(res.contacts.get('+353871111111')).toEqual({ zoomId: 'z1', name: 'Aoife Ryan' })
    // The hand-added plumber must be invisible, not merely skipped for writes.
    expect([...res.contacts.keys()]).not.toContain('+353861111111')
  })

  it('propagates a failure instead of returning a half-built map', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 500, error: 'boom' })
    const res = await listOwnedContacts()
    expect(res.ok).toBe(false)
  })
})

describe('createContact', () => {
  it('sends the marker as id and the uuid as description', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: true, body: { external_contact_id: 'z9' } })
    const res = await createContact({ e164: '+353871234567', name: 'Niamh Walsh', contactId: 'uuid-1' })
    expect(res.ok).toBe(true)
    const [path, opts] = vi.mocked(zoomFetch).mock.calls[0]
    expect(path).toBe('/phone/external_contacts')
    expect(opts.method).toBe('POST')
    expect(opts.body.id).toBe('crm-353871234567')
    expect(opts.body.name).toBe('Niamh Walsh')
    expect(opts.body.phone_numbers).toEqual(['+353871234567'])
    expect(opts.body.description).toContain('uuid-1')
  })

  // Idempotency: an overlapping run re-enqueues a create that already landed.
  it('treats a 409 duplicate as success', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 409, error: 'already exists' })
    const res = await createContact({ e164: '+353871234567', name: 'Niamh Walsh', contactId: 'uuid-1' })
    expect(res.ok).toBe(true)
    expect(res.duplicate).toBe(true)
  })

  it('reports a real failure', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 400, error: 'bad number' })
    const res = await createContact({ e164: '+353871234567', name: 'Niamh Walsh', contactId: 'uuid-1' })
    expect(res.ok).toBe(false)
  })
})

describe('updateContact / deleteContact', () => {
  it('PATCHes by Zoom id', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: true, body: null })
    await updateContact({ zoomId: 'z1', name: 'New Name', contactId: 'uuid-2' })
    const [path, opts] = vi.mocked(zoomFetch).mock.calls[0]
    expect(path).toBe('/phone/external_contacts/z1')
    expect(opts.method).toBe('PATCH')
    expect(opts.body.name).toBe('New Name')
  })

  it('DELETEs by Zoom id and treats 404 as success', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 404, error: 'gone' })
    const res = await deleteContact({ zoomId: 'z1' })
    expect(res.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/zoom/external-contacts.test.js`
Expected: FAIL — `Failed to resolve import "./external-contacts"`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/zoom/external-contacts.js
//
// ZOOMSYNC.1 — the /phone/external_contacts surface.
//
// Two Zoom API facts shape this file:
//   * There is no search. You cannot look up by phone or by your own id, so
//     listOwnedContacts() pages everything, every run.
//   * Updates and deletes need Zoom's generated external_contact_id, not our
//     id. Paging the full list is what supplies it, which is also why this
//     feature needs no local mapping table.

import { zoomFetch } from './client'

export const OWNED_PREFIX = 'crm-'
const PAGE_SIZE = 100
const MAX_PAGES = 500 // 50k contacts; a runaway-token backstop, not a real cap

/**
 * Ownership marker. Dash-only and plus-less so the same string is safe as a
 * Zoom id, inside a QStash dedup id, and in a log line.
 */
export function markerFor(e164) {
  return `${OWNED_PREFIX}${e164.replace(/\D/g, '')}`
}

function describe(contactId) {
  return `UN1T CRM sync - ${contactId}`
}

/**
 * @returns {Promise<{ok: true, contacts: Map<string, {zoomId: string, name: string}>, scanned: number}
 *                 | {ok: false, error: string}>}
 * Keyed by E.164. ONLY entries whose id starts with `crm-` are included —
 * anything a human added by hand is invisible to the reconcile, which is what
 * stops the delete pass touching it.
 */
export async function listOwnedContacts() {
  const contacts = new Map()
  let token = ''
  let scanned = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ page_size: String(PAGE_SIZE) })
    if (token) q.set('next_page_token', token)

    const res = await zoomFetch(`/phone/external_contacts?${q}`)
    if (!res.ok) return { ok: false, error: `list page ${page}: ${res.error}` }

    const rows = res.body?.external_contacts ?? []
    scanned += rows.length
    for (const row of rows) {
      if (typeof row?.id !== 'string' || !row.id.startsWith(OWNED_PREFIX)) continue
      const number = row.phone_numbers?.[0]
      if (!number) continue
      contacts.set(number, { zoomId: row.external_contact_id, name: row.name ?? '' })
    }

    token = res.body?.next_page_token || ''
    if (!token) break
  }

  return { ok: true, contacts, scanned }
}

export async function createContact({ e164, name, contactId }) {
  const res = await zoomFetch('/phone/external_contacts', {
    method: 'POST',
    body: {
      id: markerFor(e164),
      name,
      phone_numbers: [e164],
      description: describe(contactId),
    },
  })
  // An overlapping run can re-enqueue a create that already landed. Zoom
  // rejects the duplicate id/number with a 409; that is the desired end state,
  // so it counts as success and the pipeline stays idempotent.
  if (!res.ok && res.status === 409) return { ok: true, duplicate: true }
  if (!res.ok) return { ok: false, error: `create ${e164}: ${res.error}` }
  return { ok: true }
}

export async function updateContact({ zoomId, name, contactId }) {
  const res = await zoomFetch(`/phone/external_contacts/${zoomId}`, {
    method: 'PATCH',
    body: { name, description: describe(contactId) },
  })
  if (!res.ok) return { ok: false, error: `update ${zoomId}: ${res.error}` }
  return { ok: true }
}

export async function deleteContact({ zoomId }) {
  const res = await zoomFetch(`/phone/external_contacts/${zoomId}`, { method: 'DELETE' })
  // Already gone is the desired end state.
  if (!res.ok && res.status === 404) return { ok: true, alreadyGone: true }
  if (!res.ok) return { ok: false, error: `delete ${zoomId}: ${res.error}` }
  return { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/zoom/external-contacts.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/external-contacts.js src/lib/zoom/external-contacts.test.js
git commit -m "ZOOMSYNC.1 — external contacts API surface with ownership marker"
```

---

### Task 5: Desired-state builder

**Files:**
- Create: `src/lib/zoom/desired-contacts.js`
- Test: `src/lib/zoom/desired-contacts.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/zoom/desired-contacts.test.js
import { describe, it, expect } from 'vitest'
import { buildDesiredContacts, pickWinner } from './desired-contacts'

/**
 * Minimal stub of the supabase-js builder chain used by buildDesiredContacts.
 * Serves `rows` in 1000-row pages so the .range() paging path is exercised.
 */
function stubDb(rows) {
  return {
    from: () => ({
      select: () => ({
        order: () => ({
          range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
        }),
      }),
    }),
  }
}

const row = (over = {}) => ({
  id: 'c1', first_name: 'Aoife', last_name: 'Ryan', phone: '+353871111111',
  lead_source: 'walk-in', created_at: '2025-01-01T00:00:00Z', ...over,
})

describe('pickWinner', () => {
  it('prefers the earliest created_at', () => {
    const a = row({ id: 'a', created_at: '2025-06-01T00:00:00Z', first_name: 'New' })
    const b = row({ id: 'b', created_at: '2024-01-01T00:00:00Z', first_name: 'Old' })
    expect(pickWinner(a, b).first_name).toBe('Old')
    expect(pickWinner(b, a).first_name).toBe('Old')
  })

  it('breaks a created_at tie on id, deterministically either way round', () => {
    const a = row({ id: 'aaa', created_at: '2025-01-01T00:00:00Z' })
    const b = row({ id: 'bbb', created_at: '2025-01-01T00:00:00Z' })
    expect(pickWinner(a, b).id).toBe('aaa')
    expect(pickWinner(b, a).id).toBe('aaa')
  })
})

describe('buildDesiredContacts', () => {
  it('excludes ClassPass rows', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: '+353872222222', lead_source: 'classpass' }),
      row({ id: 'c', phone: '+353873333333', lead_source: 'ClassPass' }),
    ]))
    expect(res.ok).toBe(true)
    expect([...res.desired.keys()]).toEqual(['+353871111111'])
    expect(res.stats.excludedClassPass).toBe(2)
  })

  it('collapses a shared number to the oldest profile name', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'new', first_name: 'Sarah', last_name: 'Doyle', phone: '0871234567', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'old', first_name: 'Sarah', last_name: 'Kelly',  phone: '+353871234567', created_at: '2023-01-01T00:00:00Z' }),
    ]))
    expect(res.desired.size).toBe(1)
    expect(res.desired.get('+353871234567')).toEqual({ name: 'Sarah Kelly', contactId: 'old' })
    expect(res.stats.collapsed).toBe(1)
  })

  it('drops unnormalisable numbers and counts them', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: '12345' }),
    ]))
    expect(res.desired.size).toBe(1)
    expect(res.stats.rejected).toBe(1)
  })

  it('skips a row with no usable name rather than pushing a blank', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', first_name: '  ', last_name: null, phone: '+353871111111' }),
    ]))
    expect(res.desired.size).toBe(0)
    expect(res.stats.noName).toBe(1)
  })

  it('trims a single-name contact cleanly', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', first_name: 'Cher', last_name: null, phone: '+353871111111' }),
    ]))
    expect(res.desired.get('+353871111111').name).toBe('Cher')
  })

  it('pages past the 1000-row select cap', async () => {
    const many = Array.from({ length: 2300 }, (_, i) =>
      row({ id: `c${i}`, phone: `+35387${String(i).padStart(7, '0')}` }))
    const res = await buildDesiredContacts(stubDb(many))
    expect(res.desired.size).toBe(2300)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/zoom/desired-contacts.test.js`
Expected: FAIL — `Failed to resolve import "./desired-contacts"`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/zoom/desired-contacts.js
//
// ZOOMSYNC.1 — CRM → the directory we want Zoom to hold.
//
// Owns three rules: ClassPass is excluded, numbers are normalised to E.164,
// and where two profiles share a number the OLDEST profile supplies the name.

import { normaliseForZoom } from './normalise-phone'

const PAGE_SIZE = 1000       // PostgREST caps every select at 1000 rows
const HARD_LIMIT = 40_000    // ~6.7k today; crossing this means streaming, not a bigger number
const SELECT_COLS = 'id, first_name, last_name, phone, lead_source, created_at'

/**
 * Oldest profile wins. `contacts.id` breaks a created_at tie so two rows
 * written in the same transaction cannot flip the name between runs.
 */
export function pickWinner(a, b) {
  const ta = Date.parse(a.created_at ?? '') || Number.MAX_SAFE_INTEGER
  const tb = Date.parse(b.created_at ?? '') || Number.MAX_SAFE_INTEGER
  if (ta !== tb) return ta < tb ? a : b
  return String(a.id) < String(b.id) ? a : b
}

function nameOf(row) {
  return [row.first_name, row.last_name]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' ')
}

/**
 * @returns {Promise<{ok: true, desired: Map<string, {name: string, contactId: string}>, stats: object}
 *                 | {ok: false, error: string}>}
 */
export async function buildDesiredContacts(db) {
  const stats = { scanned: 0, excludedClassPass: 0, rejected: 0, noName: 0, collapsed: 0 }
  const winners = new Map() // e164 → row

  let pageStart = 0
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    // Supabase builders are thenables, not Promises — no .catch() here.
    const { data: page, error } = await db
      .from('contacts')
      .select(SELECT_COLS)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)

    if (error) return { ok: false, error: `contact load: ${error.message}` }
    if (!Array.isArray(page) || page.length === 0) break

    for (const row of page) {
      stats.scanned++

      if (String(row.lead_source ?? '').toLowerCase() === 'classpass') {
        stats.excludedClassPass++
        continue
      }
      const e164 = normaliseForZoom(row.phone)
      if (!e164) { stats.rejected++; continue }
      if (!nameOf(row)) { stats.noName++; continue }

      const held = winners.get(e164)
      if (!held) { winners.set(e164, row); continue }
      stats.collapsed++
      winners.set(e164, pickWinner(held, row))
    }

    if (page.length < PAGE_SIZE) break
    pageStart += PAGE_SIZE
    if (pageStart >= HARD_LIMIT) break
  }

  const desired = new Map()
  for (const [e164, row] of winners) {
    desired.set(e164, { name: nameOf(row), contactId: String(row.id) })
  }
  return { ok: true, desired, stats }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/zoom/desired-contacts.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/desired-contacts.js src/lib/zoom/desired-contacts.test.js
git commit -m "ZOOMSYNC.1 — desired-state builder: ClassPass excluded, oldest profile wins"
```

---

### Task 6: Pure diff and deletion guard

**Files:**
- Create: `src/lib/zoom/reconcile.js`
- Test: `src/lib/zoom/reconcile.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/zoom/reconcile.test.js
import { describe, it, expect } from 'vitest'
import { diffContacts, applyDeletionGuard, GUARD_FLOOR, GUARD_FRACTION } from './reconcile'

const desired = (entries) => new Map(entries.map(([k, name, contactId = 'u1']) => [k, { name, contactId }]))
const existing = (entries) => new Map(entries.map(([k, name, zoomId]) => [k, { name, zoomId }]))

describe('diffContacts', () => {
  it('creates numbers Zoom does not have', () => {
    const d = diffContacts(desired([['+353871111111', 'Aoife Ryan']]), existing([]))
    expect(d.creates).toEqual([{ e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' }])
    expect(d.updates).toEqual([])
    expect(d.deletes).toEqual([])
  })

  it('updates when the name differs', () => {
    const d = diffContacts(
      desired([['+353871111111', 'Aoife Byrne', 'u2']]),
      existing([['+353871111111', 'Aoife Ryan', 'z1']]),
    )
    expect(d.updates).toEqual([{ e164: '+353871111111', name: 'Aoife Byrne', contactId: 'u2', zoomId: 'z1' }])
    expect(d.creates).toEqual([])
  })

  it('does nothing when the name matches', () => {
    const d = diffContacts(
      desired([['+353871111111', 'Aoife Ryan']]),
      existing([['+353871111111', 'Aoife Ryan', 'z1']]),
    )
    expect(d.creates).toEqual([]); expect(d.updates).toEqual([]); expect(d.deletes).toEqual([])
  })

  it('deletes numbers no longer in the CRM', () => {
    const d = diffContacts(desired([]), existing([['+353871111111', 'Aoife Ryan', 'z1']]))
    expect(d.deletes).toEqual([{ e164: '+353871111111', zoomId: 'z1' }])
  })
})

describe('applyDeletionGuard', () => {
  const del = (n) => Array.from({ length: n }, (_, i) => ({ e164: `+35387000000${i}`, zoomId: `z${i}` }))

  it('allows a small delete batch on a large directory', () => {
    const g = applyDeletionGuard(del(10), 6330)
    expect(g.tripped).toBe(false)
    expect(g.deletes).toHaveLength(10)
  })

  it('allows deletes up to the floor even on a tiny directory', () => {
    const g = applyDeletionGuard(del(GUARD_FLOOR), 50)
    expect(g.tripped).toBe(false)
  })

  it('trips and suppresses every delete when the batch is too big', () => {
    // 5% of 6330 = 316.5 → 317 allowed; 400 must trip.
    const g = applyDeletionGuard(del(400), 6330)
    expect(g.tripped).toBe(true)
    expect(g.deletes).toEqual([])
    expect(g.threshold).toBe(Math.max(GUARD_FLOOR, Math.ceil(6330 * GUARD_FRACTION)))
    expect(g.attempted).toBe(400)
  })

  it('does not trip exactly at the threshold', () => {
    const threshold = Math.max(GUARD_FLOOR, Math.ceil(6330 * GUARD_FRACTION))
    expect(applyDeletionGuard(del(threshold), 6330).tripped).toBe(false)
    expect(applyDeletionGuard(del(threshold + 1), 6330).tripped).toBe(true)
  })

  // The disaster case: desired-state query returns nothing.
  it('trips when the desired set is empty against a full directory', () => {
    const g = applyDeletionGuard(del(6330), 6330)
    expect(g.tripped).toBe(true)
    expect(g.deletes).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/zoom/reconcile.test.js`
Expected: FAIL — `Failed to resolve import "./reconcile"`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/zoom/reconcile.js
//
// ZOOMSYNC.1 — the diff, the guard, and (Task 7) the orchestrator.

export const GUARD_FLOOR = 20
export const GUARD_FRACTION = 0.05

/**
 * Pure. desired: Map<e164, {name, contactId}>; existing: Map<e164, {name, zoomId}>.
 * `existing` must ALREADY be filtered to CRM-owned entries — listOwnedContacts
 * does that, and it is what keeps hand-added contacts out of `deletes`.
 */
export function diffContacts(desired, existing) {
  const creates = []
  const updates = []
  const deletes = []

  for (const [e164, want] of desired) {
    const have = existing.get(e164)
    if (!have) {
      creates.push({ e164, name: want.name, contactId: want.contactId })
    } else if (have.name !== want.name) {
      updates.push({ e164, name: want.name, contactId: want.contactId, zoomId: have.zoomId })
    }
  }

  for (const [e164, have] of existing) {
    if (!desired.has(e164)) deletes.push({ e164, zoomId: have.zoomId })
  }

  return { creates, updates, deletes }
}

/**
 * A broken desired-state query (renamed column, dropped lead_source, a Supabase
 * blip returning zero rows) yields an empty desired set, which the diff reads as
 * "delete everything". Deletes are the only irreversible direction, so an
 * oversized batch suppresses ALL of them and fails the run loudly. Creates and
 * updates still apply — they are safe.
 */
export function applyDeletionGuard(deletes, ownedExistingCount) {
  const threshold = Math.max(GUARD_FLOOR, Math.ceil(ownedExistingCount * GUARD_FRACTION))
  if (deletes.length > threshold) {
    return {
      tripped: true,
      deletes: [],
      threshold,
      attempted: deletes.length,
      sample: deletes.slice(0, 10).map((d) => d.e164),
    }
  }
  return { tripped: false, deletes, threshold, attempted: deletes.length }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/zoom/reconcile.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/reconcile.js src/lib/zoom/reconcile.test.js
git commit -m "ZOOMSYNC.1 — pure diff and deletion guard"
```

---

### Task 7: QStash constants

**Files:**
- Modify: `src/lib/qstash.js`

- [ ] **Step 1: Add the constants**

Append alongside the other worker-path constants near the top of `src/lib/qstash.js` (follow the existing grouping — a comment line, then the exports):

```javascript
// ZOOMSYNC.1 — one job per external-contact write. Parallelism 2 is deliberate
// pacing, not a rate-limit necessity: Zoom allows 30/sec on Pro and 80/sec on
// Business+, and the cold start is ~6,330 writes we are happy to drain slowly.
export const ZOOM_CONTACTS_WORKER_PATH = '/api/webhooks/qstash/zoom-contacts'
export const ZOOM_CONTACTS_QUEUE_NAME = 'zoom-contacts'
export const ZOOM_CONTACTS_QUEUE_PARALLELISM = 2
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx vitest run src/lib/qstash.test.js`
Expected: PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/lib/qstash.js
git commit -m "ZOOMSYNC.1 — qstash constants for the zoom-contacts queue"
```

---

### Task 8: Reconcile orchestrator

**Files:**
- Modify: `src/lib/zoom/reconcile.js`
- Test: `src/lib/zoom/reconcile.orchestrator.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/zoom/reconcile.orchestrator.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./external-contacts', () => ({ listOwnedContacts: vi.fn() }))
vi.mock('./desired-contacts', () => ({ buildDesiredContacts: vi.fn() }))
vi.mock('./client', () => ({ zoomConfigured: vi.fn(() => true) }))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn(async () => ({ ok: true, messageId: 'm1' })),
  ensureQueue: vi.fn(async () => ({ ok: true })),
  ZOOM_CONTACTS_WORKER_PATH: '/api/webhooks/qstash/zoom-contacts',
  ZOOM_CONTACTS_QUEUE_NAME: 'zoom-contacts',
  ZOOM_CONTACTS_QUEUE_PARALLELISM: 2,
}))

import { listOwnedContacts } from './external-contacts'
import { buildDesiredContacts } from './desired-contacts'
import { zoomConfigured } from './client'
import { publishQueuePush } from '@/lib/qstash'
import { runZoomContactSync } from './reconcile'

const desiredMap = (n, prefix = 'Name') => new Map(
  Array.from({ length: n }, (_, i) => [`+35387${String(i).padStart(7, '0')}`, { name: `${prefix} ${i}`, contactId: `u${i}` }])
)

beforeEach(() => {
  vi.mocked(zoomConfigured).mockReturnValue(true)
  vi.mocked(publishQueuePush).mockClear()
  vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(3), stats: {} })
  vi.mocked(listOwnedContacts).mockResolvedValue({ ok: true, contacts: new Map(), scanned: 0 })
})

describe('runZoomContactSync', () => {
  it('skips cleanly when unconfigured', async () => {
    vi.mocked(zoomConfigured).mockReturnValue(false)
    const out = await runZoomContactSync({})
    expect(out.skipped).toBe('unconfigured')
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('enqueues one job per create', async () => {
    const out = await runZoomContactSync({})
    expect(out.ok).toBe(true)
    expect(out.enqueued).toBe(3)
    expect(publishQueuePush).toHaveBeenCalledTimes(3)
  })

  it('uses a dash-only dedup id (QStash 400s on colons)', async () => {
    await runZoomContactSync({})
    const { deduplicationId } = vi.mocked(publishQueuePush).mock.calls[0][0]
    expect(deduplicationId).not.toContain(':')
    expect(deduplicationId).toBe('zoom-contact-create-353870000000')
  })

  it('dry mode reports the diff and enqueues nothing', async () => {
    const out = await runZoomContactSync({ dry: true })
    expect(out.dry).toBe(true)
    expect(out.counts.creates).toBe(3)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('limit caps the number of jobs enqueued', async () => {
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(10), stats: {} })
    const out = await runZoomContactSync({ limit: 4 })
    expect(out.enqueued).toBe(4)
    expect(out.limited).toBe(true)
  })

  it('reports failure and enqueues nothing when the Zoom list fails', async () => {
    vi.mocked(listOwnedContacts).mockResolvedValue({ ok: false, error: 'zoom down' })
    const out = await runZoomContactSync({})
    expect(out.ok).toBe(false)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('fails the run when the guard trips, but still enqueues creates', async () => {
    // 100 owned entries, desired empty → 100 deletes vs a threshold of 20.
    const owned = new Map(Array.from({ length: 100 }, (_, i) =>
      [`+35389${String(i).padStart(7, '0')}`, { name: `Old ${i}`, zoomId: `z${i}` }]))
    vi.mocked(listOwnedContacts).mockResolvedValue({ ok: true, contacts: owned, scanned: 100 })
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(2), stats: {} })

    const out = await runZoomContactSync({})
    expect(out.ok).toBe(false)
    expect(out.guardTripped).toBe(true)
    expect(out.counts.deletes).toBe(0)
    expect(out.enqueued).toBe(2) // the two creates still went
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/zoom/reconcile.orchestrator.test.js`
Expected: FAIL — `runZoomContactSync is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/zoom/reconcile.js`, and add these imports at the top of the file:

```javascript
import { zoomConfigured } from './client'
import { listOwnedContacts } from './external-contacts'
import { buildDesiredContacts } from './desired-contacts'
import {
  publishQueuePush, ensureQueue,
  ZOOM_CONTACTS_WORKER_PATH, ZOOM_CONTACTS_QUEUE_NAME, ZOOM_CONTACTS_QUEUE_PARALLELISM,
} from '@/lib/qstash'
```

```javascript
/**
 * QStash 400s on colons in Upstash-Deduplication-Id (undocumented; bit us
 * 2026-07-17). Dashes and digits only.
 */
function dedupId(op, e164) {
  return `zoom-contact-${op}-${e164.replace(/\D/g, '')}`
}

/**
 * Builds the diff and enqueues one QStash job per write. Performs no Zoom
 * writes itself — the worker route does those, one per delivery.
 *
 * @param {object} opts
 * @param {object} [opts.db] — Supabase server client; required unless dry-run has no db need
 * @param {boolean} [opts.dry] — compute and return the diff, enqueue nothing
 * @param {number} [opts.limit] — enqueue at most N jobs (creates first)
 */
export async function runZoomContactSync({ db, dry = false, limit = null } = {}) {
  if (!zoomConfigured()) return { skipped: 'unconfigured' }

  const desiredRes = await buildDesiredContacts(db)
  if (!desiredRes.ok) return { ok: false, error: desiredRes.error }

  const existingRes = await listOwnedContacts()
  if (!existingRes.ok) return { ok: false, error: existingRes.error }

  const diff = diffContacts(desiredRes.desired, existingRes.contacts)
  const guard = applyDeletionGuard(diff.deletes, existingRes.contacts.size)

  const counts = {
    creates: diff.creates.length,
    updates: diff.updates.length,
    deletes: guard.deletes.length,
  }

  if (dry) {
    return {
      ok: !guard.tripped, dry: true, counts,
      guardTripped: guard.tripped, guard, stats: desiredRes.stats,
      ownedInZoom: existingRes.contacts.size,
    }
  }

  // Creates first: on a cold start they are the whole job, and a limit should
  // spend itself on getting names onto handsets rather than on tidying.
  const jobs = [
    ...diff.creates.map((c) => ({ op: 'create', ...c })),
    ...diff.updates.map((u) => ({ op: 'update', ...u })),
    ...guard.deletes.map((d) => ({ op: 'delete', ...d })),
  ]
  const capped = Number.isFinite(limit) && limit > 0 ? jobs.slice(0, limit) : jobs

  if (capped.length > 0) {
    await ensureQueue(ZOOM_CONTACTS_QUEUE_NAME, ZOOM_CONTACTS_QUEUE_PARALLELISM)
  }

  let enqueued = 0
  const failures = []
  for (const job of capped) {
    const res = await publishQueuePush({
      path: ZOOM_CONTACTS_WORKER_PATH,
      body: job,
      deduplicationId: dedupId(job.op, job.e164),
      queueName: ZOOM_CONTACTS_QUEUE_NAME,
      queueParallelism: ZOOM_CONTACTS_QUEUE_PARALLELISM,
    })
    if (res.ok) enqueued++
    else failures.push(`${job.op} ${job.e164}: ${res.error ?? 'skipped'}`)
  }

  return {
    ok: !guard.tripped && failures.length === 0,
    counts,
    enqueued,
    limited: capped.length < jobs.length,
    guardTripped: guard.tripped,
    ...(guard.tripped ? { guard } : {}),
    ...(failures.length ? { failures: failures.slice(0, 10) } : {}),
    stats: desiredRes.stats,
    ownedInZoom: existingRes.contacts.size,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/zoom/`
Expected: PASS — all five zoom test files green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/reconcile.js src/lib/zoom/reconcile.orchestrator.test.js
git commit -m "ZOOMSYNC.1 — reconcile orchestrator with dry-run and limit"
```

---

### Task 9: Cron route

**Files:**
- Create: `src/app/api/cron/zoom-contact-sync/route.js`
- Test: `src/app/api/cron/zoom-contact-sync/route.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/app/api/cron/zoom-contact-sync/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/zoom/reconcile', () => ({ runZoomContactSync: vi.fn() }))

import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { GET } from './route'

const req = (url = 'https://x.test/api/cron/zoom-contact-sync', secret = 'shh') =>
  new Request(url, { headers: { authorization: `Bearer ${secret}` } })

beforeEach(() => {
  process.env.CRON_SECRET = 'shh'
  vi.mocked(runZoomContactSync).mockResolvedValue({ ok: true, counts: { creates: 1, updates: 0, deletes: 0 }, enqueued: 1 })
  vi.mocked(stampHeartbeat).mockClear()
})

describe('GET /api/cron/zoom-contact-sync', () => {
  it('401s without the cron secret', async () => {
    const res = await GET(new Request('https://x.test/', { headers: { authorization: 'Bearer wrong' } }))
    expect(res.status).toBe(401)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  it('runs the sync and stamps the heartbeat', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, enqueued: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('zoom-contact-sync')
  })

  it('passes ?limit through as a number', async () => {
    await GET(req('https://x.test/api/cron/zoom-contact-sync?limit=200'))
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].limit).toBe(200)
  })

  it('passes ?dry=1 through', async () => {
    await GET(req('https://x.test/api/cron/zoom-contact-sync?dry=1'))
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].dry).toBe(true)
  })

  it('reports success:false when the guard trips', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true, counts: { creates: 0, updates: 0, deletes: 0 }, enqueued: 0,
    })
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ success: false, guardTripped: true })
  })

  it('reports success for a clean unconfigured skip', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({ skipped: 'unconfigured' })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, skipped: 'unconfigured' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/cron/zoom-contact-sync/route.test.js`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/app/api/cron/zoom-contact-sync/route.js
//
// ZOOMSYNC.1 — nightly Vercel cron. Reconciles Zoom Phone's external-contacts
// directory against the CRM so inbound member calls show a name. Thin
// CRON_SECRET-guarded wrapper; runZoomContactSync (src/lib/zoom/reconcile.js)
// is the tested body — same skeleton as homey-reconcile.
//
// Operator query params (the scheduled run passes neither):
//   ?limit=N — enqueue at most N writes, creates first. Used for the go-live
//              pilot so a handset can be checked before 6,330 records move.
//   ?dry=1   — compute and return the diff, enqueue nothing. First thing to
//              reach for when the deletion guard trips.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null
  const dry = url.searchParams.get('dry') === '1'

  const db = createServerClient()
  const out = await runZoomContactSync({ db, dry, limit })

  await stampHeartbeat('zoom-contact-sync').catch((err) =>
    logWarn('cron-zoom-contact-sync', 'heartbeat failed', { err }))

  // `out.ok !== false` deliberately, matching homey-reconcile: the
  // unconfigured skip carries no `ok` key and is not a dead cron. A tripped
  // deletion guard DOES set ok:false and should show red — that is the point
  // of the guard.
  return NextResponse.json({ success: out.ok !== false, ...out })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/cron/zoom-contact-sync/route.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/zoom-contact-sync/
git commit -m "ZOOMSYNC.1 — cron route with dry-run and pilot limit"
```

---

### Task 10: QStash worker route

**Files:**
- Create: `src/app/api/webhooks/qstash/zoom-contacts/route.js`
- Test: `src/app/api/webhooks/qstash/zoom-contacts/route.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/app/api/webhooks/qstash/zoom-contacts/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/qstash', () => ({
  verifyQStashSignature: vi.fn(() => ({ ok: true, matched: 'current' })),
  ZOOM_CONTACTS_WORKER_PATH: '/api/webhooks/qstash/zoom-contacts',
}))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://x.test') }))
vi.mock('@/lib/zoom/external-contacts', () => ({
  createContact: vi.fn(async () => ({ ok: true })),
  updateContact: vi.fn(async () => ({ ok: true })),
  deleteContact: vi.fn(async () => ({ ok: true })),
}))

import { verifyQStashSignature } from '@/lib/qstash'
import { createContact, updateContact, deleteContact } from '@/lib/zoom/external-contacts'
import { POST } from './route'

const post = (body) => new Request('https://x.test/api/webhooks/qstash/zoom-contacts', {
  method: 'POST',
  headers: { 'upstash-signature': 'sig' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  vi.mocked(verifyQStashSignature).mockReturnValue({ ok: true, matched: 'current' })
  vi.mocked(createContact).mockResolvedValue({ ok: true })
  vi.mocked(updateContact).mockResolvedValue({ ok: true })
  vi.mocked(deleteContact).mockResolvedValue({ ok: true })
})

describe('POST /api/webhooks/qstash/zoom-contacts', () => {
  it('401s on a bad signature', async () => {
    vi.mocked(verifyQStashSignature).mockReturnValue({ ok: false, reason: 'malformed' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(401)
    expect(createContact).not.toHaveBeenCalled()
  })

  it('503s when our own signing keys are unset', async () => {
    vi.mocked(verifyQStashSignature).mockReturnValue({ ok: false, reason: 'missing_keys' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(503)
  })

  it('applies a create', async () => {
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' }))
    expect(res.status).toBe(200)
    expect(createContact).toHaveBeenCalledWith({ e164: '+353871111111', name: 'Aoife Ryan', contactId: 'u1' })
  })

  it('applies an update', async () => {
    const res = await POST(post({ op: 'update', e164: '+353871111111', name: 'New', contactId: 'u2', zoomId: 'z1' }))
    expect(res.status).toBe(200)
    expect(updateContact).toHaveBeenCalledWith({ zoomId: 'z1', name: 'New', contactId: 'u2' })
  })

  it('applies a delete', async () => {
    const res = await POST(post({ op: 'delete', e164: '+353871111111', zoomId: 'z1' }))
    expect(res.status).toBe(200)
    expect(deleteContact).toHaveBeenCalledWith({ zoomId: 'z1' })
  })

  it('400s on an unknown op without retrying forever', async () => {
    const res = await POST(post({ op: 'explode', e164: '+353871111111' }))
    expect(res.status).toBe(400)
  })

  it('400s on malformed JSON', async () => {
    const req = new Request('https://x.test/api/webhooks/qstash/zoom-contacts', {
      method: 'POST', headers: { 'upstash-signature': 'sig' }, body: 'not json',
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('500s on a Zoom failure so QStash retries', async () => {
    vi.mocked(createContact).mockResolvedValue({ ok: false, error: 'zoom 500' })
    const res = await POST(post({ op: 'create', e164: '+353871111111', name: 'A', contactId: 'u1' }))
    expect(res.status).toBe(500)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/webhooks/qstash/zoom-contacts/route.test.js`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/app/api/webhooks/qstash/zoom-contacts/route.js
//
// ZOOMSYNC.1 — push-delivery worker for the zoom-contacts queue. Applies
// exactly one external-contact write per delivery.
//
// Status-code contract with QStash retries:
//   200 — applied (including the idempotent 409-duplicate and 404-already-gone
//         cases, which external-contacts.js already folds into ok:true)
//   400 — the job is malformed; retrying will never help
//   401 — signature rejected (QStash retries; a rotated key heals it)
//   503 — OUR signing keys are unset, i.e. we are misconfigured, not them
//   500 — Zoom failed; QStash should retry, and the write is idempotent

import { NextResponse } from 'next/server'
import { verifyQStashSignature, ZOOM_CONTACTS_WORKER_PATH } from '@/lib/qstash'
import { getAppUrl } from '@/lib/app-url'
import { createContact, updateContact, deleteContact } from '@/lib/zoom/external-contacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

export async function POST(request) {
  // Raw body FIRST — the signature hashes the exact bytes delivered, so any
  // parse-then-restringify would break verification.
  const rawBody = await request.text()

  let expectedUrl
  try {
    expectedUrl = `${getAppUrl()}${ZOOM_CONTACTS_WORKER_PATH}`
  } catch {
    expectedUrl = undefined
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl,
  })
  if (!verdict.ok) {
    console.warn(`[qstash zoom-contacts worker] delivery rejected: ${verdict.reason}`)
    return NextResponse.json(
      { success: false, error: verdict.reason },
      { status: statusForVerifyFailure(verdict.reason) },
    )
  }

  let job
  try { job = JSON.parse(rawBody) } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  let result
  if (job?.op === 'create' && job.e164 && job.name) {
    result = await createContact({ e164: job.e164, name: job.name, contactId: job.contactId })
  } else if (job?.op === 'update' && job.zoomId && job.name) {
    result = await updateContact({ zoomId: job.zoomId, name: job.name, contactId: job.contactId })
  } else if (job?.op === 'delete' && job.zoomId) {
    result = await deleteContact({ zoomId: job.zoomId })
  } else {
    return NextResponse.json({ success: false, error: 'unknown_op' }, { status: 400 })
  }

  if (!result.ok) {
    console.error(`[qstash zoom-contacts worker] ${job.op} failed: ${result.error}`)
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, op: job.op })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/webhooks/qstash/zoom-contacts/route.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/webhooks/qstash/zoom-contacts/
git commit -m "ZOOMSYNC.1 — qstash worker applying one external-contact write"
```

---

### Task 11: Register the cron and document go-live

**Files:**
- Modify: `vercel.json`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Register the cron**

In `vercel.json`, add to the `crons` array alongside the existing entries (match the one-line style used at the end of the array):

```json
{ "path": "/api/cron/zoom-contact-sync", "schedule": "30 4 * * *" }
```

- [ ] **Step 2: Verify the JSON parses**

Run: `node -e "console.log(require('./vercel.json').crons.filter(c => c.path.includes('zoom')))"`
Expected: `[ { path: '/api/cron/zoom-contact-sync', schedule: '30 4 * * *' } ]`

- [ ] **Step 3: Add the changelog entry**

Prepend to the current section of `docs/CHANGELOG.md`, following the existing entry style:

```markdown
- **ZOOMSYNC.1 — Zoom Phone contact sync.** Nightly reconcile pushing every
  distinct CRM phone number into Zoom Phone's external-contacts directory, so
  inbound member calls show a name instead of a raw number. ClassPass excluded;
  on a shared number the oldest profile supplies the name. Deletes guarded at
  `max(20, 5%)`. **Ships dark** — set `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID` and
  `ZOOM_CLIENT_SECRET` in Vercel to activate. Expected steady state ~6,330
  entries. Go-live: run `?dry=1` first, then `?limit=200`, confirm a name shows
  on a real handset, then let the cold start drain.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — no pre-existing test broken. Pay attention to `src/lib/phone-validate.test.js`, the one file where Task 2 changed shared behaviour.

- [ ] **Step 5: Commit**

```bash
git add vercel.json docs/CHANGELOG.md
git commit -m "ZOOMSYNC.1 — register nightly cron, document go-live"
```

---

## Go-live (not code — for whoever operates this)

1. Create a **Server-to-Server OAuth** app in the Zoom marketplace. Grant it read and write on Zoom Phone external contacts. Exact granular scope strings vary by account tier — read them off the app's Scopes tab rather than guessing.
2. Set `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` in Vercel. Until all three are set the cron returns `skipped: unconfigured` and does nothing.
3. `GET /api/cron/zoom-contact-sync?dry=1` with the cron secret. Expect roughly `creates: 6330, updates: 0, deletes: 0`. A wildly different number means stop and investigate before writing anything.
4. `GET /api/cron/zoom-contact-sync?limit=200`. Wait for the queue to drain.
5. **Ring the studio from a number you know is in the CRM and confirm the name appears on the actual handset.** This is the step the whole rollout exists to protect — Zoom Phone Appliances and Yealink desk phones surface the shared directory differently from the Workplace app, and that has not been verified on this hardware.
6. Let the nightly run drain the rest, or trigger once without a limit. If you want to de-risk the timing first, `?limit=1000` a few times — runs are idempotent and self-resuming, so there is no cost to going in stages.
7. Confirm in the Zoom admin portal that the directory holds ~6,330 entries **and that hand-added contacts are still present**.

### If the deletion guard trips

The run returns `success: false` with `guardTripped: true`, applies the creates and updates, and suppresses **every** delete. That is deliberate — it is the tripwire for a broken desired-state query about to wipe the directory.

It does not clear itself. Suppressing the deletes keeps the directory large, so the same batch trips the same threshold again the following night, forever, until someone intervenes.

1. `?dry=1` — returns the diff plus a `sample` of the first ten numbers it intended to delete. Read them.
2. If they are genuinely gone from the CRM and should go from Zoom, `?force=1` runs once with the guard bypassed.
3. If they are not, the desired-state query is broken. Fix that first — the guard just did its job.

## Outstanding, not solved by this plan

- **Data protection.** ~6,330 members' names and numbers land in Zoom's cloud directory, visible to every Zoom Phone user on the account, making Zoom a processor for that data. Needs a privacy-notice line and a ROPA entry before step 4.
- The 35 unnormalisable rows are logged each run but not repaired. That is data entry, not code.

---

## Executed — deviations from this plan

The code above is what was *proposed*. Execution found seven defects in it, four of which would have shipped silently. This section records what was actually built, so the plan is not misleading to the next reader. Where this section and the tasks above disagree, **this section is correct**.

**The normaliser (Task 1) was rewritten twice.**

- It no longer strips all non-digits. `s.replace(/\D/g, '')` could not distinguish a legitimate separator from junk, so junk sitting *between* digits spliced the survivors into a plausible-looking wrong number. Verified against live data: 8 non-ClassPass rows — curly quotes, stray symbols, an email address with digits in it — produced fabricated E.164 numbers that would have published under real members' names. Now an explicit separator allowlist, rejecting anything else.
- It strips Unicode direction marks (U+202A–U+202C) before testing for a leading `+`. WhatsApp and iOS wrap pasted numbers in these and `.trim()` does not remove them, so a real `+` was invisible to `startsWith('+')`.
- It disambiguates UK `07…` national numbers from Irish ones, gated on length (IE mobile is `08X`+7 = 10 digits, UK is `07`+9 = 11, no overlap). 4 live rows would otherwise have become fabricated `+353` numbers.

**`pickWinner` (Task 5) uses an explicit `Number.isNaN` check.** The plan's `Date.parse(…) || Number.MAX_SAFE_INTEGER` treats the Unix epoch as unparseable, because `Date.parse` returns `0` for it and `0` is falsy — so a row dated 1970-01-01 sorted as *newest*, inverting the oldest-wins rule. No rows hit it today, but `created_at` is nullable and imported data could.

**`diffContacts` (Task 6) compares names normalised** (trim + NFC) rather than byte-literally. Zoom may canonicalise a name on save, and accented names can differ by Unicode composition form — either would make the same entry "differ" every night forever, generating endless pointless writes that never converge.

**The orchestrator (Task 8) gained two things.**

- `force`, to override the deletion guard for one run. Without it a legitimately large cleanup can never drain: suppressing the deletes keeps the directory large, so the same batch trips the same threshold every night, permanently.
- Bounded-concurrency publishing, batches of 25. The plan's sequential loop needed 5–15 minutes to enqueue a 6,330-job cold start against a 300-second cron budget — it would have timed out on the single run that matters most. Safe to parallelise because the queue's own parallelism throttles *delivery* to Zoom; publishing faster only fills the queue quicker.

**Task 2's second guard was reverted.** The plan's test asserted `toMobileE164('+35315551234')` returns null. That assertion was simply wrong — `3531…` is never touched by the trunk-zero repair and always fell through to the generic international branch. Making it pass required rejecting `+353` non-mobiles outright, which silently narrows a live public lead-capture gate. Reverted; the trunk-zero repair alone is the task's scope. The landline question is tracked separately.

**Task 9's test had a stale-mock bug.** `beforeEach` cleared `stampHeartbeat` but not `runZoomContactSync`, and this repo's vitest config sets no `clearMocks`, so three assertions read a call from an earlier test rather than their own.

**Task 11 added a migration the plan omitted.** House convention requires a new cron to seed a `cron_heartbeats` row. Without it `stampHeartbeat('zoom-contact-sync')` updates zero rows every night and logs a warning, leaving the job permanently invisible to monitoring — the exact failure mode that let a dead heart-rate bridge go unnoticed for 17 days. The spec's "no migration" claim was true only of *tables*.
