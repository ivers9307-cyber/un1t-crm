// HOST-CONSENT.1 — a signup grants BOTH consents (UN1T as before, host new),
// and a re-signup by a host-unsubscribed contact lifts the host suppression.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '1.2.3.4',
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/host-events', () => ({ resolveMasterLocationId: vi.fn().mockResolvedValue('loc-master'), ensureAnchorLocation: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn().mockResolvedValue('c-1') }))
vi.mock('@/lib/host-contact-list', () => ({ hostTagFor: () => 'host:pride' }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: vi.fn() }))
vi.mock('@/lib/host-consent', () => ({
  grantHostConsent: vi.fn().mockResolvedValue({ ok: true, changed: true }),
  resubscribeHost: vi.fn().mockResolvedValue({ ok: true, unsuppressed: true, changed: true }),
}))
vi.mock('@/lib/postmark-suppressions', () => ({ unsuppressAtPostmark: vi.fn().mockResolvedValue({ ok: 1, failed: [], skipped: [] }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { applyFormMarketingConsent } from '@/lib/marketing-consent'
import { grantHostConsent, resubscribeHost } from '@/lib/host-consent'
import { unsuppressAtPostmark } from '@/lib/postmark-suppressions'
import { logError } from '@/lib/log'

const HOST = { id: 'h-1', name: 'Pride Training Club', slug: 'pride', organization_id: 'org-1', anchor_location_id: 'loc-a', postmark_stream_id: 'colm-events' }

function stubDb({ suppressed = false, host = HOST, memberErr = null } = {}) {
  return {
    from: (table) => {
      const chain = {
        select: () => chain, eq: () => chain, upsert: () => chain, update: () => chain,
        maybeSingle: async () => {
          if (table === 'event_hosts') return { data: host, error: null }
          if (table === 'host_email_suppressions') return { data: suppressed ? { id: 's-1' } : null, error: null }
          if (table === 'contacts') return { data: { tags: [] }, error: null }
          return { data: null, error: null }
        },
        then: (resolve, reject) => {
          if (table === 'host_contacts' && memberErr) return Promise.resolve({ data: null, error: memberErr }).then(resolve, reject)
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        },
      }
      return chain
    },
  }
}

function req() {
  return new Request('http://localhost/api/public/host-list/pride/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pat Doe', email: 'Pat@Example.com' }),
  })
}
const props = { params: Promise.resolve({ slug: 'pride' }) }

beforeEach(() => vi.clearAllMocks())

describe('POST /api/public/host-list/[slug]/subscribe — HOST-CONSENT.1', () => {
  it('grants UN1T consent (unchanged) AND host consent from the mailing-list form', async () => {
    createServerClient.mockReturnValue(stubDb())
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(applyFormMarketingConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c-1', consent: true, source: 'host_mailing_list' }))
    expect(grantHostConsent).toHaveBeenCalledWith(expect.anything(), { hostId: 'h-1', contactId: 'c-1', source: 'mailing_list_form', ipAddress: '1.2.3.4' })
    expect(resubscribeHost).not.toHaveBeenCalled()
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })

  it('a host-unsubscribed contact who signs up again is resubscribed and lifted on the HOST stream', async () => {
    createServerClient.mockReturnValue(stubDb({ suppressed: true }))
    await POST(req(), props)
    expect(resubscribeHost).toHaveBeenCalledWith(expect.anything(), { hostId: 'h-1', contactId: 'c-1', ipAddress: '1.2.3.4' })
    expect(grantHostConsent).not.toHaveBeenCalled()
    expect(unsuppressAtPostmark).toHaveBeenCalledWith('pat@example.com', { stream: 'colm-events' })
  })

  it('skips the Postmark lift when the host has no stream yet', async () => {
    createServerClient.mockReturnValue(stubDb({ suppressed: true, host: { ...HOST, postmark_stream_id: null } }))
    await POST(req(), props)
    expect(resubscribeHost).toHaveBeenCalled()
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })

  it('a failed membership upsert skips the consent write entirely (no row to update)', async () => {
    createServerClient.mockReturnValue(stubDb({ memberErr: { message: 'boom' } }))
    const res = await POST(req(), props)
    expect(grantHostConsent).not.toHaveBeenCalled()
    expect(resubscribeHost).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('a failed consent write is logged and the public response is unchanged', async () => {
    createServerClient.mockReturnValue(stubDb())
    grantHostConsent.mockResolvedValueOnce({ ok: false, changed: false, error: 'boom' })
    const res = await POST(req(), props)
    expect(logError).toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('a failed resubscribe does not lift the Postmark suppression', async () => {
    createServerClient.mockReturnValue(stubDb({ suppressed: true }))
    resubscribeHost.mockResolvedValueOnce({ ok: false, unsuppressed: false, changed: false, error: 'boom' })
    await POST(req(), props)
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })
})
