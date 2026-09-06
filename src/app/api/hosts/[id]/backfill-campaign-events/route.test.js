// HOST-METRICS.1 — POST /api/hosts/[id]/backfill-campaign-events
//
// Manager+, org-scoped (gate() copied from ../route.js), 404 on a cross-org
// id. Dry-run by default; ?dry=0 opts into writes. The route itself does no
// Postmark I/O — it just resolves the host and calls
// backfillHostCampaignEvents, so this test mocks that lib entirely.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/hosts', async (orig) => ({ ...(await orig()), loadHostForOrg: vi.fn() }))
vi.mock('@/lib/host-campaign-backfill', () => ({ backfillHostCampaignEvents: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostForOrg } from '@/lib/hosts'
import { backfillHostCampaignEvents } from '@/lib/host-campaign-backfill'

const HOST_ID = 'h-1'
const ORG_ID = 'org-1'
const SUMMARY = { dry: true, scanned: 0, matched: 0, stamped: 0, updated: 0, skipped: 0, errors: [] }

function makeRequest(qs = '') {
  return new Request(`http://localhost/api/hosts/${HOST_ID}/backfill-campaign-events${qs}`, { method: 'POST' })
}
const props = { params: Promise.resolve({ id: HOST_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({})
  backfillHostCampaignEvents.mockResolvedValue(SUMMARY)
})

describe('POST /api/hosts/[id]/backfill-campaign-events', () => {
  it('401s with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(401)
    expect(backfillHostCampaignEvents).not.toHaveBeenCalled()
  })

  it('403s a staff role', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', activeOrganization: { id: ORG_ID } })
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(403)
    expect(backfillHostCampaignEvents).not.toHaveBeenCalled()
  })

  it('404s a host in another org (no IDOR enumeration)', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', activeOrganization: { id: ORG_ID } })
    loadHostForOrg.mockResolvedValue(null)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(404)
    expect(backfillHostCampaignEvents).not.toHaveBeenCalled()
  })

  it('defaults to a dry run', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', activeOrganization: { id: ORG_ID } })
    loadHostForOrg.mockResolvedValue({ id: HOST_ID, organization_id: ORG_ID })
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toEqual(SUMMARY)
    expect(backfillHostCampaignEvents).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hostId: HOST_ID, dry: true }))
  })

  it('?dry=0 opts into a live run', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', activeOrganization: { id: ORG_ID } })
    loadHostForOrg.mockResolvedValue({ id: HOST_ID, organization_id: ORG_ID })
    const res = await POST(makeRequest('?dry=0'), props)
    expect(res.status).toBe(200)
    expect(backfillHostCampaignEvents).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dry: false }))
  })

  it('passes the loaded host id (org-scoped, not the raw param) and a from/to window', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', activeOrganization: { id: ORG_ID } })
    loadHostForOrg.mockResolvedValue({ id: HOST_ID, organization_id: ORG_ID })
    await POST(makeRequest(), props)
    const call = backfillHostCampaignEvents.mock.calls[0]
    expect(call[1].hostId).toBe(HOST_ID)
    expect(call[1].fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(call[1].toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('no active organization -> 400', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', activeOrganization: null, activeLocation: null })
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(400)
    expect(backfillHostCampaignEvents).not.toHaveBeenCalled()
  })
})
