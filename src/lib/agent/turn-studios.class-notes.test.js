// MIACLASSNOTES.1 — the reply's knowledge read carries the borrowed class notes.
import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { readAgentKnowledge } from './turn-studios'

const ORG = '00000000-0000-4000-8000-0000000000a1'
const STILL = '00000000-0000-4000-8000-0000000000b1'
const HATCH = '00000000-0000-4000-8000-0000000000b2'
const soon = new Date(Date.now() + 86400000).toISOString()

const seed = (errors = {}) => createFakeDb({
  tables: {
    locations: [{ id: STILL, name: 'UN1T Stillorgan', organization_id: ORG, active: true }, { id: HATCH, name: 'UN1T Hatch Street', organization_id: ORG, active: true }],
    un1t_events: [{ id: 'c1', location_id: HATCH, title: 'RECLA1M', starts_at: soon }],
    agent_knowledge: [
      { id: 'k1', location_id: HATCH, category: 'general', title: 'TRIAL OFFER', content: 'Hatch trial.', enabled: true, sort_order: 0 },
      { id: 'k2', location_id: STILL, category: 'general', title: 'RECLA1M - CONDITIONING', content: 'Team Conditioning Training Session.', enabled: true, sort_order: 0 },
      { id: 'k3', location_id: STILL, category: 'general', title: 'TRIAL OFFER', content: 'Stillorgan trial.', enabled: true, sort_order: 0 },
    ],
  },
  errors,
})

describe('readAgentKnowledge · shared class notes', () => {
  it("the studio's own notes, then the class notes it borrows; never a sibling's other notes", async () => {
    const res = await readAgentKnowledge(seed(), HATCH, 'test', { shareClassNotes: true })
    expect(res.ok).toBe(true)
    expect(res.rows.map((r) => [r.title, r.content])).toEqual([['TRIAL OFFER', 'Hatch trial.'], ['RECLA1M', 'Team Conditioning Training Session.']])
  })

  it('a studio with no synced timetable reads exactly what it read before', async () => {
    const res = await readAgentKnowledge(seed(), STILL, 'test', { shareClassNotes: true })
    expect(res.rows.map((r) => r.title)).toEqual(['RECLA1M - CONDITIONING', 'TRIAL OFFER'])
  })

  it('without the option nothing is borrowed and the timetable is not read', async () => {
    const db = seed()
    const res = await readAgentKnowledge(db, HATCH, 'test')
    expect(res.rows.map((r) => r.title)).toEqual(['TRIAL OFFER'])
    expect(db.calls.map((c) => c.table)).toEqual(['agent_knowledge'])
  })

  it("a failed borrow never costs the studio its own notes", async () => {
    const res = await readAgentKnowledge(seed({ un1t_events: { select: { message: 'boom' } } }), HATCH, 'test', { shareClassNotes: true })
    expect(res).toEqual({ ok: true, rows: [expect.objectContaining({ title: 'TRIAL OFFER', content: 'Hatch trial.' })] })
  })
})
