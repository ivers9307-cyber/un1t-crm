import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { classKey, borrowClassNotes, readSharedClassNotes } from './shared-class-notes'

const ORG = '00000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2'
const STILL = '00000000-0000-4000-8000-0000000000b1'
const HATCH = '00000000-0000-4000-8000-0000000000b2'
const ELSEWHERE = '00000000-0000-4000-8000-0000000000b3'
const ANCHOR = '00000000-0000-4000-8000-0000000000b4'
const NOW = Date.parse('2026-11-23T18:00:00Z')

const note = (locationId, title, content, extra = {}) => ({ id: `${locationId.slice(-2)}-${title}`, location_id: locationId, category: 'general', title, content, enabled: true, sort_order: 0, ...extra })
const cls = (locationId, title, startsAt = '2026-11-24T07:00:00Z') => ({ id: `${locationId.slice(-2)}-${title}-${startsAt}`, location_id: locationId, title, starts_at: startsAt })
const loc = (id, name, extra = {}) => ({ id, name, organization_id: ORG, active: true, ...extra })

describe('classKey', () => {
  it('reads the class name out of a note title or a timetable title', () => {
    expect(classKey('RECLA1M - CONDITIONING')).toBe('recla1m')
    expect(classKey('RECLA1M. - CONDITIONING')).toBe('recla1m')
    expect(classKey('RECLA1M')).toBe('recla1m')
    expect(classKey('FORCE.')).toBe('force')
    expect(classKey('HYROX / TRYKA')).toBe('hyrox/tryka')
    expect(classKey('HYROX/TRYKA')).toBe('hyrox/tryka')
    expect(classKey('  Pride   Training Club ')).toBe('pride training club')
    expect(classKey('')).toBe('')
    expect(classKey(null)).toBe('')
  })
})

describe('borrowClassNotes', () => {
  const siblings = [
    note(STILL, 'RECLA1M - CONDITIONING', 'Team Conditioning Training Session.'),
    note(STILL, 'RECLA1M. - CONDITIONING', 'Team Conditioning Training Session.'),
    note(STILL, 'FORCE - STRENGTH', 'Strength class of compound lifts.'),
    note(STILL, 'TRIAL OFFER — THE 14 DAY RESET', 'Stillorgan trial facts.'),
    note(STILL, 'Overdue payment reminders', 'Stillorgan billing facts.'),
    note(STILL, 'SET - STRENGTH', '   '),
    note(STILL, 'CONVOY - STRENGTH', 'Off.', { enabled: false }),
  ]

  it('borrows only the notes that describe a class on this studio\'s timetable, once each, under the timetable name', () => {
    const out = borrowClassNotes({ ownRows: [], classTitles: ['RECLA1M', 'FORCE', 'SET', 'CONVOY', 'HAUL'], siblingRows: siblings })
    expect(out).toEqual([
      { category: 'general', title: 'FORCE', content: 'Strength class of compound lifts.', enabled: true, sort_order: 0 },
      { category: 'general', title: 'RECLA1M', content: 'Team Conditioning Training Session.', enabled: true, sort_order: 0 },
    ])
  })

  it('never borrows a note that is not a class on the timetable: offers and billing stay where they are', () => {
    const out = borrowClassNotes({ ownRows: [], classTitles: ['RECLA1M'], siblingRows: siblings })
    expect(JSON.stringify(out)).not.toMatch(/trial facts|billing facts/)
  })

  it("the studio's own note wins, enabled or not: an operator who switched one off meant it", () => {
    const own = [note(HATCH, 'RECLA1M', 'Our own words.'), note(HATCH, 'FORCE - STRENGTH', 'Hidden.', { enabled: false })]
    expect(borrowClassNotes({ ownRows: own, classTitles: ['RECLA1M', 'FORCE'], siblingRows: siblings })).toEqual([])
  })

  it('nothing on the timetable, or no siblings, borrows nothing', () => {
    expect(borrowClassNotes({ ownRows: [], classTitles: [], siblingRows: siblings })).toEqual([])
    expect(borrowClassNotes({ ownRows: [], classTitles: ['RECLA1M'], siblingRows: [] })).toEqual([])
    expect(borrowClassNotes({})).toEqual([])
  })
})

describe('readSharedClassNotes', () => {
  const seed = ({ errors = {}, extraNotes = [] } = {}) => createFakeDb({
    tables: {
      locations: [loc(STILL, 'UN1T Stillorgan'), loc(HATCH, 'UN1T Hatch Street'), loc(ELSEWHERE, 'Someone Else', { organization_id: OTHER_ORG }), loc(ANCHOR, 'Host (host events)', { is_host_anchor: true })],
      un1t_events: [cls(HATCH, 'RECLA1M'), cls(HATCH, 'RECLA1M', '2026-11-25T07:00:00Z'), cls(HATCH, 'HAUL'), cls(HATCH, 'OLDCLASS', '2026-10-01T07:00:00Z'), cls(ELSEWHERE, 'RECLA1M')],
      agent_knowledge: [
        note(STILL, 'RECLA1M - CONDITIONING', 'Team Conditioning Training Session.'),
        note(STILL, 'OLDCLASS', 'Not on the timetable now.'),
        note(ELSEWHERE, 'RECLA1M', 'Another organisation\'s words.'),
        note(ANCHOR, 'HAUL', 'A host\'s words.'),
        ...extraNotes,
      ],
    },
    errors,
  })

  it("a studio with a synced timetable borrows its sibling's class notes, never another organisation's or a host's", async () => {
    const out = await readSharedClassNotes(seed(), HATCH, { nowMs: NOW })
    expect(out).toEqual([{ category: 'general', title: 'RECLA1M', content: 'Team Conditioning Training Session.', enabled: true, sort_order: 0 }])
  })

  it("the studio's own note for that class is kept and nothing is borrowed for it", async () => {
    const db = seed({ extraNotes: [note(HATCH, 'RECLA1M', 'Our own words.', { enabled: false })] })
    expect(await readSharedClassNotes(db, HATCH, { nowMs: NOW })).toEqual([])
  })

  it('a studio with no synced timetable borrows nothing and reads nothing more', async () => {
    const db = seed()
    expect(await readSharedClassNotes(db, STILL, { nowMs: NOW })).toEqual([])
    expect(db.calls.map((c) => c.table)).toEqual(['un1t_events'])
  })

  it('a failed read borrows nothing and never throws: the studio\'s own notes still answer', async () => {
    for (const table of ['un1t_events', 'locations', 'agent_knowledge']) {
      expect(await readSharedClassNotes(seed({ errors: { [table]: { select: { message: 'boom' } } } }), HATCH, { nowMs: NOW })).toEqual([])
    }
    expect(await readSharedClassNotes(null, HATCH)).toEqual([])
    expect(await readSharedClassNotes(seed(), null)).toEqual([])
  })
})
