// COMMSFIX.D.2e — the cron's promote step is the third way a campaign can
// reach 'queued' (composer send, manual send route, scheduled promotion). A
// scheduled campaign whose body or subject is empty must NOT be promoted:
// Postmark permanently rejects HtmlBody null, so the whole audience records as
// bounced. Audit 2026-08-09 composer-ux, CONFIRMED high.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let tables = {}
let updates = []

const fakeDb = {
  from: (table) => {
    const state = { op: 'select', filters: [] }
    const b = {}
    for (const m of ['neq', 'gte', 'lt', 'gt', 'order', 'limit', 'or', 'is']) b[m] = () => b
    b.eq = (col, val) => { state.filters.push([col, val]); return b }
    b.lte = () => b
    b.in = (col, vals) => { state.filters.push([col, vals]); return b }
    b.select = () => b
    b.update = (patch) => { state.op = 'update'; state.patch = patch; return b }
    b.single = () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null })
    b.then = (resolve, reject) => {
      const rows = tables[table] ?? []
      if (state.op === 'update') {
        updates.push({ table, patch: state.patch, filters: state.filters })
        return Promise.resolve({ data: [], error: null }).then(resolve, reject)
      }
      // The pick query (STEP 2) filters status in ('queued','sending'); the
      // due query (STEP 1) filters status = 'scheduled'.
      const statusFilter = state.filters.find(([c]) => c === 'status')
      const wanted = statusFilter
        ? (Array.isArray(statusFilter[1]) ? statusFilter[1] : [statusFilter[1]])
        : null
      const out = wanted ? rows.filter(r => wanted.includes(r.status)) : rows
      return Promise.resolve({ data: out, error: null }).then(resolve, reject)
    }
    return b
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/campaign-sender', () => ({ tickCampaignSend: vi.fn(async () => ({ sent: 0, bounced: 0 })) }))
vi.mock('@/lib/campaign-resend', () => ({ spawnDueResends: vi.fn(async () => ({ spawned: 0, errors: [] })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/usage-caps', () => ({ getEmailCapStatus: vi.fn(async () => ({ capped: false })) }))
vi.mock('@/lib/campaign-fairness', () => ({ pickFairCampaigns: (rows) => rows || [] }))

import { GET } from './route.js'

const GOOD = {
  id: 'camp-ok', location_id: 'loc-1', status: 'scheduled',
  subject: 'Weekend offer', html_content: '<html><body>Hi</body></html>',
}

function req() {
  return new Request('http://test.local/api/cron/run-campaigns', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 'test-secret')
  updates = []
  tables = { campaigns: [] }
})

describe('run-campaigns promote step — empty-body guard', () => {
  it('promotes a scheduled campaign that has a subject and a body', async () => {
    tables.campaigns = [GOOD]
    const res = await GET(req())
    const body = await res.json()

    expect(body.ok).toBe(true)
    const promote = updates.find(u => u.patch?.status === 'queued')
    expect(promote).toBeTruthy()
    expect(promote.filters.find(([c]) => c === 'id')[1]).toEqual(['camp-ok'])
  })

  it.each([null, '', '   '])('does not promote a scheduled campaign with html_content %p', async (html_content) => {
    tables.campaigns = [{ ...GOOD, html_content }]
    const res = await GET(req())
    const body = await res.json()

    expect(updates.find(u => u.patch?.status === 'queued')).toBeUndefined()
    expect(body.promoted).toBe(0)
  })

  it('does not promote a scheduled campaign with no subject', async () => {
    tables.campaigns = [{ ...GOOD, subject: '  ' }]
    await GET(req())
    expect(updates.find(u => u.patch?.status === 'queued')).toBeUndefined()
  })

  it('promotes the good one and holds the empty one in the same tick', async () => {
    tables.campaigns = [GOOD, { ...GOOD, id: 'camp-empty', html_content: '' }]
    await GET(req())
    const promote = updates.find(u => u.patch?.status === 'queued')
    expect(promote.filters.find(([c]) => c === 'id')[1]).toEqual(['camp-ok'])
  })
})
