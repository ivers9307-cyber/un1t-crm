// MIAORG.1 Task 2 — the in-thread confirmation copy comes from the studio's
// RESOLVED Mia settings (DEFAULTS <- org <- studio). Fictional ids.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { agentConfirmationTemplates } from './notify'
import { STILLORGAN_BLOB, ORG_LAYER, withOrgLayer } from './settings-fixtures.test-helpers'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const NONE = { booking: null, cancellation: null, decline: null, eventMove: null, eventMoveFailed: null }

function db({ customerAgent, org = null, locationError = null }) {
  const result = locationError
    ? { data: null, error: locationError }
    : { data: { id: LOC, organization_id: 'org1', settings: customerAgent === undefined ? {} : { customer_agent: customerAgent } }, error: null }
  return withOrgLayer({ from: () => { const b = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve(result) }; return b } }, org)
}

describe('agentConfirmationTemplates — resolved settings', () => {
  it('org-only confirmation texts reach a studio that sets none', async () => {
    expect(await agentConfirmationTemplates(db({ customerAgent: STILLORGAN_BLOB, org: ORG_LAYER }), LOC)).toEqual({
      booking: 'Org booked {class}.',
      cancellation: 'Org cancelled {class}.',
      decline: 'Org decline.',
      eventMove: 'Org moved {event}.',
      eventMoveFailed: 'Org move failed: {reason}.',
    })
  })

  it("no behaviour change: Stillorgan's blob (none set) and Hatch (no blob) answer the code defaults", async () => {
    expect(await agentConfirmationTemplates(db({ customerAgent: STILLORGAN_BLOB }), LOC)).toEqual(NONE)
    expect(await agentConfirmationTemplates(db({ customerAgent: undefined }), LOC)).toEqual(NONE)
  })

  it('the studio\'s own text still wins, and a failed read is the defaults (best-effort)', async () => {
    const r = await agentConfirmationTemplates(db({ customerAgent: { booking_confirmation_text: 'Studio {class}' }, org: ORG_LAYER }), LOC)
    expect(r.booking).toBe('Studio {class}')
    expect(await agentConfirmationTemplates(db({ customerAgent: {}, locationError: { message: 'down' } }), LOC)).toEqual(NONE)
  })
})
