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
import { tickCampaignSend } from '@/lib/campaign-sender'

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

// ── BAREWRITE.4 — a tick WARNING is surfaced, but never kills the campaign ───
//
// Some tick failures must be visible without being grounds to destroy the
// campaign — a lost `campaigns.updated_at` rotation bump is the case that
// forced the distinction. Because the bundle-disabled path stamps `last_error`
// on every tick by design, ANY error it returns satisfies campaignFailurePatch's
// "already failing" test on its first occurrence, so returning the bump failure
// as an error turned one transient blip into status='failed' forever.
describe('run-campaigns — warnings are reported without feeding the kill switch', () => {
  // The row shape the cron re-reads on the tick after a bundle-disabled one:
  // last_error already set (by the gate itself), never populated, past grace.
  const bundleDisabled = {
    id: 'camp-bundle-off',
    name: 'July offer',
    location_id: 'loc-1',
    status: 'queued',
    created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    send_started_at: null,
    last_error: 'Skipped — email is disabled at this location (feature toggle or bundle off).',
  }

  it('a warning is counted and logged, and NOTHING is written to the campaign row', async () => {
    tables.campaigns = [bundleDisabled]
    tickCampaignSend.mockResolvedValue({
      phase: 'bundle_disabled', sent: 0,
      warning: 'rotation bump failed (campaign will pin a per-tick slot until a later write lands): connection reset',
    })

    const body = await (await GET(req())).json()

    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0]).toMatchObject({ campaign_id: 'camp-bundle-off', phase: 'bundle_disabled' })
    // Not an error, and — the point — no failure patch written at all.
    expect(body.errors).toEqual([])
    expect(updates.find(u => u.patch?.status === 'failed')).toBeUndefined()
    expect(updates.find(u => u.patch?.last_error)).toBeUndefined()
  })

  it('THE REGRESSION: the same message returned as an `error` marks the campaign failed', async () => {
    tables.campaigns = [bundleDisabled]
    tickCampaignSend.mockResolvedValue({
      phase: 'bundle_disabled', sent: 0,
      error: 'rotation bump failed (campaign would pin a per-tick slot): connection reset',
    })

    await GET(req())

    // This is what the branch did on the FIRST transient bump failure.
    expect(updates.find(u => u.patch?.status === 'failed')).toBeTruthy()
  })
})
