# Overdue Pay Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every overdue-membership reminder (WhatsApp button and the three emails) carries a Glofox hosted pay link for the exact failed invoice, fetched once when the reminder run starts.

**Architecture:** A new Glofox client helper calls the payment-link endpoint with member impersonation. A new `dunning-payment.js` turns the result into a `payment` object stored on the run's `sequence_enrollments.metadata` by both entry points (invoice webhook, manual "Send payment reminder"). The WhatsApp and email step senders read that object back: two reserved WhatsApp variable names and two email merge tags. The gallery template is updated to use them and the installer refuses to install while the new WhatsApp template is not approved.

**Tech Stack:** Next.js 16 route handlers, Supabase (service role in lib code), vitest, existing `glofoxFetch` wrapper. No migration: `sequence_enrollments.metadata` is an existing jsonb column.

**Spec:** `docs/superpowers/specs/2026-09-12-overdue-pay-link-design.md`

**Worktree:** `/Users/richardivers/code/un1t-crm-paylink`, branch `overdue-pay-link` off `origin/main` (`74cfd0dd`). Run every command from there. Tests: `npx vitest run <file>`. Full gate before the PR: `npm test && npm run lint && npm run check:guardrails && npm run build`.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/glofox.js` (modify) | `getGlofoxInvoicePaymentLink` — the one Glofox call |
| `src/lib/glofox-payment-link.test.js` (create) | tests for it |
| `src/lib/dunning-payment.js` (create) | run `payment` object: build, capture, read back, email fragments |
| `src/lib/dunning-payment.test.js` (create) | tests for it |
| `src/lib/sequences/enrol.js` (modify) | `enrolContacts({ metadata })` |
| `src/lib/sequences/enrol.test.js` (modify) | metadata on insert + re-activation |
| `src/lib/dunning.js` (modify) | capture before auto-enrol |
| `src/lib/dunning.test.js` (modify) | asserts `metadata.payment` reaches `enrolContacts` |
| `src/app/api/webhooks/glofox/route.js` (modify) | passes `glofoxUserId` |
| `src/app/api/churn-radar/action/route.js` (modify) | newest PAST_DUE membership invoice → capture → metadata |
| `src/lib/whatsapp.js` (modify) | reserved names `pay_amount`, `pay_link_suffix` |
| `src/lib/whatsapp-template-components.test.js` (modify) | tests for them |
| `src/lib/sequences/steps.js` (modify) | WhatsApp: pass payment, URL-button skip rule. Email: two extras |
| `src/lib/sequences/steps.test.js` (modify) | skip rule + email extras |
| `src/lib/postmark.js` (modify) | `{{pay_amount_phrase}}`, `{{payment_cta}}` |
| `src/lib/merge-tags.test.js` or `src/lib/postmark.test.js` (modify) | tag rendering |
| `src/lib/sequence-templates.js` (modify) | gallery template copy + variables |
| `src/lib/sequence-templates.test.js` (modify) | updated pins |
| `src/lib/sequences/template-install.js` (modify) | `missingWhatsappTemplateNames` |
| `src/lib/sequences/template-install.test.js` (modify) | tests for it |
| `src/app/api/sequences/from-template/route.js` (modify) | 409 guard |
| `docs/CHANGELOG.md` (modify) | row keyed by the PR number, added after `gh pr create` |

---

### Task 1: Glofox payment-link helper

**Files:**
- Modify: `src/lib/glofox.js` (append after `cancelGlofoxMembership`, near line 1370; `GLOFOX_OBJECT_ID_RE` is defined at line 1292)
- Create: `src/lib/glofox-payment-link.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/glofox-payment-link.test.js
// PAYLINK.1 — POST /v3.0/payment-links/invoices/{invoiceID} answers with the
// three integration headers + x-glofox-impersonated-member-id (verified live
// 2026-09-12 on a €209 overdue renewal). The spec's "Bearer member JWT" is
// wrong for integrators: headers alone 403, a Bearer of the api token 401.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const MEMBER = '679bfd4c2f6535e4f200078e'
const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'

const res = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => body, clone() { return this },
})

describe('getGlofoxInvoicePaymentLink', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('posts with the impersonation header and returns the link, amount and summary', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, {
      invoice_id: INVOICE, is_retriable: true,
      invoice_payment_link: `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`,
      invoice_summary: 'Month to Month Membership (7983610)', invoice_amount: 20900, invoice_currency: 'EUR',
      utc_invoice_timestamp: '2026-09-11T20:04:12Z',
    }))
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE })
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toContain(`/v3.0/payment-links/invoices/${INVOICE}`)
    expect(init.method).toBe('POST')
    expect(init.headers['x-glofox-impersonated-member-id']).toBe(MEMBER)
    expect(init.headers['x-glofox-api-token']).toBe('t')
    expect(r).toEqual({
      ok: true, status: 200, retriable: true, invoiceId: INVOICE,
      link: `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`,
      amountCents: 20900, currency: 'EUR', summary: 'Month to Month Membership (7983610)', error: null,
    })
  })

  it('a non-retriable invoice is ok:true with no link (a fee, or Glofox mid-retry)', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { invoice_id: INVOICE, is_retriable: false }))
    const r = await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE })
    expect(r).toMatchObject({ ok: true, retriable: false, link: null, amountCents: null, currency: null, error: null })
  })

  it('a non-2xx is reported, never read as "no link"', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(403, { code: 'NOT_AUTHORIZED' }))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 403, link: null, error: 'Glofox HTTP 403' })
  })

  it('refuses bad ids locally without calling Glofox', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: 'nope', invoiceId: INVOICE })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: '' })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(await getGlofoxInvoicePaymentLink(null, { memberId: MEMBER, invoiceId: INVOICE })).toMatchObject({ ok: false, status: 400, error: 'INVALID_ARGS' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a thrown fetch becomes ok:false with the message', async () => {
    const { getGlofoxInvoicePaymentLink } = await import('./glofox.js')
    global.fetch.mockRejectedValueOnce(new Error('socket hang up'))
    expect(await getGlofoxInvoicePaymentLink(creds, { memberId: MEMBER, invoiceId: INVOICE }))
      .toMatchObject({ ok: false, status: 0, link: null, error: 'socket hang up' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/glofox-payment-link.test.js`
Expected: 5 failed, `getGlofoxInvoicePaymentLink is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/glofox.js` (after the membership-cancellation section):

```js
// ─────────────────────────────────────────────────────────────
// Invoice payment link (PAYLINK.1)
// ─────────────────────────────────────────────────────────────
//
// Live probe 2026-09-12: POST /v3.0/payment-links/invoices/{invoiceID}
// answers with the three integration headers + x-glofox-impersonated-
// member-id (the member's Glofox _id). The spec says "Bearer member JWT";
// for an integrator that is wrong — headers alone 403, a Bearer of the api
// token 401, impersonation 200. `is_retriable:false` means the invoice
// cannot be paid by link right now (a custom fee, or Glofox mid-retry).

/**
 * @param {{branchId, apiKey, apiToken}} creds
 * @param {{ memberId: string, invoiceId: string }} args
 * @returns {Promise<{ ok:boolean, status:number, retriable:boolean, link:string|null,
 *   amountCents:number|null, currency:string|null, summary:string|null,
 *   invoiceId:string|null, error:string|null }>}  never throws
 */
export async function getGlofoxInvoicePaymentLink(creds, { memberId, invoiceId } = {}) {
  const empty = (status, error) => ({
    ok: false, status, retriable: false, link: null, amountCents: null, currency: null,
    summary: null, invoiceId: invoiceId || null, error,
  })
  const inv = typeof invoiceId === 'string' ? invoiceId.trim() : ''
  if (!creds?.branchId || !GLOFOX_OBJECT_ID_RE.test(String(memberId || '')) || !inv || inv.length > 200) {
    return empty(400, 'INVALID_ARGS')
  }
  try {
    const r = await glofoxFetch(creds, `/v3.0/payment-links/invoices/${encodeURIComponent(inv)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-glofox-impersonated-member-id': memberId },
      body: '{}',
    })
    if (!r.ok) return empty(r.status, `Glofox HTTP ${r.status}`)
    let body
    try { body = await r.json() } catch { body = null }
    const retriable = body?.is_retriable === true
    const amount = Number(body?.invoice_amount)
    return {
      ok: true, status: r.status, retriable,
      link: retriable && typeof body?.invoice_payment_link === 'string' ? body.invoice_payment_link : null,
      amountCents: retriable && Number.isFinite(amount) ? amount : null,
      currency: retriable && typeof body?.invoice_currency === 'string' ? body.invoice_currency : null,
      summary: retriable && typeof body?.invoice_summary === 'string' ? body.invoice_summary : null,
      invoiceId: typeof body?.invoice_id === 'string' ? body.invoice_id : inv,
      error: null,
    }
  } catch (e) {
    return empty(0, e?.message || 'network error')
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/glofox-payment-link.test.js`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox.js src/lib/glofox-payment-link.test.js
git commit -m "PAYLINK.1 — getGlofoxInvoicePaymentLink via member impersonation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `dunning-payment.js` — the run's payment object

**Files:**
- Create: `src/lib/dunning-payment.js`
- Create: `src/lib/dunning-payment.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/dunning-payment.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  getGlofoxInvoicePaymentLink: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { glofoxCredentialsForLocation, getGlofoxInvoicePaymentLink } = await import('@/lib/glofox')
const {
  paymentRunMetadata, capturePaymentForRun, paymentFromEnrollment, paymentCtaHtml, payAmountPhrase,
} = await import('./dunning-payment.js')

const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'
const LINK = `https://pay.glofox.com/payment-collector/v2/#/i/${INVOICE}`
const CREDS = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const okResult = { ok: true, status: 200, retriable: true, link: LINK, amountCents: 20900, currency: 'EUR', summary: 'Month to Month Membership', invoiceId: INVOICE, error: null }

function dbWith(contact) {
  return { from(table) {
    if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: contact, error: null }) }) }) }
  } }
}

beforeEach(() => {
  vi.mocked(glofoxCredentialsForLocation).mockReset().mockResolvedValue(CREDS)
  vi.mocked(getGlofoxInvoicePaymentLink).mockReset()
})

describe('paymentRunMetadata (pure)', () => {
  it('renders a payable invoice with display money', () => {
    expect(paymentRunMetadata(okResult, { invoiceId: INVOICE, now: new Date('2026-09-12T10:00:00Z') })).toEqual({
      invoice_id: INVOICE, link: LINK, amount: '€209', currency: 'EUR', retriable: true,
      fetched_at: '2026-09-12T10:00:00.000Z', error: null,
    })
  })
  it('a non-retriable or failed result keeps the invoice id and records why, with no link and no amount', () => {
    expect(paymentRunMetadata({ ...okResult, retriable: false, link: null, amountCents: null, currency: null }, { invoiceId: INVOICE }))
      .toMatchObject({ invoice_id: INVOICE, link: null, amount: '', retriable: false, error: 'not_retriable' })
    expect(paymentRunMetadata({ ok: false, status: 403, error: 'Glofox HTTP 403' }, { invoiceId: INVOICE }))
      .toMatchObject({ invoice_id: INVOICE, link: null, amount: '', retriable: false, error: 'Glofox HTTP 403' })
  })
})

describe('capturePaymentForRun (IO, never throws)', () => {
  it('uses the given member id and returns the payment', async () => {
    getGlofoxInvoicePaymentLink.mockResolvedValueOnce(okResult)
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(getGlofoxInvoicePaymentLink).toHaveBeenCalledWith(CREDS, { memberId: '679bfd4c2f6535e4f200078e', invoiceId: INVOICE })
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: LINK, amount: '€209' })
  })
  it('falls back to the contact\'s linked Glofox id when none is given', async () => {
    getGlofoxInvoicePaymentLink.mockResolvedValueOnce(okResult)
    await capturePaymentForRun(dbWith({ glofox_member_id: '679bfd4c2f6535e4f200078e' }), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE })
    expect(getGlofoxInvoicePaymentLink).toHaveBeenCalledWith(CREDS, { memberId: '679bfd4c2f6535e4f200078e', invoiceId: INVOICE })
  })
  it('no member id → no call, payment without link, error named', async () => {
    const { payment } = await capturePaymentForRun(dbWith({ glofox_member_id: null }), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE })
    expect(getGlofoxInvoicePaymentLink).not.toHaveBeenCalled()
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'no_glofox_member_id' })
  })
  it('no credentials → no call, error named', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null })
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'no_glofox_credentials' })
  })
  it('no invoice id → payment with error, nothing called', async () => {
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: null })
    expect(payment).toMatchObject({ invoice_id: null, link: null, error: 'no_invoice_id' })
  })
  it('a helper that throws still yields a payment (error = message)', async () => {
    getGlofoxInvoicePaymentLink.mockRejectedValueOnce(new Error('boom'))
    const { payment } = await capturePaymentForRun(dbWith(null), { locationId: 'loc', contactId: 'c1', invoiceId: INVOICE, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(payment).toMatchObject({ invoice_id: INVOICE, link: null, error: 'boom' })
  })
})

describe('paymentFromEnrollment / email fragments (pure)', () => {
  const payment = { invoice_id: INVOICE, link: LINK, amount: '€209', currency: 'EUR', retriable: true, fetched_at: 'x', error: null }
  it('reads metadata.payment and tolerates every missing shape', () => {
    expect(paymentFromEnrollment({ metadata: { payment } })).toEqual(payment)
    expect(paymentFromEnrollment({ metadata: {} })).toBeNull()
    expect(paymentFromEnrollment({ metadata: null })).toBeNull()
    expect(paymentFromEnrollment(null)).toBeNull()
    expect(paymentFromEnrollment({ metadata: { payment: 'junk' } })).toBeNull()
  })
  it('the CTA fragment carries an escaped link when there is one, else the card-update wording', () => {
    expect(paymentCtaHtml(payment)).toBe(`<a href="${LINK}">pay it now here</a>, it takes a few seconds, or update your card in the Glofox app`)
    expect(paymentCtaHtml({ ...payment, link: 'https://x.test/?a=1&b="2"' })).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"')
    expect(paymentCtaHtml({ ...payment, link: null })).toBe('update your card in the Glofox app')
    expect(paymentCtaHtml(null)).toBe('update your card in the Glofox app')
  })
  it('the amount phrase has a leading space and is empty when unknown', () => {
    expect(payAmountPhrase(payment)).toBe(' of €209')
    expect(payAmountPhrase({ ...payment, amount: '' })).toBe('')
    expect(payAmountPhrase(null)).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/dunning-payment.test.js`
Expected: fails at import, `Cannot find module './dunning-payment.js'`.

- [ ] **Step 3: Implement**

```js
// src/lib/dunning-payment.js
// PAYLINK.1 — the `payment` object an overdue-payment reminder run carries on
// sequence_enrollments.metadata. Fetched ONCE when the run starts (both the
// invoice webhook's auto-enrol and the manual "Send payment reminder" go
// through capturePaymentForRun) and read back by the WhatsApp and email step
// senders, which never call Glofox themselves. One Glofox call per run.
//
// Shape (jsonb, snake_case like the rest of metadata):
//   { invoice_id, link, amount, currency, retriable, fetched_at, error }
// `link` is null unless Glofox said the invoice is payable by link; the
// senders then fall back to the card-update wording (email) or a recorded
// skip (WhatsApp, whose approved template needs the button suffix).

import { glofoxCredentialsForLocation, getGlofoxInvoicePaymentLink } from '@/lib/glofox'
import { formatMoneyMinor } from '@/lib/money-format'
import { logWarn } from '@/lib/log'

const CARD_UPDATE_WORDING = 'update your card in the Glofox app'

/** Pure: helper result → the metadata object. */
export function paymentRunMetadata(result, { invoiceId, now = new Date() } = {}) {
  const payable = Boolean(result?.ok && result?.retriable && result?.link)
  return {
    invoice_id: invoiceId || result?.invoiceId || null,
    link: payable ? result.link : null,
    amount: payable ? formatMoneyMinor(result.amountCents, result.currency || 'EUR') : '',
    currency: payable ? (result.currency || null) : null,
    retriable: payable,
    fetched_at: now.toISOString(),
    error: result?.ok ? (payable ? null : 'not_retriable') : (result?.error || 'unknown'),
  }
}

/**
 * IO: resolve creds + member id, ask Glofox, return { payment }. Never
 * throws — a run must start even when the link cannot be fetched.
 */
export async function capturePaymentForRun(db, { locationId, contactId, invoiceId, glofoxUserId } = {}) {
  const failed = (error) => ({ payment: paymentRunMetadata({ ok: false, error }, { invoiceId: invoiceId || null }) })
  try {
    if (!invoiceId) return failed('no_invoice_id')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds?.branchId || !creds?.apiKey || !creds?.apiToken) return failed('no_glofox_credentials')
    let memberId = glofoxUserId || null
    if (!memberId && contactId) {
      const { data } = await db.from('contacts').select('glofox_member_id').eq('id', contactId).maybeSingle()
      memberId = data?.glofox_member_id || null
    }
    if (!memberId) return failed('no_glofox_member_id')
    const result = await getGlofoxInvoicePaymentLink(creds, { memberId, invoiceId })
    if (!result.ok) logWarn('dunning-payment', 'payment link not fetched', { contactId, invoiceId, error: result.error })
    return { payment: paymentRunMetadata(result, { invoiceId }) }
  } catch (e) {
    logWarn('dunning-payment', 'capturePaymentForRun threw', { contactId, invoiceId, err: e?.message })
    return failed(e?.message || 'threw')
  }
}

/** Pure: the payment object off an enrolment row, or null. */
export function paymentFromEnrollment(enrollment) {
  const p = enrollment?.metadata?.payment
  return p && typeof p === 'object' && !Array.isArray(p) ? p : null
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Pure: the `{{payment_cta}}` fragment. */
export function paymentCtaHtml(payment) {
  const link = payment?.link
  if (!link) return CARD_UPDATE_WORDING
  return `<a href="${escapeHtml(link)}">pay it now here</a>, it takes a few seconds, or ${CARD_UPDATE_WORDING}`
}

/** Pure: the `{{pay_amount_phrase}}` fragment — ' of €209' or ''. */
export function payAmountPhrase(payment) {
  const amount = payment?.amount
  return amount ? ` of ${amount}` : ''
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/dunning-payment.test.js`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dunning-payment.js src/lib/dunning-payment.test.js
git commit -m "PAYLINK.2 — dunning-payment: the run's payment object, capture + fragments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `enrolContacts` carries metadata

**Files:**
- Modify: `src/lib/sequences/enrol.js:56-58` (signature), `:171-180` (insert rows), `:203-231` (re-activation update)
- Modify: `src/lib/sequences/enrol.test.js`

- [ ] **Step 1: Write the failing tests**

Read `src/lib/sequences/enrol.test.js` first: `mockDb({...})` returns `{ db, inserts, updates, ... }` (the exact return shape is at the bottom of `mockDb`; use the same field names the existing "final insert excludes both blocked sets" test reads). Append at the end of the file:

```js
describe('PAYLINK.3 — enrolContacts({ metadata }) rides the row', () => {
  it('writes metadata on a fresh insert and leaves it absent when not given', async () => {
    const m = mockDb({})
    createServerClient.mockReturnValue(m.db)
    await enrolContacts({ sequenceId: 's1', contactIds: ['c1'], sourceType: 'invoice_past_due', sourceRef: 'inv-1', metadata: { payment: { invoice_id: 'inv-1', link: 'https://pay.test/x' } } })
    expect(m.inserts[0][0]).toMatchObject({ contact_id: 'c1', source_ref: 'inv-1', metadata: { payment: { invoice_id: 'inv-1', link: 'https://pay.test/x' } } })

    const m2 = mockDb({})
    createServerClient.mockReturnValue(m2.db)
    await enrolContacts({ sequenceId: 's1', contactIds: ['c1'] })
    expect(m2.inserts[0][0]).not.toHaveProperty('metadata')
  })

  it('a DUNNING.2 re-activation merges metadata OVER the old run but keeps previous_runs', async () => {
    // A completed earlier run outside cooldown, different source_ref → reactivate.
    const m = mockDb({
      history: [{ id: 'e1', contact_id: 'c1', status: 'completed', source_type: 'invoice_past_due', source_ref: 'inv-OLD',
        enrolled_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-08T00:00:00Z', exited_at: null, exit_reason: null, last_processed_at: null,
        metadata: { payment: { invoice_id: 'inv-OLD', link: 'https://pay.test/old' }, previous_runs: [] } }],
      cooldownDays: 14,
    })
    createServerClient.mockReturnValue(m.db)
    const out = await enrolContacts({ sequenceId: 's1', contactIds: ['c1'], sourceType: 'invoice_past_due', sourceRef: 'inv-NEW', allowReenrol: true, metadata: { payment: { invoice_id: 'inv-NEW', link: 'https://pay.test/new' } } })
    expect(out.reactivated).toBe(1)
    const upd = m.updates[0]
    expect(upd.metadata.payment).toEqual({ invoice_id: 'inv-NEW', link: 'https://pay.test/new' })
    expect(upd.metadata.previous_runs).toHaveLength(1)
    expect(upd.metadata.previous_runs[0]).toMatchObject({ source_ref: 'inv-OLD' })
  })
})
```

If `mockDb` does not expose `updates` as an array of update payloads, extend the mock the same way `inserts` is captured (the `update: vi.fn((payload) => { updates.push(payload); return builder })` shape). The existing DUNNING.2 re-activation tests in this file show which history-row fields the mock needs.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/sequences/enrol.test.js`
Expected: the two new tests fail (`metadata` missing on the insert; `upd.metadata.payment` undefined). Existing tests still pass.

- [ ] **Step 3: Implement**

In `src/lib/sequences/enrol.js`:

```js
export async function enrolContacts({
  sequenceId, contactIds, sourceType = 'manual', sourceRef = null, allowReenrol = false,
  // PAYLINK.3 — per-run metadata written onto the enrolment row (e.g. the
  // overdue reminder's `payment` object). Merged over the old run's metadata
  // on a DUNNING.2 re-activation; previous_runs is always kept.
  metadata = null,
}) {
```

Insert rows:

```js
  const runMeta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null
  const toInsert = candidateIds
    .map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      current_step_order: 0,
      status: 'active',
      next_step_at: new Date().toISOString(), // fire on next cron tick
      source_type: sourceType,
      source_ref: sourceRef,
      ...(runMeta ? { metadata: runMeta } : {}),
    }))
```

Re-activation update, the `metadata:` block:

```js
          metadata: {
            ...prevMeta,
            ...(runMeta || {}),
            previous_runs: [
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/sequences/enrol.test.js src/lib/sequences/cooldown.test.js`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/enrol.js src/lib/sequences/enrol.test.js
git commit -m "PAYLINK.3 — enrolContacts({ metadata }) on insert and re-activation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Capture on the automatic path (webhook → `maybeEnrolDunning`)

**Files:**
- Modify: `src/lib/dunning.js:25-28` (imports), `:87` (signature), `:115-124` (enrol call)
- Modify: `src/lib/dunning.test.js`
- Modify: `src/app/api/webhooks/glofox/route.js:325`

- [ ] **Step 1: Write the failing test**

In `src/lib/dunning.test.js` add the mock next to the others at the top:

```js
vi.mock('@/lib/dunning-payment', () => ({ capturePaymentForRun: vi.fn() }))
const { capturePaymentForRun } = await import('@/lib/dunning-payment')
```

and in `beforeEach`: `vi.mocked(capturePaymentForRun).mockReset().mockResolvedValue({ payment: { invoice_id: 'inv-1', link: null, amount: '', error: 'not_retriable' } })`.

Append inside `describe('maybeEnrolDunning')`, modelled on the existing "enrols" test (copy its `fakeDb` arguments and the `paymentTroubleKind` mock so the gates pass):

```js
  it('PAYLINK.4 — captures the invoice payment link once and hands it to enrolContacts as metadata', async () => {
    paymentTroubleKind.mockReturnValue('overdue')
    enrolContacts.mockResolvedValue({ enrolled: 1 })
    capturePaymentForRun.mockResolvedValueOnce({ payment: { invoice_id: 'inv-1', link: 'https://pay.test/inv-1', amount: '€209', currency: 'EUR', retriable: true, fetched_at: 'x', error: null } })
    const db = fakeDb({ location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true }, sequence: ACTIVE_SEQ, contact: { glofox_membership_state: 'active' } })
    const out = await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'inv-1', isMembership: true, glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(out).toMatchObject({ enrolled: 1 })
    expect(capturePaymentForRun).toHaveBeenCalledWith(db, { locationId: 'loc', contactId: 'c1', invoiceId: 'inv-1', glofoxUserId: '679bfd4c2f6535e4f200078e' })
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'invoice_past_due', sourceRef: 'inv-1', allowReenrol: true,
      metadata: { payment: expect.objectContaining({ invoice_id: 'inv-1', link: 'https://pay.test/inv-1' }) },
    }))
  })

  it('PAYLINK.4 — a failed capture still enrols (link null, error kept)', async () => {
    paymentTroubleKind.mockReturnValue('overdue')
    enrolContacts.mockResolvedValue({ enrolled: 1 })
    capturePaymentForRun.mockResolvedValueOnce({ payment: { invoice_id: 'inv-1', link: null, amount: '', error: 'Glofox HTTP 503' } })
    const db = fakeDb({ location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true }, sequence: ACTIVE_SEQ, contact: { glofox_membership_state: 'active' } })
    await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'inv-1', isMembership: true })
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ metadata: { payment: expect.objectContaining({ link: null, error: 'Glofox HTTP 503' }) } }))
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/dunning.test.js`
Expected: the two new tests fail (`capturePaymentForRun` not called / `metadata` missing).

- [ ] **Step 3: Implement**

`src/lib/dunning.js` imports:

```js
import { enrolContacts } from '@/lib/sequences'
import { setEnrollmentStatus } from '@/lib/sequences/scheduler'
import { paymentTroubleKind } from '@/lib/churn-radar'
import { capturePaymentForRun } from '@/lib/dunning-payment'
import { logWarn } from '@/lib/log'
```

Signature and enrol call:

```js
export async function maybeEnrolDunning(db, locationId, contactId, { invoiceId, isMembership, glofoxUserId } = {}) {
  ...
    if (!kind) return { enrolled: 0, reason: 'not_behind' }
    // PAYLINK.4 — fetch the invoice's hosted pay link ONCE, here, and ride it
    // on the run. A failed fetch never blocks the reminder: the steps fall
    // back to the card-update wording (email) or a recorded skip (WhatsApp).
    const { payment } = await capturePaymentForRun(db, { locationId, contactId, invoiceId: invoiceId || null, glofoxUserId: glofoxUserId || null })
    const res = await enrolContacts({
      sequenceId: seqId,
      contactIds: [contactId],
      sourceType: 'invoice_past_due',
      sourceRef: invoiceId || null,
      allowReenrol: true,
      metadata: { payment },
    })
```

Update the JSDoc block above the function with `@param {string} [opts.glofoxUserId] the invoice's Glofox user id (falls back to contacts.glofox_member_id)`.

`src/app/api/webhooks/glofox/route.js:325`:

```js
          dunningResult = await maybeEnrolDunning(db, creds.locationId, contact.id, {
            invoiceId: ltvResult.invoice_id, isMembership: true,
            // PAYLINK.4 — the invoice's own user id when the parser carried it;
            // capturePaymentForRun falls back to the contact's linked id.
            glofoxUserId: ltvResult.glofox_user_id || ltvResult.parsed?.glofox_user_id || null,
          })
```

Then check what `applyInvoiceWebhook` returns at `src/lib/glofox-invoices.js:200-210` — if it does not expose `glofox_user_id`, add `glofox_user_id: parsed.glofox_user_id` to that return object (it already has `parsed` in scope) and keep the route line as written.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/dunning.test.js src/lib/glofox-invoices.test.js src/app/api/webhooks/glofox`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dunning.js src/lib/dunning.test.js src/app/api/webhooks/glofox/route.js src/lib/glofox-invoices.js
git commit -m "PAYLINK.4 — auto-enrol captures the pay link and rides it on the run

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Capture on the manual path (Send payment reminder)

**Files:**
- Modify: `src/app/api/churn-radar/action/route.js:210-265`

There is no route test file for this route; the pure pieces are covered in Tasks 2 and 3. Keep the change small and mirror Task 4.

- [ ] **Step 1: Implement**

Add the import near the other `@/lib` imports:

```js
import { capturePaymentForRun } from '@/lib/dunning-payment'
```

Widen the invoice select and pick the newest membership invoice:

```js
    const { data: pastDueInv } = await db
      .from('glofox_invoices')
      .select('id, line_item_subtypes, invoice_date, glofox_user_id, glofox_event:raw_payload->candidate->>glofoxEvent')
      .eq('contact_id', contactId)
      .eq('status', 'PAST_DUE')
      .order('invoice_date', { ascending: false })
      .limit(50)
    const membershipDebts = (pastDueInv || []).filter(isMembershipInvoice)
    const hasMembershipDebt = membershipDebts.length > 0
    // PAYLINK.5 — the newest PAST_DUE membership invoice is the one the pay
    // link is minted for; source_ref stays payment_<kind> (DUNNING.2 re-run
    // semantics), the invoice id rides on metadata.payment.
    const newestDebt = membershipDebts[0] || null
```

Before `enrolContacts`:

```js
    const { payment } = await capturePaymentForRun(db, {
      locationId, contactId, invoiceId: newestDebt?.id || null, glofoxUserId: newestDebt?.glofox_user_id || null,
    })
```

and add `metadata: { payment },` to the `enrolContacts({...})` call.

- [ ] **Step 2: Lint and the route's neighbours**

Run: `npx eslint src/app/api/churn-radar/action/route.js && npx vitest run src/lib/churn-radar`
Expected: no lint errors; churn-radar tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/churn-radar/action/route.js
git commit -m "PAYLINK.5 — Send payment reminder captures the newest membership invoice's pay link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: WhatsApp reserved names + the URL-button skip rule

**Files:**
- Modify: `src/lib/whatsapp.js` (`resolveContactField`, near line 1925)
- Modify: `src/lib/whatsapp-template-components.test.js`
- Modify: `src/lib/sequences/steps.js:26-38` (imports), `:463-470` (variable mapping / components)
- Modify: `src/lib/sequences/steps.test.js` (inside the `sendWhatsappStep — send-time consent gate` describe)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/whatsapp-template-components.test.js`:

```js
describe('PAYLINK.6 — reserved payment names resolve from opts.payment, never the contact', () => {
  const PAY_TEMPLATE = {
    name: 'outstanding_payment_link_',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your membership payment of {{2}} did not go through.' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.glofox.com/payment-collector/v2/#/i/{{1}}', example: ['abc'] }] },
    ],
  }
  const mapping = { '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' }
  const payment = { invoice_id: '0f187762-acc8-42d2-860c-43cbe1477df0', link: 'https://pay.glofox.com/x', amount: '€209' }

  it('fills {{2}} with the amount and the URL button with the invoice id', () => {
    const c = buildTemplateComponents(PAY_TEMPLATE, { ...contact, pay_amount: 'SHOULD-NOT-LEAK' }, mapping, null, { payment })
    expect(c.find((x) => x.type === 'body').parameters.map((p) => p.text)).toEqual(['Richard', '€209'])
    expect(c.find((x) => x.type === 'button')).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '0f187762-acc8-42d2-860c-43cbe1477df0' }] })
  })

  it('with no payment both resolve empty: the amount becomes the blank placeholder and the button is omitted', () => {
    const c = buildTemplateComponents(PAY_TEMPLATE, contact, mapping, null, {})
    expect(c.find((x) => x.type === 'body').parameters.map((p) => p.text)).toEqual(['Richard', ' '])
    expect(c.find((x) => x.type === 'button')).toBeUndefined()
    expect(resolveTemplateVariableValues(PAY_TEMPLATE, contact, mapping, {})).toEqual(['Richard', ''])
  })
})
```

Append inside the `sendWhatsappStep — send-time consent gate + graceful skips` describe in `steps.test.js` (it already has `consentDb`, `consentedContact`, `sequence`, `wa`):

```js
  it('PAYLINK.6 — a pay-link template with no link on the run is a recorded skip, not a send', async () => {
    const db = consentDb()
    const payStep = { ...step, whatsapp_variables: { '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' } }
    const out = await steps.sendWhatsappStep(db, {
      step: payStep, sequence, contact: consentedContact,
      enrollment: { id: 'e1', source_type: 'invoice_past_due', metadata: { payment: { invoice_id: 'inv-1', link: null, amount: '', error: 'not_retriable' } } },
    })
    expect(out).toBeNull()
    expect(wa.sendTemplateMessage).not.toHaveBeenCalled()
    expect(`${db.activityInserts[0].subject} ${db.activityInserts[0].note}`).toMatch(/no payment link/i)
  })

  it('PAYLINK.6 — with a link on the run the payment rides into buildTemplateComponents opts', async () => {
    const db = consentDb()
    const payStep = { ...step, whatsapp_variables: { '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' } }
    const payment = { invoice_id: 'inv-1', link: 'https://pay.test/inv-1', amount: '€209', retriable: true }
    await steps.sendWhatsappStep(db, {
      step: payStep, sequence, contact: consentedContact,
      enrollment: { id: 'e1', source_type: 'invoice_past_due', metadata: { payment } },
    })
    expect(wa.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(wa.buildTemplateComponents.mock.calls[0][4]).toMatchObject({ payment })
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/whatsapp-template-components.test.js src/lib/sequences/steps.test.js`
Expected: the four new tests fail (`{{2}}` resolves to the literal `pay_amount`; the button carries `pay_link_suffix`; the skip test sends).

- [ ] **Step 3: Implement**

`src/lib/whatsapp.js`, `resolveContactField`:

```js
function resolveContactField(fieldName, contact, opts = {}) {
  if (!fieldName) return ''
  if (fieldName === 'first_name') return contact.first_name || contact.name?.split(' ')[0] || ''
  if (fieldName === 'name') return contact.name || ''
  if (fieldName === 'email') return contact.email || ''
  if (fieldName === 'phone') return contact.phone || contact.wa_phone || ''
  if (fieldName === 'location_name') return opts.companyName || 'UN1T'
  // PAYLINK.6 — reserved names for the overdue-payment reminder, resolved
  // from the RUN (opts.payment, off sequence_enrollments.metadata) and never
  // from the contact, so a contact column of the same name can't leak in.
  if (fieldName === 'pay_amount') return opts.payment?.amount || ''
  if (fieldName === 'pay_link_suffix') return opts.payment?.invoice_id || ''
  return contact[fieldName] || fieldName // literal fallback, as today
}
```

`src/lib/sequences/steps.js` — add the import:

```js
import { paymentFromEnrollment, paymentCtaHtml, payAmountPhrase } from '@/lib/dunning-payment'
import { URL_BUTTON_MAPPING_KEY } from '@/lib/whatsapp-template-buttons'
```

In `sendWhatsappStep`, replace the `variableMapping` / `components` block:

```js
  const variableMapping = step.whatsapp_variables || {}
  // PAYLINK.6 — the overdue-payment reminder's pay link rides on the run. A
  // template whose URL button wants the invoice id cannot be sent without one
  // (Meta rejects a dynamic-URL send with no suffix, and a button to an
  // unpayable invoice is worse than silence) → recorded skip; the run's email
  // steps still go out with the card-update wording.
  const payment = paymentFromEnrollment(enrollment)
  if (variableMapping[URL_BUTTON_MAPPING_KEY] === 'pay_link_suffix' && !payment?.link) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'WhatsApp', reason: 'no payment link for this invoice' })
    return null
  }
  const branding = await getLocationBranding(db, sequence.location_id)
  const components = buildTemplateComponents(
    template,
    contact,
    variableMapping,
    step.whatsapp_header_media_url || null,
    { companyName: branding.companyName, locationId: sequence.location_id, payment },
  )
```

Find the `renderTemplateBody(template, contact, variableMapping, { companyName: ... })` call further down in the same function and add `payment` to its opts object too, so the persisted thread body shows the amount.

Add `URL_BUTTON_MAPPING_KEY` to the `vi.mock('@/lib/whatsapp-template-buttons', ...)` in `steps.test.js` only if that module is mocked there; it is not today, so the real constant is used.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/whatsapp-template-components.test.js src/lib/sequences/steps.test.js src/lib/whatsapp`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-template-components.test.js src/lib/sequences/steps.js src/lib/sequences/steps.test.js
git commit -m "PAYLINK.6 — WhatsApp pay_amount / pay_link_suffix from the run; skip without a link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Email merge tags

**Files:**
- Modify: `src/lib/postmark.js:477-505` (`applyMergeTags`)
- Modify: `src/lib/sequences/steps.js:307-315` (`sendEmailStep` extras)
- Modify: `src/lib/merge-tags.test.js` (or the file that already tests `applyMergeTags` — `grep -rln "applyMergeTags" src/lib/*.test.js`)
- Modify: `src/lib/sequences/steps.test.js` (inside `sendEmailStep — marketing consent + broadcast stream`)

- [ ] **Step 1: Write the failing tests**

In the `applyMergeTags` test file:

```js
describe('PAYLINK.7 — payment merge tags', () => {
  it('renders {{pay_amount_phrase}} and {{payment_cta}} from extras, empty when absent', () => {
    const html = '<p>payment{{pay_amount_phrase}} failed. To keep it, {{payment_cta}}.</p>'
    expect(applyMergeTags(html, { first_name: 'A' }, { pay_amount_phrase: ' of €209', payment_cta: '<a href="https://pay.test/x">pay it now here</a>' }))
      .toBe('<p>payment of €209 failed. To keep it, <a href="https://pay.test/x">pay it now here</a>.</p>')
    expect(applyMergeTags(html, { first_name: 'A' }, {})).toBe('<p>payment failed. To keep it, .</p>')
  })
})
```

In `steps.test.js`, inside the `sendEmailStep` describe (reuse its db factory and the consented contact; the existing tests show how `sendMarketingEmail` is mocked and asserted):

```js
  it('PAYLINK.7 — the run\'s payment renders into the email as amount phrase + CTA link', async () => {
    const db = emailDb()
    const payStep = { ...step, html_content: '<p>Your membership payment{{pay_amount_phrase}} failed. To keep it, {{payment_cta}}.</p>' }
    await steps.sendEmailStep(db, {
      step: payStep, sequence, contact: consentedContact,
      enrollment: { id: 'e1', source_type: 'invoice_past_due', metadata: { payment: { invoice_id: 'inv-1', link: 'https://pay.test/inv-1', amount: '€209', retriable: true } } },
    })
    const sent = postmark.sendMarketingEmail.mock.calls[0][0]
    expect(sent.html).toContain('payment of €209 failed')
    expect(sent.html).toContain('<a href="https://pay.test/inv-1">pay it now here</a>, it takes a few seconds, or update your card in the Glofox app')
  })

  it('PAYLINK.7 — no payment on the run → the card-update wording, no empty link', async () => {
    const db = emailDb()
    const payStep = { ...step, html_content: '<p>Your membership payment{{pay_amount_phrase}} failed. To keep it, {{payment_cta}}.</p>' }
    await steps.sendEmailStep(db, { step: payStep, sequence, contact: consentedContact, enrollment: { id: 'e1', source_type: 'invoice_past_due', metadata: {} } })
    const sent = postmark.sendMarketingEmail.mock.calls[0][0]
    expect(sent.html).toContain('Your membership payment failed. To keep it, update your card in the Glofox app.')
    expect(sent.html).not.toContain('href=""')
  })
```

Replace `emailDb`, `step`, `postmark`, `consentedContact` with the identifiers the existing `sendEmailStep` describe actually uses (read lines 766-830 of `steps.test.js` first).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/merge-tags.test.js src/lib/sequences/steps.test.js`
Expected: the new tests fail (tags left un-substituted).

- [ ] **Step 3: Implement**

`src/lib/postmark.js` `applyMergeTags` replacements, after `'{{glofox_passcode}}'`:

```js
    // PAYLINK.7 — the overdue-payment reminder's pay link, resolved by the
    // sequence email step from the run's metadata (dunning-payment.js). Both
    // empty for any other email, so a body that uses them still renders.
    '{{pay_amount_phrase}}': extras.pay_amount_phrase || '',
    '{{payment_cta}}': extras.payment_cta || '',
```

`src/lib/sequences/steps.js` `sendEmailStep`, the `applyMergeTags(html, contact, {...})` call:

```js
  const payment = paymentFromEnrollment(enrollment)
  const merged = applyMergeTags(html, contact, {
    location_name: locationName,
    booking_token: bookingToken,
    unsubscribe_url: unsubscribeUrl,
    preference_url: `${baseUrl}/preferences/${unsubscribeUrl.split('/unsubscribe/')[1]}`,
    // PAYLINK.7 — empty fragments when the run carries no payment.
    pay_amount_phrase: payAmountPhrase(payment),
    payment_cta: paymentCtaHtml(payment),
  })
```

Also add `pay_amount_phrase: payAmountPhrase(payment)` to the subject's `applyMergeTags` extras so a subject may use the amount.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/merge-tags.test.js src/lib/postmark src/lib/sequences/steps.test.js`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/postmark.js src/lib/sequences/steps.js src/lib/merge-tags.test.js src/lib/sequences/steps.test.js
git commit -m "PAYLINK.7 — {{pay_amount_phrase}} and {{payment_cta}} in sequence emails

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Gallery template + install guard

**Files:**
- Modify: `src/lib/sequence-templates.js` (the `overdue_payment_dunning` entry)
- Modify: `src/lib/sequence-templates.test.js:395-440`
- Modify: `src/lib/sequences/template-install.js`
- Modify: `src/lib/sequences/template-install.test.js`
- Modify: `src/app/api/sequences/from-template/route.js:88-96`

- [ ] **Step 1: Write the failing tests**

In `src/lib/sequence-templates.test.js`, replace the DUNNING.6 test `both WhatsApp steps use the approved utility template by NAME with the first name as {{1}}` with:

```js
  it('PAYLINK.8 — both WhatsApp steps use the pay-link template by NAME: first name, amount, and the invoice id on the URL button', () => {
    for (const s of tpl.steps.filter((s) => s.step_type === 'whatsapp')) {
      expect(s.whatsapp_template_name).toBe('outstanding_payment_link_')
      expect(s.whatsapp_variables).toEqual({ '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' })
    }
  })
  it('PAYLINK.8 — every email uses the amount phrase and the CTA fragment, and never a raw pay link', () => {
    for (const s of tpl.steps.filter((s) => s.step_type === 'email')) {
      expect(s.html_content).toContain('{{pay_amount_phrase}}')
      expect(s.html_content).toContain('{{payment_cta}}')
      expect(s.html_content).not.toContain('pay.glofox.com')
    }
  })
```

Keep the existing "email copy is low-key" test; it must still pass (no em-dashes, no emoji, mentions updating the card — `{{payment_cta}}` renders that wording, so also keep the literal phrase "card" in each email body, e.g. in the sentence before the tag).

In `src/lib/sequences/template-install.test.js` append:

```js
describe('PAYLINK.8 — missingWhatsappTemplateNames', () => {
  const rows = [{ id: 'a', name: 'outstanding_payment_', status: 'APPROVED' }, { id: 'b', name: 'outstanding_payment_link_', status: 'PENDING' }]
  it('names the gallery templates that are not APPROVED here, once each', () => {
    const steps = [
      { step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_link_' },
      { step_type: 'email' },
      { step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_link_' },
      { step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_' },
    ]
    expect(missingWhatsappTemplateNames(steps, rows)).toEqual(['outstanding_payment_link_'])
  })
  it('is empty when every named template is approved, or nothing is named', () => {
    expect(missingWhatsappTemplateNames([{ step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_' }], rows)).toEqual([])
    expect(missingWhatsappTemplateNames([{ step_type: 'email' }], rows)).toEqual([])
    expect(missingWhatsappTemplateNames([], null)).toEqual([])
  })
})
```

(add `missingWhatsappTemplateNames` to that file's import from `./template-install.js`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/sequence-templates.test.js src/lib/sequences/template-install.test.js`
Expected: the new tests fail (old template name / variables; `missingWhatsappTemplateNames is not a function`).

- [ ] **Step 3: Implement the gallery template**

Replace the `overdue_payment_dunning` entry's `description` and `steps` in `src/lib/sequence-templates.js`:

```js
    description: 'When a membership payment fails, reminds the member with a Pay now link for that exact invoice: a WhatsApp and an email about an hour after the failure, an email on day 3, and a WhatsApp plus a final email on day 7. Stops as soon as the payment goes through. Needs the approved WhatsApp template outstanding_payment_link_ at this location. Install, review the copy, publish, then pick it under Churn radar → Payment reminders and turn on automatic starts. Fees and class packs never trigger it.',
    ...
    steps: [
      { step_type: 'wait', delay_days: 0, delay_hours: 0 },
      {
        step_type: 'whatsapp',
        delay_days: 0,
        delay_hours: 1,
        whatsapp_template_name: 'outstanding_payment_link_',
        whatsapp_variables: { '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' },
      },
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'A quick heads-up about your payment, {{first_name}}',
        html_content: `<p>Hi {{first_name}},</p>
<p>We tried to take your membership payment{{pay_amount_phrase}} and it didn't go through. It happens, usually a card that has expired or been replaced.</p>
<p>Your membership is still active. To keep it that way, {{payment_cta}}, or reply to this email and we'll sort the card with you.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'email',
        delay_days: 3,
        delay_hours: 0,
        subject: 'Still no luck with your membership payment',
        html_content: `<p>Hi {{first_name}},</p>
<p>Your membership payment{{pay_amount_phrase}} is still outstanding. You can {{payment_cta}}, and we'll take it from there.</p>
<p>If something else is going on with the card or anything else, reply here and we'll figure it out together.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'whatsapp',
        delay_days: 4,
        delay_hours: 0,
        whatsapp_template_name: 'outstanding_payment_link_',
        whatsapp_variables: { '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' },
      },
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Action needed to keep your UN1T membership',
        html_content: `<p>Hi {{first_name}},</p>
<p>Your membership payment{{pay_amount_phrase}} is now a week overdue and we don't want you to lose your spot.</p>
<p>Two minutes fixes it: {{payment_cta}}, or reply to this email and we'll sort the card together. No awkwardness, we just want to keep you training.</p>
<p>UN1T {{location_name}}</p>`,
      },
    ],
```

Update the DUNNING.6 comment above the entry: the WhatsApp copy is now `outstanding_payment_link_` (a Pay now URL button whose suffix is the invoice id) and the emails carry the same link via `{{payment_cta}}`.

- [ ] **Step 4: Implement the install guard**

Append to `src/lib/sequences/template-install.js`:

```js
/**
 * PAYLINK.8 — the WhatsApp template NAMES a gallery template asks for that
 * are not APPROVED at the installing location, distinct, in step order. The
 * install route refuses on a non-empty list: installing with a null template
 * id used to produce a run whose WhatsApp steps all skipped.
 */
export function missingWhatsappTemplateNames(steps, rows) {
  const approved = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.name && String(r.status || '').toUpperCase() === 'APPROVED') approved.add(r.name)
  }
  const out = []
  for (const s of Array.isArray(steps) ? steps : []) {
    const name = s?.step_type === 'whatsapp' ? s.whatsapp_template_name : null
    if (name && !approved.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}
```

`src/app/api/sequences/from-template/route.js`: import `missingWhatsappTemplateNames` alongside `resolveWhatsappTemplateIds`, and move the WhatsApp resolution ABOVE the sequence insert so nothing is written on refusal:

```js
  const db = createServerClient()
  // DUNNING.6 / PAYLINK.8 — resolve WhatsApp steps named by template against
  // this location's approved templates BEFORE writing anything: a name with
  // no approved template here is a clear refusal, not a half-installed run.
  let steps = tpl.steps || []
  if (steps.some((st) => st?.step_type === 'whatsapp' && st.whatsapp_template_name)) {
    const { data: waRows } = await db
      .from('whatsapp_templates')
      .select('id, name, status')
      .eq('location_id', locationId)
    const missing = missingWhatsappTemplateNames(steps, waRows || [])
    if (missing.length > 0) {
      return NextResponse.json({
        success: false,
        error: `WhatsApp template "${missing[0]}" is not approved at this location yet. Create it under WhatsApp → Templates, wait for Meta's approval, then install.`,
      }, { status: 409 })
    }
    steps = resolveWhatsappTemplateIds(steps, waRows || [])
  }
```

and delete the later duplicate `let steps = ...` block (keep `const stepRows = steps.map(...)`).

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/sequence-templates.test.js src/lib/sequences/template-install.test.js src/app/api/sequences`
Expected: all passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sequence-templates.js src/lib/sequence-templates.test.js src/lib/sequences/template-install.js src/lib/sequences/template-install.test.js src/app/api/sequences/from-template/route.js
git commit -m "PAYLINK.8 — gallery reminders carry the pay link; install refuses without the approved template

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Full gate, PR, changelog, memory

- [ ] **Step 1: Full CI mirror + build**

Run: `npm test && npm run lint && npm run check:guardrails && npm run check:route-guards && npm run check:location-scoping && npm run build`
Expected: all green, `0 errors` from lint, build exit 0. Fix anything red before continuing.

- [ ] **Step 2: Live read-only check of the helper**

Write a scratchpad script (in the session scratchpad directory, NOT the repo) that reads the Stillorgan credentials from a JSON file (never on the command line), imports nothing from the repo, and POSTs `/v3.0/payment-links/invoices/0f187762-acc8-42d2-860c-43cbe1477df0` with `x-glofox-impersonated-member-id: 679bfd4c2f6535e4f200078e`. Expected: HTTP 200, `is_retriable` true or false (it may have been paid by now), and no new rows anywhere. Delete the credentials file afterwards.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin overdue-pay-link
gh pr create --title "PAYLINK — overdue reminders carry a Glofox Pay now link for the exact invoice" --body-file - <<'EOF'
(summarise Tasks 1–8, the spec path, verification counts, and Richard's Meta step: create outstanding_payment_link_ as specified in the spec §Decisions 3–4; then install the updated gallery template once approved)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: CHANGELOG row + memory**

Add one row keyed `| #<PR> | PAYLINK — …` directly under the table header in `docs/CHANGELOG.md` (never edit another row), commit, push. Update `~/.claude/projects/-Users-richardivers-code/memory/overdue-card-reminders.md` with: shipped PR number, the two reserved WhatsApp names, the two email tags, the install guard, and the remaining operator steps (create the Meta template, install the updated gallery template once approved, re-pick, pause the old one).

- [ ] **Step 5: Merge**

Only when CI is green and the branch is up to date: `gh pr merge <PR> --squash`. Then `git worktree remove --force ../un1t-crm-paylink` from the primary clone and delete the local branch.
