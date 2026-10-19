// UN1TWRITE.22 — processClassBookingRequest's un1t.online dispatch, and
// routeToReview's provider / row options.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async (o) => ({
  ...(await o()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: null, apiKey: null, apiToken: null, readError: null })),
  missingGlofoxCredentialsForLocation: vi.fn(() => ['Branch ID']),
}))
vi.mock('@/lib/un1t-online-settings', async (o) => ({ ...(await o()), readUn1tWriteSettings: vi.fn() }))
vi.mock('@/lib/un1t-online-booking-processor', () => ({ processUn1tClassBookingRequest: vi.fn(async () => ({ outcome: 'booked', detail: 'un1t:bk' })) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/agent/approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
vi.mock('@/lib/location-time', async (o) => ({ ...(await o()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

import { processClassBookingRequest, routeToReview } from './class-booking-processor'
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'
import { readUn1tWriteSettings, Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { processUn1tClassBookingRequest } from '@/lib/un1t-online-booking-processor'

let inserts
let updates
function makeDb() {
  return {
    from(table) {
      const b = {
        select: () => b, eq: () => b, in: () => b, contains: () => b, limit: () => b,
        maybeSingle: async () => ({ data: table === 'agent_membership_requests' && b._ins ? { id: 'amr-1' } : null, error: null }),
        insert: (row) => { inserts.push({ table, row }); b._ins = true; return b },
        update: (row) => { updates.push({ table, row }); return b },
        then: (ok, no) => Promise.resolve({ data: null, error: null }).then(ok, no),
      }
      return b
    },
  }
}
const un1t = (funnel) => ({ membershipSource: 'un1t_online', studioName: 'Hatch Street', organizationId: 'org-1', settings: { writesEnabled: funnel, funnelEnabled: funnel } })
const req = (eventId) => ({ id: 'q-1', location_id: 'loc-h', contact_id: 'c-1', glofox_event_id: eventId, class_name: 'RALLY', starts_at: '2099-01-01T08:00:00Z', attempts: 1 })
const cardReason = () => inserts.find((i) => i.table === 'agent_membership_requests')?.row.details.reason

beforeEach(() => {
  vi.clearAllMocks()
  inserts = []
  updates = []
})

describe('dispatch at a studio with no Glofox', () => {
  it('manual ids still go to manual_booking', async () => {
    readUn1tWriteSettings.mockResolvedValue(un1t(true))
    await processClassBookingRequest(makeDb(), req('manual-20991231-0800-rally'))
    expect(cardReason()).toBe('manual_booking')
    expect(processUn1tClassBookingRequest).not.toHaveBeenCalled()
  })

  it('a un1t: id with the funnel on goes to the un1t.online processor with the settings', async () => {
    readUn1tWriteSettings.mockResolvedValue(un1t(true))
    const out = await processClassBookingRequest(makeDb(), req('un1t:ev-1'))
    expect(out).toEqual({ outcome: 'booked', detail: 'un1t:bk' })
    expect(processUn1tClassBookingRequest.mock.calls[0][2]).toMatchObject({ settings: { funnelEnabled: true }, organizationId: 'org-1' })
  })

  it('a un1t: id with the funnel off is still booked by hand (manual_booking), as before the switch', async () => {
    readUn1tWriteSettings.mockResolvedValue(un1t(false))
    await processClassBookingRequest(makeDb(), req('un1t:ev-1'))
    expect(cardReason()).toBe('manual_booking')
  })

  it('a bare uuid id with the funnel off files un1t_funnel_off; with it on, the processor', async () => {
    readUn1tWriteSettings.mockResolvedValue(un1t(false))
    await processClassBookingRequest(makeDb(), req('7f3a0000-0000-4000-8000-000000000001'))
    expect(cardReason()).toBe('un1t_funnel_off')
    readUn1tWriteSettings.mockResolvedValue(un1t(true))
    await processClassBookingRequest(makeDb(), req('7f3a0000-0000-4000-8000-000000000001'))
    expect(processUn1tClassBookingRequest).toHaveBeenCalledOnce()
  })

  it('a failed settings read throws (the queue retries)', async () => {
    readUn1tWriteSettings.mockRejectedValue(new Un1tSettingsReadError('x'))
    await expect(processClassBookingRequest(makeDb(), req('un1t:ev-1'))).rejects.toBeInstanceOf(Un1tSettingsReadError)
  })

  it('a Glofox studio never reads the un1t path', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
    missingGlofoxCredentialsForLocation.mockReturnValueOnce([])
    await processClassBookingRequest(makeDb(), req('glofox-ev')).catch(() => {})
    expect(readUn1tWriteSettings).not.toHaveBeenCalled()
    expect(processUn1tClassBookingRequest).not.toHaveBeenCalled()
  })
})

describe('routeToReview options', () => {
  it('provider goes in details; rowStatus and rowLastError stamp the row; the defaults are unchanged', async () => {
    await routeToReview(makeDb(), req('un1t:ev-1'), 'un1t_trial_used', { provider: 'un1t_online', rowStatus: 'failed', rowLastError: 'trial_used_options_sent', executingContactId: 'c-sib' })
    const card = inserts.find((i) => i.table === 'agent_membership_requests').row
    expect(card.details).toMatchObject({ provider: 'un1t_online', reason: 'un1t_trial_used', executing_contact_id: 'c-sib' })
    expect(updates.at(-1).row).toMatchObject({ status: 'failed', last_error: 'trial_used_options_sent', approval_request_id: 'amr-1' })
    inserts = []
    updates = []
    await routeToReview(makeDb(), req('glofox-ev'), 'needs_credit_grant')
    expect(inserts[0].row.details).not.toHaveProperty('provider')
    expect(updates.at(-1).row).toMatchObject({ status: 'needs_review', last_error: 'needs_credit_grant' })
  })
})
