// INVOICEHOURS.1 — the submit pre-check agrees with the unique index.
//
// contractor_invoices_one_active_per_period (mig 101, redefined by mig
// 102_contractor_invoice_revoke.sql) is ON (contractor_id, period_start)
// WHERE status NOT IN ('declined', 'revoked'): a revoked submission makes way
// for a fresh one, and the UI promises it. The pre-check used to exclude only
// 'declined', so a revoked row answered 409 "pending review". It also
// discarded its read error, so a failed read let the submit through.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (user) => (user?.locations || []).map((l) => l.id),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { POST } from './route.js'

const CONTRACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PDF_PATH = `${CONTRACTOR}/2026-09-01-abc123-invoice.pdf`

// Evaluates the pre-check's filters against `rows` the way Postgres would,
// so the test pins the PREDICATE, not the spelling of the chain.
// storage.download → a real PDF signature; insert → records the row.
function fakeDb({ rows = [], readError = null } = {}) {
  const inserts = []
  const storageCalls = []
  function invoices() {
    const filters = []
    const b = {
      select: () => b,
      eq: (col, val) => { filters.push((r) => r[col] === val); return b },
      neq: (col, val) => { filters.push((r) => r[col] !== val); return b },
      not: (col, op, val) => {
        if (op !== 'in') throw new Error(`unexpected not(${op})`)
        const list = String(val).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim())
        filters.push((r) => r[col] != null && !list.includes(r[col]))
        return b
      },
      in: (col, vals) => { filters.push((r) => vals.includes(r[col])); return b },
      maybeSingle: () => {
        if (readError) return Promise.resolve({ data: null, error: readError })
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (hit.length > 1) return Promise.resolve({ data: null, error: { message: 'multiple rows' } })
        return Promise.resolve({ data: hit[0] || null, error: null })
      },
      insert: (row) => {
        inserts.push(row)
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'new', ...row }, error: null }) }) }
      },
    }
    return b
  }
  return {
    inserts,
    storageCalls,
    from: (t) => {
      if (t !== 'contractor_invoices') throw new Error(`unexpected table ${t}`)
      return invoices()
    },
    storage: {
      from: () => ({
        download: (p) => {
          storageCalls.push(['download', p])
          const bytes = Buffer.from('%PDF-1.4 fake invoice body')
          return Promise.resolve({ data: { arrayBuffer: async () => bytes }, error: null })
        },
        remove: (p) => { storageCalls.push(['remove', p]); return Promise.resolve({ data: null, error: null }) },
      }),
    },
  }
}

function submit() {
  return POST(new Request('http://localhost/api/invoices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      month: '2026-09', amount: 800, location_id: LOC,
      pdf_path: PDF_PATH, pdf_name: 'invoice.pdf',
    }),
  }))
}

const prior = (status) => ({ id: `old-${status}`, contractor_id: CONTRACTOR, period_start: '2026-09-01', status })

describe('POST /api/invoices — INVOICEHOURS.1 resubmit pre-check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCurrentUser.mockResolvedValue({
      id: CONTRACTOR, role: 'staff', employment_type: 'contractor', locations: [{ id: LOC }],
    })
  })

  it('a REVOKED submission makes way for a fresh one (mig 102 exempts it from the unique index)', async () => {
    const db = fakeDb({ rows: [prior('revoked')] })
    createServerClient.mockReturnValue(db)
    const res = await submit()
    expect(res.status).toBe(201)
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0]).toMatchObject({ contractor_id: CONTRACTOR, period_start: '2026-09-01', status: 'submitted' })
  })

  it('a declined submission still makes way for a fresh one', async () => {
    const db = fakeDb({ rows: [prior('declined'), prior('revoked')] })
    createServerClient.mockReturnValue(db)
    const res = await submit()
    expect(res.status).toBe(201)
    expect(db.inserts).toHaveLength(1)
  })

  it('a live submission still blocks the resubmit (409, nothing written)', async () => {
    for (const status of ['submitted', 'awaiting_accountant_review', 'approved']) {
      const db = fakeDb({ rows: [prior('revoked'), prior(status)] })
      createServerClient.mockReturnValue(db)
      const res = await submit()
      expect(res.status, status).toBe(409)
      expect(db.inserts, status).toHaveLength(0)
    }
  })

  it('a failed pre-check read is a 500: never a false 409, never a silent pass', async () => {
    const db = fakeDb({ rows: [prior('submitted')], readError: { message: 'connection reset' } })
    createServerClient.mockReturnValue(db)
    const res = await submit()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).not.toMatch(/already|pending/i)
    expect(db.inserts).toHaveLength(0)
    expect(db.storageCalls).toHaveLength(0)
    expect(logError).toHaveBeenCalledWith('invoice-submit', expect.any(String), expect.objectContaining({ contractorId: CONTRACTOR }))
  })
})
