// GLOFOXREADERS.1 — the invoice CSV import matches rows to the studio's
// contacts AND its Glofox members whose contact lives at a sibling studio,
// reads past the 1,000-row cap, and never reads a failed lookup as "no match".
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ contacts: [], crossover: [], crossoverErr: null, contactsErr: null, contactQueries: [] }))

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ role: 'master', activeLocation: { id: 'loc-still' } })) }))
vi.mock('@/lib/glofox-invoices', () => ({
  parseInvoicePayload: vi.fn((n) => ({ invoice_id: n.Payload.id })),
  upsertGlofoxInvoice: vi.fn(async () => ({ ok: true })),
  recomputeContactLifetimeValue: vi.fn(async () => ({})),
}))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const q = { table, ors: [], eqs: [], range: null }
      const b = {}
      b.select = () => b
      b.order = () => b
      b.eq = (c, v) => { q.eqs.push([c, v]); return b }
      b.in = () => b
      b.or = (v) => { q.ors.push(v); return b }
      b.range = (from, to) => { q.range = [from, to]; return b }
      b.then = (resolve) => {
        if (table === 'studio_contacts') {
          return resolve(h.crossoverErr ? { data: null, error: h.crossoverErr } : { data: h.crossover.map((r) => ({ id: r.contact_id })), error: null })
        }
        if (table === 'contacts') {
          h.contactQueries.push(q)
          if (h.contactsErr) return resolve({ data: null, error: h.contactsErr })
          const [from, to] = q.range ?? [0, 999]
          return resolve({ data: h.contacts.slice(from, Math.min(to, from + 999) + 1), error: null })
        }
        return resolve({ data: null, error: null })
      }
      return b
    },
  }),
}))

import { POST } from './route.js'
import { upsertGlofoxInvoice } from '@/lib/glofox-invoices'

const upload = (csv) => {
  const fd = new FormData()
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'x.csv')
  fd.append('location_id', 'loc-still')
  return POST(new Request('http://localhost/api/admin/glofox-invoice-csv-import', { method: 'POST', body: fd }))
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(h, { contacts: [], crossover: [], crossoverErr: null, contactsErr: null, contactQueries: [] })
})

describe('POST /api/admin/glofox-invoice-csv-import — contact matching', () => {
  it('matches a Glofox member whose contact lives at a sibling studio, through the crossover scope', async () => {
    h.crossover = [{ contact_id: 'c-hatch' }]
    h.contacts = [{ id: 'c-hatch', email: 'craig@x.com', glofox_member_id: 'g-craig' }]
    const body = await (await upload('invoice_id,member_id,amount\ninv-1,g-craig,10\n')).json()
    expect(body).toMatchObject({ ok: true, upserted: 1, skipped: 0 })
    expect(upsertGlofoxInvoice.mock.calls[0][2]).toBe('c-hatch')
    expect(h.contactQueries[0].ors).toEqual(['location_id.eq.loc-still,id.in.(c-hatch)'])
  })

  it('reads every page: a contact past the first 1,000 is still matched', async () => {
    h.contacts = Array.from({ length: 1500 }, (_, i) => ({ id: `c${i}`, email: `p${i}@x.com`, glofox_member_id: `g${i}` }))
    const body = await (await upload('invoice_id,member_id,amount\ninv-1,g1400,10\n')).json()
    expect(body).toMatchObject({ ok: true, upserted: 1 })
    expect(upsertGlofoxInvoice.mock.calls[0][2]).toBe('c1400')
    expect(h.contactQueries.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('a failed contacts read is a 500, never a file full of "no_matching_contact"', async () => {
    h.contactsErr = { message: 'timeout' }
    const res = await upload('invoice_id,member_id,amount\ninv-1,g1,10\n')
    expect(res.status).toBe(500)
    expect(upsertGlofoxInvoice).not.toHaveBeenCalled()
  })

  it('a failed crossover read is a 500 too', async () => {
    h.crossoverErr = { message: 'down' }
    const res = await upload('invoice_id,member_id,amount\ninv-1,g1,10\n')
    expect(res.status).toBe(500)
  })
})
