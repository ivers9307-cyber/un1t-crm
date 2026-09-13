// PRESEND.1 — GET /v3.0/users/{memberId}/overdue-invoices, same auth shape as
// the payment-link call: the three integration headers plus
// x-glofox-impersonated-member-id. Live-verified 2026-09-13: answers
// { data: [{ invoice_id, due_date_utc }] } — the member's overdue SUBSCRIPTION
// invoices, newest first, capped at 20.
//
// This is the read behind the dunning pre-send gate, so its failure shape
// matters more than its happy path: the gate FAILS OPEN on anything but a
// clean answer, and it can only do that if this helper never throws and
// reports ok:false instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const MEMBER = '679bfd4c2f6535e4f200078e'
const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'
const OTHER = '11111111-2222-3333-4444-555555555555'

const res = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => body, clone() { return this },
})

describe('getGlofoxOverdueInvoices', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reads the member overdue list with the impersonation header and an abortable signal', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, {
      data: [
        { invoice_id: INVOICE, due_date_utc: '2026-09-11T20:04:12Z' },
        { invoice_id: OTHER, due_date_utc: '2026-08-11T20:04:12Z' },
      ],
    }))
    const r = await getGlofoxOverdueInvoices(creds, { memberId: MEMBER })
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toContain(`/v3.0/users/${MEMBER}/overdue-invoices`)
    expect(init.method).toBe('GET')
    expect(init.headers['x-glofox-impersonated-member-id']).toBe(MEMBER)
    expect(init.headers['x-glofox-branch-id']).toBe('b')
    expect(init.headers['x-api-key']).toBe('k')
    expect(init.headers['x-glofox-api-token']).toBe('t')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(r).toEqual({ ok: true, status: 200, invoiceIds: [INVOICE, OTHER], error: null })
  })

  it('reports an empty list as ok — nothing is overdue for this member', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: [] }))
    expect(await getGlofoxOverdueInvoices(creds, { memberId: MEMBER }))
      .toEqual({ ok: true, status: 200, invoiceIds: [], error: null })
  })

  it('drops rows with no usable invoice_id rather than emitting blanks', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: [{ due_date_utc: 'x' }, { invoice_id: '  ' }, { invoice_id: INVOICE }] }))
    const r = await getGlofoxOverdueInvoices(creds, { memberId: MEMBER })
    expect(r.invoiceIds).toEqual([INVOICE])
  })

  it('a missing data array is ok with nothing in it, not a crash', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, {}))
    expect(await getGlofoxOverdueInvoices(creds, { memberId: MEMBER }))
      .toEqual({ ok: true, status: 200, invoiceIds: [], error: null })
  })

  it('returns ok:false on a 403 and keeps Glofox own message_code', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(403, { message_code: 'FORBIDDEN' }))
    const r = await getGlofoxOverdueInvoices(creds, { memberId: MEMBER })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.invoiceIds).toEqual([])
    expect(r.error).toContain('FORBIDDEN')
  })

  it('treats a 200 with success:false as a failure (GLOFOX-SPEC-2026-09)', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { success: false, message_code: 'BAD_MEMBER' }))
    const r = await getGlofoxOverdueInvoices(creds, { memberId: MEMBER })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('BAD_MEMBER')
  })

  it('refuses invalid args without reaching the network', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    for (const [c, a] of [
      [creds, { memberId: 'not-an-object-id' }],
      [creds, {}],
      [{ branchId: 'b' }, { memberId: MEMBER }],
      [null, { memberId: MEMBER }],
    ]) {
      expect(await getGlofoxOverdueInvoices(c, a)).toEqual({ ok: false, status: 400, invoiceIds: [], error: 'INVALID_ARGS' })
    }
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('defaults its second argument so a bare call cannot throw', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    expect((await getGlofoxOverdueInvoices(creds)).error).toBe('INVALID_ARGS')
  })

  it('reports a timeout as ok:false rather than throwing at the caller', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
    expect(await getGlofoxOverdueInvoices(creds, { memberId: MEMBER }))
      .toEqual({ ok: false, status: 0, invoiceIds: [], error: 'timeout' })
  })

  it('reports a network failure as ok:false', async () => {
    const { getGlofoxOverdueInvoices } = await import('./glofox.js')
    global.fetch.mockRejectedValueOnce(new Error('ECONNRESET'))
    const r = await getGlofoxOverdueInvoices(creds, { memberId: MEMBER })
    expect(r).toEqual({ ok: false, status: 0, invoiceIds: [], error: 'ECONNRESET' })
  })
})
