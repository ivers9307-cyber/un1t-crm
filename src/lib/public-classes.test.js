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

// MANUALFUNNEL.1 — a studio with no Glofox lists the timetable its operator
// wrote on the class_funnel block.
describe('readPublicClasses — manual timetable (no Glofox)', () => {
  function landingDb(result) {
    const calls = []
    const b = {
      from: (t) => { calls.push(['from', t]); return b },
      select: (c) => { calls.push(['select', c]); return b },
      eq: (c, v) => { calls.push(['eq', c, v]); return b },
      maybeSingle: async () => result,
    }
    return { db: b, calls }
  }
  async function noGlofox() {
    const { missingGlofoxCredentialsForLocation } = await import('@/lib/glofox')
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: null })
    missingGlofoxCredentialsForLocation.mockReturnValueOnce(['Branch ID', 'API Key', 'API Token'])
  }
  const TIMETABLE = 'Mon-Sun 06:15 Strength\nMon-Sun 18:00 Conditioning'

  it('lists the block timetable in the public class shape, read by location, and never calls Glofox', async () => {
    await noGlofox()
    const { db, calls } = landingDb({ data: { blocks: [{ type: 'class_funnel', timetable: TIMETABLE, min_notice_hours: 0 }] }, error: null })
    const out = await readPublicClasses(db, 'HATCH', 7)
    expect(out.error).toBeNull()
    expect(out.classes.length).toBeGreaterThanOrEqual(12)
    for (const c of out.classes) {
      expect(Object.keys(c).sort()).toEqual([...PUBLIC_CLASS_KEYS].sort())
      expect(c.event_id.startsWith('manual-')).toBe(true)
      expect(Date.parse(c.starts_at)).toBeGreaterThan(Date.now())
    }
    expect(calls).toEqual([['from', 'landing_page_settings'], ['select', 'blocks'], ['eq', 'location_id', 'HATCH']])
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('the 14-day read the booking route validates against contains every class the 7-day list shows', async () => {
    const blocks = [{ type: 'class_funnel', timetable: TIMETABLE }]
    await noGlofox()
    const shown = await readPublicClasses(landingDb({ data: { blocks }, error: null }).db, 'HATCH', 7)
    await noGlofox()
    const valid = await readPublicClasses(landingDb({ data: { blocks }, error: null }).db, 'HATCH', 14)
    const ids = new Set(valid.classes.map((c) => c.event_id))
    expect(shown.classes.length).toBeGreaterThan(0)
    for (const c of shown.classes) expect(ids.has(c.event_id)).toBe(true)
  })

  it('a landing row that could not be read is an error, not an empty timetable', async () => {
    await noGlofox()
    const out = await readPublicClasses(landingDb({ data: null, error: { message: 'boom' } }).db, 'HATCH', 7)
    expect(out).toEqual({ classes: [], error: 'manual_timetable_unreadable' })
  })

  it('no landing row, or a block with no timetable, is an empty list with no error', async () => {
    await noGlofox()
    expect(await readPublicClasses(landingDb({ data: null, error: null }).db, 'HATCH', 7)).toEqual({ classes: [], error: null })
    await noGlofox()
    expect(await readPublicClasses(landingDb({ data: { blocks: [{ type: 'class_funnel' }] }, error: null }).db, 'HATCH', 7)).toEqual({ classes: [], error: null })
  })

  it('a studio WITH Glofox never reads the manual timetable', async () => {
    const { db, calls } = landingDb({ data: { blocks: [{ type: 'class_funnel', timetable: TIMETABLE }] }, error: null })
    const out = await readPublicClasses(db, 'L', 7)
    expect(out.classes.map((c) => c.event_id)).toEqual(['e1'])
    expect(calls).toEqual([])
  })
})
