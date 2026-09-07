// HOST-RESEND.1 — POST /api/host/emails/[id]/resend-missed is a thin wrapper
// over launchHostCampaign (trigger 'resend_missed'): the session gate is the
// route's, every other gate, the diff against sent rows, the CAS and the
// enqueue live in the lib (tested in src/lib/host-campaign-launch.test.js).
// The route maps { ok, reason, status, error } onto { queued } / the lib's
// status, unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-campaign-launch', () => ({ launchHostCampaign: vi.fn() }))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { launchHostCampaign } from '@/lib/host-campaign-launch'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'
const DB = { tag: 'service-role' }

function makeRequest() {
  return new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/resend-missed`, { method: 'POST' })
}
const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
  createServerClient.mockReturnValue(DB)
})

describe('POST /api/host/emails/[id]/resend-missed', () => {
  it('401s without a host session and never launches', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(401)
    expect(launchHostCampaign).not.toHaveBeenCalled()
  })

  it("launches with trigger 'resend_missed' for the session host and answers { queued }", async () => {
    launchHostCampaign.mockResolvedValue({ ok: true, recipientCount: 44 })
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { queued: 44 } })
    expect(launchHostCampaign).toHaveBeenCalledTimes(1)
    expect(launchHostCampaign).toHaveBeenCalledWith(DB, { campaignId: CAMPAIGN_ID, hostId: HOST_ID, trigger: 'resend_missed' })
  })

  it('409s with the nobody-missed copy when there is no one to resend to', async () => {
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'nobody_missed', status: 409, error: 'Everyone who can be emailed already received this.' })
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'Everyone who can be emailed already received this.' })
  })

  it("passes the lib's status and message through unchanged (404 / 409 / 500)", async () => {
    for (const refusal of [
      { reason: 'not_found', status: 404, error: 'Not found' },
      { reason: 'not_sent', status: 409, error: 'Only a sent email can be resent.' },
      { reason: 'daily_cap', status: 409, error: 'Daily send limit reached.' },
      { reason: 'resolve_failed', status: 500, error: 'boom' },
    ]) {
      launchHostCampaign.mockResolvedValue({ ok: false, ...refusal })
      const res = await POST(makeRequest(), props)
      expect(res.status).toBe(refusal.status)
      expect(await res.json()).toEqual({ success: false, error: refusal.error })
    }
  })
})
