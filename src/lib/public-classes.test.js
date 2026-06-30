import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [
    { _id: 'e1', name: 'S&C', time_start: 4102444800, duration: 60, size: 12, booked: 4, active: true, private: false },
  ] })),
}))
import { shapePublicClass, listPublicClasses, parseHiddenKeywords, isClassHidden } from './public-classes'
import { fetchUpcomingEvents } from '@/lib/glofox'

// db stub for listPublicClasses' settings read (db.from('locations')...maybeSingle()).
function makeDb(settings) {
  const api = { from() { return api }, select() { return api }, eq() { return api }, maybeSingle: async () => ({ data: { settings } }) }
  return api
}

beforeEach(() => vi.clearAllMocks())
describe('shapePublicClass', () => {
  it('maps a glofox event to the UI shape with Dublin day + time', () => {
    const c = shapePublicClass({ _id: 'e1', name: 'S&C', time_start: 1751959800, size: 12, booked: 4 })
    expect(c.event_id).toBe('e1')
    expect(c.name).toBe('S&C')
    expect(c.spots_left).toBe(8)
    expect(c.full).toBe(false)
    expect(typeof c.day).toBe('string')
    expect(/^\d{2}:\d{2}$/.test(c.time)).toBe(true)
  })
  it('marks full when no spots', () => {
    expect(shapePublicClass({ _id: 'e', name: 'x', time_start: 1751959800, size: 5, booked: 5 }).full).toBe(true)
  })
})

describe('parseHiddenKeywords', () => {
  it('normalizes array + comma/newline string forms to trimmed lowercase', () => {
    expect(parseHiddenKeywords(['EL1TES', ' Open Gym '])).toEqual(['el1tes', 'open gym'])
    expect(parseHiddenKeywords('EL1TES, Open Gym\nPT')).toEqual(['el1tes', 'open gym', 'pt'])
    expect(parseHiddenKeywords(null)).toEqual([])
    expect(parseHiddenKeywords('')).toEqual([])
  })
})

describe('isClassHidden', () => {
  it('matches a case-insensitive name substring; empty list hides nothing', () => {
    expect(isClassHidden('EL1TES CLASS', ['el1tes'])).toBe(true)
    expect(isClassHidden('BASE - STRENGTH', ['el1tes'])).toBe(false)
    expect(isClassHidden('BASE - STRENGTH', [])).toBe(false)
  })
})

describe('listPublicClasses deny-list', () => {
  it('drops classes whose name matches a configured hidden keyword', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: [
      { _id: 'b1', name: 'BASE - STRENGTH', time_start: 4102444800, size: 30, booked: 1, active: true, private: false },
      { _id: 'e1', name: 'EL1TES CLASS', time_start: 4102448400, size: 12, booked: 1, active: true, private: false },
    ] })
    const db = makeDb({ glofox: { hidden_class_keywords: ['el1tes'] } })
    const out = await listPublicClasses(db, 'L', 7)
    expect(out.map((c) => c.name)).toEqual(['BASE - STRENGTH'])
  })
  it('shows every class when no deny-list is set', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: [
      { _id: 'b1', name: 'BASE - STRENGTH', time_start: 4102444800, size: 30, booked: 1, active: true, private: false },
      { _id: 'e1', name: 'EL1TES CLASS', time_start: 4102448400, size: 12, booked: 1, active: true, private: false },
    ] })
    const out = await listPublicClasses(makeDb({}), 'L', 7)
    expect(out.map((c) => c.name).sort()).toEqual(['BASE - STRENGTH', 'EL1TES CLASS'])
  })
})
