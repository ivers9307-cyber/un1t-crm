// OPENWEEK.1 — the server's judgement of an open week claim's picks. Never a database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), lastDay: vi.fn() }))
vi.mock('@/lib/public-classes', () => ({ readPublicClasses: mocks.read }))
vi.mock('@/lib/glofox-credit-window', async (orig) => ({ ...(await orig()), readPromoCreditLastDay: mocks.lastDay }))

import { resolveOpenWeekPicks, insertClaimClasses } from './open-week-claim'

const DUB = 'Europe/Dublin'
const PROMO = { key: 'hatch-open-week', kind: 'open_week', windowStartsOn: '2026-11-23', windowEndsOn: '2026-11-30', maxClasses: 5, maxPerDay: 1 }
const NOW = new Date('2026-11-18T12:00:00Z')
const cls = (id, day) => ({ event_id: id, name: `Class ${id}`, starts_at: `${day}T07:00:00.000Z`, day })
const CLASSES = [cls('early', '2026-11-22'), cls('a', '2026-11-24'), cls('b', '2026-11-25'), cls('late', '2026-12-01')]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue({ classes: CLASSES, error: null })
  mocks.lastDay.mockResolvedValue(null)
})

const run = (eventIds, now = NOW) => resolveOpenWeekPicks({}, { locationId: 'L', blocks: [], promo: PROMO, zone: DUB, eventIds, now })

describe('resolveOpenWeekPicks', () => {
  it('reads from the start of the window to its end', async () => {
    await run(['a'])
    expect(mocks.read).toHaveBeenCalledWith({}, 'L', 13, { blocks: [], fromMs: Date.parse('2026-11-23T00:00:00Z') })
  })

  it('answers the picks for valid classes', async () => {
    expect(await run(['b', 'a'])).toEqual({ ok: true, picks: [
      { event_id: 'a', name: 'Class a', starts_at: '2026-11-24T07:00:00.000Z', day: '2026-11-24' },
      { event_id: 'b', name: 'Class b', starts_at: '2026-11-25T07:00:00.000Z', day: '2026-11-25' },
    ] })
  })

  it('is over after the last day, before any read', async () => {
    expect(await run(['a'], new Date('2026-12-01T09:00:00Z'))).toEqual({ ok: false, code: 'over' })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('a failed read is timetable_unavailable', async () => {
    mocks.read.mockResolvedValueOnce({ classes: [], error: 'glofox_unreachable' })
    expect(await run(['a'])).toEqual({ ok: false, code: 'timetable_unavailable' })
    mocks.read.mockRejectedValueOnce(new Error('boom'))
    expect(await run(['a'])).toEqual({ ok: false, code: 'timetable_unavailable' })
  })

  it('a class outside the window, or absent from the read (full), is class_unavailable', async () => {
    expect(await run(['early'])).toEqual({ ok: false, code: 'class_unavailable', eventId: 'early' })
    expect(await run(['late'])).toEqual({ ok: false, code: 'class_unavailable', eventId: 'late' })
    expect(await run(['gone'])).toEqual({ ok: false, code: 'class_unavailable', eventId: 'gone' })
  })
})

describe('the plan credit window (CREDITWINDOW.1)', () => {
  it('refuses a class in the open week that the plan credits expire before', async () => {
    mocks.lastDay.mockResolvedValue('2026-11-24')
    expect(await run(['a'])).toMatchObject({ ok: true })
    expect(await run(['b'])).toEqual({ ok: false, code: 'class_unavailable', eventId: 'b' })
    expect(mocks.lastDay).toHaveBeenCalledWith({}, { locationId: 'L', promo: PROMO, zone: DUB, now: NOW })
  })

  it('an unknown window caps nothing', async () => {
    mocks.lastDay.mockResolvedValue(null)
    expect(await run(['a', 'b'])).toMatchObject({ ok: true })
  })
})

describe('insertClaimClasses', () => {
  it('inserts one row per pick and returns the error', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    const db = { from: vi.fn(() => ({ insert })) }
    const picks = [{ event_id: 'a', name: 'A', starts_at: '2026-11-24T07:00:00.000Z', day: '2026-11-24' }]
    expect(await insertClaimClasses(db, { claimId: 'c1', locationId: 'L', picks })).toEqual({ error: null })
    expect(db.from).toHaveBeenCalledWith('corp_promo_claim_classes')
    expect(insert).toHaveBeenCalledWith([{ claim_id: 'c1', location_id: 'L', class_event_id: 'a', class_name: 'A', class_starts_at: '2026-11-24T07:00:00.000Z' }])
    const failing = { from: () => ({ insert: async () => ({ error: { code: '42501' } }) }) }
    expect(await insertClaimClasses(failing, { claimId: 'c1', locationId: 'L', picks })).toEqual({ error: { code: '42501' } })
  })
})
