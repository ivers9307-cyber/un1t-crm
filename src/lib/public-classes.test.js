import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [
    { _id: 'e1', name: 'S&C', time_start: 4102444800, duration: 60, size: 12, booked: 4, active: true, private: false },
  ] })),
}))
import { shapePublicClass, listPublicClasses, readPublicClasses, parseHiddenKeywords, isClassHidden, isEventFull, PUBLIC_CLASS_KEYS } from './public-classes'
import { fetchUpcomingEvents, glofoxCredentialsForLocation } from '@/lib/glofox'

// db stub for listPublicClasses' settings read (db.from('locations')...maybeSingle()).
function makeDb(settings) {
  const api = { from() { return api }, select() { return api }, eq() { return api }, maybeSingle: async () => ({ data: { settings } }) }
  return api
}

beforeEach(() => vi.clearAllMocks())
// PUBCAP.1 — any key that could tell a customer how full a class is.
const CAPACITY_KEY = /spot|capacity|size|booked|remaining|left|place|seat|full|waiting|limit/i

describe('shapePublicClass', () => {
  it('maps a glofox event to the UI shape with Dublin day + time', () => {
    const c = shapePublicClass({ _id: 'e1', name: 'S&C', time_start: 1751959800, size: 12, booked: 4 })
    expect(c.event_id).toBe('e1')
    expect(c.name).toBe('S&C')
    expect(typeof c.day).toBe('string')
    expect(/^\d{2}:\d{2}$/.test(c.time)).toBe(true)
  })

  it('PUBCAP.1: carries exactly the display keys and never a capacity figure', () => {
    const c = shapePublicClass({ _id: 'e1', name: 'S&C', time_start: 1751959800, size: 12, booked: 4, waiting: 2, spots_left: 8 })
    expect(Object.keys(c).sort()).toEqual([...PUBLIC_CLASS_KEYS].sort())
    for (const k of Object.keys(c)) expect(k).not.toMatch(CAPACITY_KEY)
    // No number that could be a count rides along in any value either.
    expect(JSON.stringify(c)).not.toMatch(/"(?:8|12|4)"|:\s*(?:8|12|4)[,}]/)
  })
})

describe('isEventFull (server-side only)', () => {
  it('is full when booked reaches size; an unknown size is never full', () => {
    expect(isEventFull({ size: 5, booked: 5 })).toBe(true)
    expect(isEventFull({ size: 5, booked: 6 })).toBe(true)
    expect(isEventFull({ size: 5, booked: 4 })).toBe(false)
    expect(isEventFull({ size: 0, booked: 3 })).toBe(false)
    expect(isEventFull({})).toBe(false)
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
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', hiddenClassKeywords: ['el1tes'], readError: null })
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: [
      { _id: 'b1', name: 'BASE - STRENGTH', time_start: 4102444800, size: 30, booked: 1, active: true, private: false },
      { _id: 'e1', name: 'EL1TES CLASS', time_start: 4102448400, size: 12, booked: 1, active: true, private: false },
    ] })
    const out = await listPublicClasses(makeDb({}), 'L', 7)
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

describe('listPublicClasses — PUBCAP.1 no capacity leaves the server', () => {
  it('drops a full class and returns only display keys for the rest', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: [
      { _id: 'open', name: 'BASE', time_start: 4102444800, size: 12, booked: 11, waiting: 0, active: true, private: false },
      { _id: 'full', name: 'HIIT', time_start: 4102448400, size: 12, booked: 12, waiting: 3, active: true, private: false },
    ] })
    const out = await listPublicClasses(makeDb({}), 'L', 7)
    expect(out.map((c) => c.event_id)).toEqual(['open'])
    for (const c of out) {
      expect(Object.keys(c).sort()).toEqual([...PUBLIC_CLASS_KEYS].sort())
      for (const k of Object.keys(c)) expect(k).not.toMatch(CAPACITY_KEY)
    }
  })
})

// Every read answers an error — the shape a DB blip gives any second read.
function failingDb() {
  const b = {
    from: () => b, select: () => b, eq: () => b, in: () => b,
    maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
    then: (resolve, reject) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve, reject),
  }
  return b
}

describe('readPublicClasses — REGISTRYREAD.1a', () => {
  const EVENTS = [
    { _id: 'b1', name: 'BASE - STRENGTH', time_start: 4102444800, size: 30, booked: 1, active: true, private: false },
    { _id: 'e1', name: 'EL1TES CLASS', time_start: 4102448400, size: 12, booked: 1, active: true, private: false },
  ]

  it('a failing second read can no longer unhide a class (the deny-list rides on the credentials read)', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', hiddenClassKeywords: ['el1tes'], readError: null })
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const out = await listPublicClasses(failingDb(), 'L', 7)
    expect(out.map((c) => c.name)).toEqual(['BASE - STRENGTH'])
  })

  it('an unreadable settings row is an error, not an empty timetable, and Glofox is not called', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const out = await readPublicClasses(makeDb({}), 'L', 7)
    expect(out).toEqual({ classes: [], error: 'glofox_settings_unreadable' })
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('a failed Glofox fetch is an error too', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: false, events: [] })
    expect(await readPublicClasses(makeDb({}), 'L', 7)).toEqual({ classes: [], error: 'glofox_unreachable' })
  })

  it('a studio with no Glofox is an empty list with no error (a real answer)', async () => {
    const { missingGlofoxCredentialsForLocation } = await import('@/lib/glofox')
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: null })
    missingGlofoxCredentialsForLocation.mockReturnValueOnce(['Branch ID', 'API Key', 'API Token'])
    expect(await readPublicClasses(makeDb({}), 'L', 7)).toEqual({ classes: [], error: null })
  })

  it('listPublicClasses keeps its old contract: [] on any failure', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    expect(await listPublicClasses(makeDb({}), 'L', 7)).toEqual([])
  })
})
