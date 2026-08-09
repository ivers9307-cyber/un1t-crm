// INTEG-C3 — per-location wallet gate on the campaign send route,
// beside (composing with, never replacing) the SAAS4-M2 org email
// hard cap.
//
// Contract pinned here:
//   (a) UNPINNED location (the real checkSpend against a stub db with
//       no active tier pinning) — the campaign queues exactly as
//       before enforcement existed.
//   (b) Pinned + allowance exhausted + wallet empty — 422
//       code 'wallet_empty', campaign NOT queued (marketing pauses).
//   (c) A thrown wallet check FAILS OPEN — the campaign still queues.
//   Plus: the org hard cap still refuses independently (composition).

import { describe, it, expect, vi, beforeEach } from 'vitest'

let tables = {}
let updates = []
const fakeDb = {
  from: (table) => {
    const rows = tables[table] ?? []
    const state = { op: 'select' }
    const b = {}
    for (const m of ['eq', 'neq', 'in', 'gte', 'lt', 'gt', 'order', 'limit', 'or', 'is']) b[m] = () => b
    b.select = () => b
    b.update = (patch) => { state.op = 'update'; state.patch = patch; return b }
    b.single = () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } })
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    b.then = (resolve, reject) => {
      if (state.op === 'update') {
        updates.push({ table, patch: state.patch })
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      }
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    }
    return b
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'user-1' })),
  assertLocationAccessOr404: vi.fn(() => null),
}))
vi.mock('@/lib/usage-caps', () => ({
  getEmailCapStatus: vi.fn(async () => ({ capped: false })),
}))
vi.mock('@/lib/wallet-enforcement', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, checkSpend: vi.fn(actual.checkSpend) }
})

import { POST } from './route.js'
import { getEmailCapStatus } from '@/lib/usage-caps'
import { checkSpend, clearBillingStateCache } from '@/lib/wallet-enforcement'

const props = { params: Promise.resolve({ id: 'camp-1' }) }
const CAMPAIGN = {
  id: 'camp-1', location_id: 'loc-1', status: 'draft', name: 'July promo',
  // COMMSFIX.D.2e — the route now requires a real subject + body to queue.
  subject: 'July promo', html_content: '<html><body>Hi</body></html>',
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBillingStateCache()
  updates = []
  tables = { campaigns: [CAMPAIGN], location_plans: [] }
})

describe('POST /api/campaigns/[id]/send — wallet gate', () => {
  it('(a) unpinned location queues exactly as before (real checkSpend, no tier pinning)', async () => {
    const res = await POST({}, props)
    const body = await res.json()

    expect(checkSpend).toHaveBeenCalledWith(fakeDb, 'loc-1', 'email_send', 'marketing')
    await expect(checkSpend.mock.results[0].value).resolves.toEqual({ allow: true, reason: 'unpinned' })
    expect(body).toMatchObject({ success: true, queued: true })
    expect(updates).toEqual([{ table: 'campaigns', patch: expect.objectContaining({ status: 'queued' }) }])
  })

  it('(b) pinned + empty wallet → 422 wallet_empty, campaign NOT queued', async () => {
    checkSpend.mockResolvedValueOnce({ allow: false, reason: 'wallet_empty' })
    const res = await POST({}, props)
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body).toMatchObject({ success: false, code: 'wallet_empty' })
    expect(body.error).toMatch(/wallet/i)
    expect(updates).toEqual([])
  })

  it('(c) a thrown wallet check FAILS OPEN — the campaign still queues', async () => {
    checkSpend.mockRejectedValueOnce(new Error('billing infra down'))
    const res = await POST({}, props)
    const body = await res.json()

    expect(body).toMatchObject({ success: true, queued: true })
    expect(updates).toHaveLength(1)
  })

  it('composes with the org hard cap: the cap refuses first, independently of the wallet', async () => {

    getEmailCapStatus.mockResolvedValueOnce({ capped: true, capSends: 1000, monthSends: 1000 })
    const res = await POST({}, props)
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.code).toBe('email_hard_cap')
    expect(checkSpend).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })
})

// COMMSFIX.D.2e — the last backstop before a broadcast. A campaign whose body
// or subject is empty must never reach 'queued': Postmark permanently rejects
// HtmlBody null, so the entire audience records as bounced. Audit 2026-08-09
// composer-ux, CONFIRMED high.
describe('POST /api/campaigns/[id]/send — refuses a bodyless campaign', () => {
  it.each([null, '', '   '])('refuses html_content %p', async (html_content) => {
    tables.campaigns = [{ ...CAMPAIGN, html_content }]
    const res = await POST({}, props)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/body|content/i)
    expect(updates).toEqual([])
  })

  it.each([null, '', '   '])('refuses subject %p', async (subject) => {
    tables.campaigns = [{ ...CAMPAIGN, subject }]
    const res = await POST({}, props)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/subject/i)
    expect(updates).toEqual([])
  })
})
