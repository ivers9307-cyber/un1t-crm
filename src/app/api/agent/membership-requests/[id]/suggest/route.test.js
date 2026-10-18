// MIAORG.1 Task 2 — the suggestion gate (agent on + inline_suggestion not
// switched off) reads the studio's RESOLVED Mia settings: an org can switch
// inline suggestions off for its studios, but never switch Mia on. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'staff-1' })),
  getUserLocationIds: vi.fn(() => null),
}))
vi.mock('@/lib/agent/approval-suggest', () => ({ composeApprovalSuggestion: vi.fn(async () => ({ text: 'Suggested reply.' })) }))

import { POST } from './route.js'
import { composeApprovalSuggestion } from '@/lib/agent/approval-suggest'
import { STILLORGAN_BLOB, withOrgLayer } from '@/lib/agent/settings-fixtures.test-helpers'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const ROW = { id: 'r1', location_id: LOC, kind: 'pause', status: 'approved', decision_note: null, contact_id: null, channel: 'whatsapp', conversation_id: null }

function makeDb({ customerAgent, org = null, row = ROW }) {
  const inner = {
    from(table) {
      const result = table === 'agent_membership_requests'
        ? { data: row, error: null }
        : { data: { id: LOC, name: 'Studio', timezone: 'Europe/Dublin', organization_id: 'org1', settings: customerAgent === undefined ? {} : { customer_agent: customerAgent } }, error: null }
      const b = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve(result) }
      return b
    },
  }
  return withOrgLayer(inner, org)
}
const call = async () => (await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'r1' }) })).json()

beforeEach(() => vi.clearAllMocks())

describe('POST /api/agent/membership-requests/[id]/suggest — resolved settings', () => {
  it('an org that switches inline suggestions off reaches a studio that sets nothing', async () => {
    db = makeDb({ customerAgent: STILLORGAN_BLOB, org: { inline_suggestion: { enabled: false } } })
    expect(await call()).toEqual({ success: true, suggestion: null })
    expect(composeApprovalSuggestion).not.toHaveBeenCalled()
  })

  it('an org enabled:true never switches suggestions on at a studio with no blob (Hatch)', async () => {
    db = makeDb({ customerAgent: undefined, org: { enabled: true } })
    expect(await call()).toEqual({ success: true, suggestion: null })
    expect(composeApprovalSuggestion).not.toHaveBeenCalled()
  })

  it("no behaviour change: Stillorgan's blob (no inline_suggestion key), org null, suggests", async () => {
    db = makeDb({ customerAgent: STILLORGAN_BLOB })
    expect(await call()).toEqual({ success: true, suggestion: 'Suggested reply.' })
  })
})

describe('POST /api/agent/membership-requests/[id]/suggest — refund_request (UN1TWRITE.8)', () => {
  it('answers no suggestion without calling the composer, even with Mia on', async () => {
    db = makeDb({ customerAgent: STILLORGAN_BLOB, row: { ...ROW, kind: 'refund_request', status: 'actioned' } })
    expect(await call()).toEqual({ success: true, suggestion: null })
    expect(composeApprovalSuggestion).not.toHaveBeenCalled()
  })
})
