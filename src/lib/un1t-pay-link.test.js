// UN1TDUN.1 — resolving /pay-link/<token>. The token is looked up only among
// runs of the dunning sequences of un1t.online studios; the invoice is read
// LIVE from un1t.online (the reader is faked at its module boundary) and the
// member is sent to its Stripe hosted page only when it is still open and the
// URL is https on stripe.com. The Stripe URL is never logged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/agent/un1t-member-read', () => ({ openUn1tMemberReader: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Hatch Street', locationName: 'Hatch Street', logoUrl: 'https://cdn.test/logo.png' })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { openUn1tMemberReader } from '@/lib/agent/un1t-member-read'
import { logWarn } from '@/lib/log'
import { Un1tApiError } from '@/lib/un1t-online'
import { resolveUn1tPayLink, safeStripeInvoiceUrl } from './un1t-pay-link.js'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF' // 32 base64url chars, fictional
const STRIPE = 'https://invoice.stripe.com/i/acct_test/test_inv?s=ap'
const HATCH = 'loc-hatch'

function fakeDb(tables, { errors = {} } = {}) {
  const calls = []
  const valueOf = (r, col) => {
    if (!col.includes('->')) return r[col]
    let v = r
    for (const p of col.split(/->>?/)) v = v == null ? undefined : v[p]
    return v == null ? null : String(v)
  }
  return {
    calls,
    from(table) {
      const filters = []
      const call = { table, filters: [] }
      calls.push(call)
      let lim = null
      const run = () => {
        if (errors[table]) return { data: null, error: { message: 'boom' } }
        let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
        if (lim != null) rows = rows.slice(0, lim)
        return { data: rows, error: null }
      }
      const b = {
        select() { return b },
        eq(c, v) { call.filters.push(['eq', c, v]); filters.push((r) => valueOf(r, c) === v); return b },
        in(c, v) { call.filters.push(['in', c, v]); filters.push((r) => v.includes(r[c])); return b },
        not(c, op, v) { call.filters.push(['not', c, op, v]); filters.push((r) => r[c] != null); return b },
        limit(n) { lim = n; return b },
        then(res, rej) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
}

const run = (over = {}) => ({ id: 'e1', sequence_id: 'seq-h', status: 'active', metadata: { payment: { invoice_id: 'in_1', link_suffix: TOKEN, platform: 'un1t_online' } }, ...over })
const tables = (over = {}) => ({
  locations: [
    { id: HATCH, membership_source: 'un1t_online', dunning_sequence_id: 'seq-h' },
    { id: 'loc-still', membership_source: 'glofox', dunning_sequence_id: 'seq-s' },
  ],
  sequence_enrollments: [run()],
  ...over,
})

let getOne
beforeEach(() => {
  vi.clearAllMocks()
  getOne = vi.fn(async () => ({ id: 'in_1', status: 'open', invoice_url: STRIPE }))
  openUn1tMemberReader.mockResolvedValue({ ok: true, studioId: 'studio', getOne })
})

describe('safeStripeInvoiceUrl', () => {
  it('accepts https on stripe.com and its subdomains only', () => {
    expect(safeStripeInvoiceUrl(STRIPE)).toBe(STRIPE)
    expect(safeStripeInvoiceUrl('https://stripe.com/x')).toBe('https://stripe.com/x')
    for (const bad of ['http://invoice.stripe.com/i/x', 'https://invoice.stripe.com.evil.test/i', 'https://evilstripe.com/i', 'https://u:p@invoice.stripe.com/i', 'javascript:alert(1)', '', null, 42]) {
      expect(safeStripeInvoiceUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('resolveUn1tPayLink', () => {
  it('open invoice: redirect to its Stripe page, read live with the studio reader', async () => {
    const db = fakeDb(tables())
    expect(await resolveUn1tPayLink(db, TOKEN)).toEqual({ kind: 'redirect', url: STRIPE })
    expect(openUn1tMemberReader).toHaveBeenCalledWith(db, HATCH)
    expect(getOne).toHaveBeenCalledWith('/invoices/in_1')
    // Looked up only among the un1t studios' dunning sequences.
    const enrolCall = db.calls.find((c) => c.table === 'sequence_enrollments')
    expect(enrolCall.filters).toContainEqual(['in', 'sequence_id', ['seq-h']])
    expect(enrolCall.filters).toContainEqual(['eq', 'metadata->payment->>link_suffix', TOKEN])
  })

  it('a finished run still resolves (the live read decides)', async () => {
    getOne.mockResolvedValue({ status: 'paid', invoice_url: STRIPE })
    const out = await resolveUn1tPayLink(fakeDb(tables({ sequence_enrollments: [run({ status: 'exited' })] })), TOKEN)
    expect(out).toEqual({ kind: 'paid', branding: { companyName: 'UN1T Hatch Street', studioName: 'Hatch Street', logoUrl: 'https://cdn.test/logo.png' } })
  })

  it('paid, void or refunded: the all-paid-up page, never the URL', async () => {
    for (const status of ['paid', 'void', 'refunded']) {
      getOne.mockResolvedValue({ status, invoice_url: STRIPE })
      const out = await resolveUn1tPayLink(fakeDb(tables()), TOKEN)
      expect(out.kind).toBe('paid')
      expect(JSON.stringify(out)).not.toContain('stripe')
    }
  })

  it('unknown, malformed or foreign tokens: not_found, and un1t.online is never called', async () => {
    const cases = [
      [tables({ sequence_enrollments: [] }), TOKEN],
      [tables(), 'short'],
      [tables(), `${TOKEN}/../x`],
      [tables(), null],
      // A Glofox studio's run never resolves here, even with a matching suffix.
      [tables({ sequence_enrollments: [run({ sequence_id: 'seq-s' })] }), TOKEN],
      // A run without the un1t platform marker is not ours.
      [tables({ sequence_enrollments: [run({ metadata: { payment: { invoice_id: 'gf', link_suffix: TOKEN } } })] }), TOKEN],
      [tables({ sequence_enrollments: [run({ metadata: { payment: { platform: 'un1t_online', link_suffix: TOKEN } } })] }), TOKEN],
      [tables({ locations: [] }), TOKEN],
    ]
    for (const [t, tok] of cases) {
      expect(await resolveUn1tPayLink(fakeDb(t), tok)).toEqual({ kind: 'not_found' })
    }
    expect(openUn1tMemberReader).not.toHaveBeenCalled()
  })

  it('un1t.online unreachable, refusing, or answering oddly: try-again page with the studio name, logged without the URL', async () => {
    const outcomes = [
      () => openUn1tMemberReader.mockResolvedValue({ ok: false, reason: 'not_connected' }),
      () => getOne.mockRejectedValue(new Un1tApiError('un1t.online answered HTTP 503', { status: 503 })),
      () => getOne.mockResolvedValue({ status: 'open', invoice_url: 'https://evil.test/pay' }),
      () => getOne.mockResolvedValue({ status: 'open' }),
      () => getOne.mockResolvedValue({ status: 'mystery', invoice_url: STRIPE }),
      () => getOne.mockResolvedValue(null),
    ]
    for (const arrange of outcomes) {
      arrange()
      const out = await resolveUn1tPayLink(fakeDb(tables()), TOKEN)
      expect(out).toEqual({ kind: 'unavailable', branding: { companyName: 'UN1T Hatch Street', studioName: 'Hatch Street', logoUrl: 'https://cdn.test/logo.png' } })
      openUn1tMemberReader.mockResolvedValue({ ok: true, studioId: 'studio', getOne })
    }
    expect(logWarn).toHaveBeenCalled()
    const logged = JSON.stringify(logWarn.mock.calls)
    expect(logged).not.toContain('stripe')
    expect(logged).not.toContain('evil.test')
    expect(logged).not.toContain(TOKEN)
  })

  it('a database failure is a generic try-again, never a not-found', async () => {
    expect(await resolveUn1tPayLink(fakeDb(tables(), { errors: { locations: true } }), TOKEN)).toEqual({ kind: 'unavailable', branding: null })
    expect(await resolveUn1tPayLink(fakeDb(tables(), { errors: { sequence_enrollments: true } }), TOKEN)).toEqual({ kind: 'unavailable', branding: null })
  })

  it('two runs carrying the same token resolve nothing', async () => {
    const db = fakeDb(tables({ sequence_enrollments: [run(), run({ id: 'e2' })] }))
    expect(await resolveUn1tPayLink(db, TOKEN)).toEqual({ kind: 'not_found' })
  })
})
