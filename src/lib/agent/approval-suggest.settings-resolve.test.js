// MIAORG.1 Task 2 — the post-decision suggestion is composed in the studio's
// RESOLVED Mia settings (DEFAULTS <- org <- studio). Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/anthropic', () => ({ anthropicMessages: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))
// MIAORG.1 Task 6 — the source comes off the resolver's location row
// (membership_source below), through the real providerFor.
vi.mock('@/lib/membership/source', async (importOriginal) => ({ ...(await importOriginal()), resolveMembershipSource: vi.fn().mockRejectedValue(new Error('separate source read')) }))

import { anthropicMessages } from '@/lib/anthropic'
import { composeApprovalSuggestion } from './approval-suggest'
import { STILLORGAN_BLOB, ORG_LAYER, withOrgLayer } from './settings-fixtures.test-helpers'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const ROW = { id: 'r1', location_id: LOC, kind: 'pause', status: 'approved', decision_note: null, contact_id: null, channel: 'whatsapp', conversation_id: null }

function db({ customerAgent, org = null, locationError = null }) {
  const inner = {
    from(table) {
      const result = table === 'locations'
        ? (locationError ? { data: null, error: locationError } : { data: { id: LOC, name: 'Studio', timezone: 'Europe/Dublin', organization_id: 'org1', membership_source: 'glofox', settings: { customer_agent: customerAgent } }, error: null })
        : { data: [], error: null }
      const b = { select: () => b, eq: () => b, order: () => b, limit: () => b, maybeSingle: () => Promise.resolve(result), then: (ok, bad) => Promise.resolve(result).then(ok, bad) }
      return b
    },
  }
  return withOrgLayer(inner, org)
}
const systemText = () => anthropicMessages.mock.calls[0][0].system.map((b) => b.text).join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  anthropicMessages.mockResolvedValue({ res: { ok: true, status: 200 }, data: { content: [{ type: 'text', text: 'All sorted, see you soon.' }] } })
})

describe('composeApprovalSuggestion — resolved settings', () => {
  it('an org-only tone reaches the suggestion prompt', async () => {
    const r = await composeApprovalSuggestion(db({ customerAgent: { ...STILLORGAN_BLOB, tone: null }, org: ORG_LAYER }), ROW)
    expect(r).toEqual({ text: 'All sorted, see you soon.' })
    expect(systemText()).toContain('Org tone.')
  })

  it("no behaviour change: Stillorgan's blob, org null, composes in its own voice", async () => {
    await composeApprovalSuggestion(db({ customerAgent: STILLORGAN_BLOB }), ROW)
    expect(systemText()).toContain(STILLORGAN_BLOB.tone)
    expect(systemText()).toContain(STILLORGAN_BLOB.agent_name)
    expect(systemText()).toContain('You CAN book classes') // Glofox render, from the row
  })

  it('an unreadable studio is location_not_found, as before', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await composeApprovalSuggestion(db({ customerAgent: {}, locationError: { message: 'down' } }), ROW)).toEqual({ error: 'location_not_found' })
    expect(anthropicMessages).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

// UN1TWRITE.8 fix 1 — a refund_request is answered by Mia's refund_request_text;
// no "Mia suggests" customer draft is ever composed for it.
describe('composeApprovalSuggestion — refund_request', () => {
  it('returns no suggestion and reads nothing (no settings, no history, no model call)', async () => {
    const throwing = { from() { throw new Error('test: no database read expected') } }
    expect(await composeApprovalSuggestion(throwing, { ...ROW, kind: 'refund_request', status: 'actioned' }))
      .toEqual({ error: 'no_suggestion_for_kind' })
  })
})
