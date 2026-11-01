// CLASSFIRST.1 — resolveChosenClass: the server's class off the picker's own
// read; a failed read is timetable_unavailable, a stranger's id class_unavailable,
// no id is simply no class.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/public-classes', () => ({ readPublicClasses: mocks.read }))

import { resolveChosenClass, classColumnsFor, chosenClassRefusal, CLASS_FIRST_DAYS } from './class-first-choice'

const CLASSES = [
  { event_id: 'a', name: 'S&C', starts_at: '2099-01-05T11:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '11:00' },
  { event_id: 'un1t:b', name: 'RALLY', starts_at: '2099-01-07T18:00:00.000Z', day: '2099-01-07', day_label: 'Wed, 7 Jan', time: '18:00' },
]
const db = {}
const blocks = [{ type: 'paid_trial' }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue({ classes: CLASSES, error: null })
})

describe('resolveChosenClass', () => {
  it('no event id is no class, and nothing is read', async () => {
    expect(await resolveChosenClass(db, { locationId: 'loc', blocks })).toEqual({ ok: true, chosen: null })
    expect(await resolveChosenClass(db, { locationId: 'loc', blocks, eventId: '  ' })).toEqual({ ok: true, chosen: null })
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('a listed id answers the server class (id, name, start) off a 14-day read with the page blocks', async () => {
    const r = await resolveChosenClass(db, { locationId: 'loc', blocks, eventId: 'un1t:b' })
    expect(r).toEqual({ ok: true, chosen: { event_id: 'un1t:b', name: 'RALLY', starts_at: '2099-01-07T18:00:00.000Z' } })
    expect(mocks.read).toHaveBeenCalledWith(db, 'loc', CLASS_FIRST_DAYS, { blocks })
    expect(CLASS_FIRST_DAYS).toBe(14)
  })
  it('an id not in the list is class_unavailable', async () => {
    expect(await resolveChosenClass(db, { locationId: 'loc', blocks, eventId: 'zzz' })).toEqual({ ok: false, code: 'class_unavailable' })
  })
  it('a read that failed, or threw, is timetable_unavailable, never "that class is gone"', async () => {
    mocks.read.mockResolvedValueOnce({ classes: [], error: 'glofox_unreachable' })
    expect(await resolveChosenClass(db, { locationId: 'loc', blocks, eventId: 'a' })).toEqual({ ok: false, code: 'timetable_unavailable' })
    mocks.read.mockRejectedValueOnce(new Error('boom'))
    expect(await resolveChosenClass(db, { locationId: 'loc', blocks, eventId: 'a' })).toEqual({ ok: false, code: 'timetable_unavailable' })
  })
})

describe('classColumnsFor / chosenClassRefusal', () => {
  it('the three row columns for a class, nothing for none', () => {
    expect(classColumnsFor({ event_id: 'a', name: 'S&C', starts_at: 'T' })).toEqual({ class_event_id: 'a', class_name: 'S&C', class_starts_at: 'T' })
    expect(classColumnsFor(null)).toEqual({})
  })
  it('400 for a gone class, 503 for an unreadable timetable, in the operator words when given', () => {
    expect(chosenClassRefusal('class_unavailable')).toEqual({ status: 400, body: { success: false, code: 'class_unavailable', error: 'That class is no longer available. Please pick another.' } })
    expect(chosenClassRefusal('timetable_unavailable', { timetable_unavailable: 'Down; buy anyway.' })).toEqual({ status: 503, body: { success: false, code: 'timetable_unavailable', error: 'Down; buy anyway.' } })
  })
})
