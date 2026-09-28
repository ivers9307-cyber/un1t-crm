// ROLESWEEP.1a — SMS and WhatsApp broadcast routes judge `sms` / `whatsapp`
// (and the template resubmit judges MANAGER_ROLES) at the broadcast's /
// template's / body's location, never at the caller's ACTIVE studio.
// Harness: tests/helpers/role-gate-probe.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import { roleCases, permissionCases, keyOffAtB, LOC_A } from '../helpers/role-sweep-callers.js'
import * as smsDetail from '@/app/api/sms/broadcasts/[id]/route.js'
import * as smsSend from '@/app/api/sms/broadcasts/[id]/send/route.js'
import * as smsList from '@/app/api/sms/broadcasts/route.js'
import * as waSend from '@/app/api/whatsapp/broadcasts/[id]/send/route.js'
import * as waResubmit from '@/app/api/whatsapp/templates/[id]/resubmit/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const SMS_OFF = { status: 403, body: { success: false, error: 'Forbidden — SMS not enabled' } }
// locations: null keeps loadBroadcast's overlayConnections read out of the gate.
const SMS_ROW = row({ id: 'sb-1', status: 'draft', scheduled_at: null, locations: null })

beforeEach(() => vi.clearAllMocks())

describeGate('GET /api/sms/broadcasts/[id]', {
  call: () => smsDetail.GET(bare('GET'), params({ id: 'sb-1' })),
  gateReads: SMS_ROW, forbidden: SMS_OFF, hidden: NOT_FOUND, cases: permissionCases('sms'),
}, T)
describeGate('PATCH /api/sms/broadcasts/[id]', {
  call: () => smsDetail.PATCH(json('PATCH', {}), params({ id: 'sb-1' })),
  gateReads: SMS_ROW, forbidden: SMS_OFF, hidden: NOT_FOUND, cases: permissionCases('sms'),
}, T)
describeGate('DELETE /api/sms/broadcasts/[id]', {
  call: () => smsDetail.DELETE(bare('DELETE'), params({ id: 'sb-1' })),
  gateReads: SMS_ROW, forbidden: SMS_OFF, hidden: NOT_FOUND, cases: permissionCases('sms'),
}, T)
describeGate('POST /api/sms/broadcasts/[id]/send', {
  call: () => smsSend.POST(bare('POST'), params({ id: 'sb-1' })),
  gateReads: row({}), forbidden: SMS_OFF, hidden: NOT_FOUND, cases: permissionCases('sms'),
}, T)
describeGate('GET /api/sms/broadcasts?location_id=', {
  call: (loc) => smsList.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: SMS_OFF, hidden: NOT_MEMBER, cases: permissionCases('sms'),
}, T)
describeGate('POST /api/sms/broadcasts', {
  call: (loc) => smsList.POST(json('POST', { location_id: loc, name: 'Autumn', body: 'Hi' })),
  forbidden: SMS_OFF, hidden: NOT_MEMBER, cases: permissionCases('sms'),
}, T)

describe('GET /api/sms/broadcasts (no location_id) lists only locations where the caller holds sms', () => {
  it('drops B when sms is switched off for them at B (main listed A and B)', async () => {
    getCurrentUser.mockResolvedValue(keyOffAtB('sms'))
    const probe = gateProbe([])
    createServerClient.mockReturnValue(probe.db)
    await runProbed(probe, () => smsList.GET(bare('GET')))
    expect(probe.tripped.table).toBe('sms_broadcasts')
    expect(probe.tripped.chain).toContainEqual(['in', 'location_id', [LOC_A]])
  })
})

describeGate('POST /api/whatsapp/broadcasts/[id]/send', {
  call: () => waSend.POST(bare('POST'), params({ id: 'wb-1' })),
  gateReads: row({}),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden — WhatsApp not enabled' } },
  hidden: NOT_FOUND, cases: permissionCases('whatsapp'),
}, T)

describeGate('POST /api/whatsapp/templates/[id]/resubmit (MANAGER_ROLES at the template)', {
  call: () => waResubmit.POST(json('POST', { components: [] }), params({ id: 'wt-1' })),
  gateReads: row({ id: 'wt-1', status: 'REJECTED', meta_template_id: 'meta-1' }),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: NOT_FOUND, cases: roleCases(MANAGER_ROLES),
}, T)
