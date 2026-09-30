// WATPLSEND.1 — the flow_token format is written in ONE place (flowTokenFor)
// and read in one place (resolveFlowConfigByToken). A second hand-written
// format would book a Flow submission against the wrong contact or studio.
import { describe, it, expect } from 'vitest'
import { flowTokenFor, resolveFlowConfigByToken } from './config.js'

describe('flowTokenFor', () => {
  it('is <contactId>.<locationId>', () => {
    expect(flowTokenFor('c1', 'l1')).toBe('c1.l1')
  })

  it('is null when either half is missing, so a caller can refuse instead of minting a dead token', () => {
    expect(flowTokenFor(null, 'l1')).toBeNull()
    expect(flowTokenFor('c1', undefined)).toBeNull()
    expect(flowTokenFor('', '')).toBeNull()
  })

  it('round-trips through resolveFlowConfigByToken to the same contact and studio', async () => {
    const seen = []
    const db = {
      from: (table) => ({
        select: () => ({
          eq: (col, val) => {
            seen.push([table, col, val])
            return {
              maybeSingle: async () => ({
                data: table === 'locations'
                  ? { settings: { whatsapp_flow: { flow_id: 'F1' } } }
                  : { id: val, name: 'x' },
              }),
            }
          },
        }),
      }),
    }
    const out = await resolveFlowConfigByToken(db, flowTokenFor('c1', 'l1'))
    expect(seen).toEqual([['contacts', 'id', 'c1'], ['locations', 'id', 'l1']])
    expect(out.locationId).toBe('l1')
    expect(out.contact.id).toBe('c1')
    expect(out.config.flow_id).toBe('F1')
  })
})
