// COMMSFIX.D.4b — the test send must reproduce the DELIVERED subject. It
// merged campaign.subject with no extras, so {{location_name}} /
// {{unsubscribe_url}} / {{preference_url}} — all three advertised by the
// editor's merge-tag panel as usable "in your subject line or email body" —
// resolved to '' fallbacks. The test faithfully reproduced the real send's bug
// rather than catching it. Audit 2026-08-09 composer-ux.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let campaignRow = null
const fakeDb = {
  from: (table) => {
    const b = {}
    for (const m of ['select', 'eq']) b[m] = () => b
    b.single = () => Promise.resolve(
      table === 'campaigns'
        ? { data: campaignRow, error: campaignRow ? null : { message: 'not found' } }
        : { data: null, error: null },
    )
    b.maybeSingle = () => Promise.resolve({ data: null, error: null })
    return b
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
// ROLESWEEP.1a — the route judges ADMIN_ROLES at the campaign's location with
// the real per-location helpers, so the caller carries rolesByLocation.
vi.mock('@/lib/auth', async () => {
  const { hasRoleAtLocation, hasRoleAtAnyLocation } = await import('@/lib/role-at-location')
  return {
    getCurrentUser: vi.fn(async () => ({ id: 'u1', email: 'ops@un1t.ie', full_name: 'Ops Person', role: 'owner', rolesByLocation: { 'loc-1': 'owner' } })),
    assertLocationAccessOr404: vi.fn(() => null),
    hasRoleAtLocation,
    hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/postmark', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendEmail: vi.fn(async () => ({ MessageID: 'pm-test' })) }
})

import { POST } from './route.js'
import { sendEmail } from '@/lib/postmark'

const props = { params: Promise.resolve({ id: 'camp-1' }) }

function post() {
  return POST(new Request('http://test.local/api/campaigns/camp-1/send-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'ops@un1t.ie' }),
  }), props)
}

beforeEach(() => {
  vi.clearAllMocks()
  campaignRow = {
    id: 'camp-1',
    name: 'July offer',
    subject: 'Your week at {{location_name}}',
    html_content: '<html><body><p>Hi {{first_name}}</p></body></html>',
    from_name: null,
    from_email: 'hello@un1t.ie',
    reply_to: null,
    location_id: 'loc-1',
    locations: { name: 'Stillorgan' },
  }
})

describe('send-test — subject merge tags get the same extras as the body', () => {
  it('renders {{location_name}} in the tested subject', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(sendEmail.mock.calls[0][0].subject).toBe('[TEST] Your week at Stillorgan')
  })

  it('renders {{preference_url}} in the tested subject', async () => {
    campaignRow.subject = 'Manage at {{preference_url}}'
    await post()
    expect(sendEmail.mock.calls[0][0].subject).toContain('https://crm.test/preferences/')
  })

  it('still merges contact fields (no regression)', async () => {
    campaignRow.subject = 'Hi {{first_name}} from {{location_name}}'
    await post()
    expect(sendEmail.mock.calls[0][0].subject).toBe('[TEST] Hi Ops from Stillorgan')
  })

  // W1.E2 — a test send must match a real one: the campaign's location drives
  // the sender (brand display name on the platform address + the location's
  // Reply-To), and the operator's From name is a display name, never an address.
  it('W1.E2 — passes the campaign location and from_name; never builds a From from campaign.from_email', async () => {
    campaignRow.from_name = 'Garrett at Stillorgan'
    await post()
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.locationId).toBe('loc-1')
    expect(arg.fromName).toBe('Garrett at Stillorgan')
    expect(arg.from).toBeUndefined()
  })

  it('W1.E2 — no from_name → no fromName, still the campaign location', async () => {
    await post()
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.locationId).toBe('loc-1')
    expect(arg.fromName).toBeUndefined()
    expect(arg.from).toBeUndefined()
  })
})
