// agent-zone.tz.test.js — TZ.5. Mia's daytime gate, quiet hours, nightly
// review window, Monday digest and the class/event labels she reads now follow
// each studio's own timezone. America/New_York follows New York across both
// 2026 DST edges. The Dublin byte-identity sweep ran in TZ.5 and was retired in
// TZ.18b: Europe/Dublin is pinned by fixed values below, and zoned-time ≡
// dublin-time stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test: proves nothing reads the host clock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'Studio' }) }))
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.t' })),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.t' })),
  headerComponentFor: () => null,
  getOrCreateConversation: vi.fn(async () => 'conv1'),
}))
vi.mock('@/lib/radar-outreach', () => ({ extractTemplateBody: () => ({ varCount: 0 }) }))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => {}) }))
vi.mock('@/lib/anthropic', () => ({
  anthropicMessages: vi.fn(async () => ({
    res: { ok: true },
    data: { content: [{ type: 'text', text: '{"score": 2, "flags": ["x"], "summary": "s", "worst_quote": null}' }] },
  })),
}))
vi.mock('./auto-reply', () => ({ AGENT_MODEL: 'test-model', AGENT_THINKING: { type: 'adaptive' } }))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logError: vi.fn(), logWarn: vi.fn() }))

const { withinLocalDaytime, proactiveWindowOpen, runAgentFollowups, runFirstClassCheckins } = await import('./followups')
const { isWithinQuietHours, shouldAgentReply } = await import('./core')
const { reviewWindow, isMondayIn, runAgentReview } = await import('./review')
const { formatClassTime } = await import('./dublin-format')
const { dateLabel, todayIn } = await import('./event-date-label')
const { shapeClassListForAgent, shapeMemberBookingsForAgent } = await import('./booking-tools')
const { formatNextClass } = await import('./account-tools')
const { eventOpenForRegistration, classifyEventCancellation, shapeEventsForAgent, shapeMyRegistrationsForAgent } = await import('./event-tools')
const { shouldSendWelcome } = await import('./welcome-greeting')
const { SettingsSchema } = await import('./settings-contract')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { sendPushToRolesAtLocation } = await import('@/lib/push')
const { logError } = await import('@/lib/log')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const ms = (iso) => Date.parse(iso)

// Dublin instants around both 2026 DST changes (spring-forward Sun 29 Mar
// 01:00Z, fall-back Sun 25 Oct 01:00Z) and an ordinary summer/winter day, with
// whether each is inside the 09:00-20:00 Dublin daytime.
const DUBLIN_DAYTIME = [
  ['2026-03-28T08:59:00Z', false], // 08:59 GMT
  ['2026-03-29T07:59:00Z', false], // 08:59 IST
  ['2026-03-29T08:00:00Z', true], //  09:00 IST
  ['2026-03-29T19:00:00Z', false], // 20:00 IST
  ['2026-10-24T08:00:00Z', true], //  09:00 IST
  ['2026-10-25T08:59:00Z', false], // 08:59 GMT
  ['2026-10-25T09:00:00Z', true], //  09:00 GMT
  ['2026-07-01T18:59:00Z', true], //  19:59 IST
  ['2026-07-01T23:30:00Z', false], // 00:30 IST
  ['2026-12-31T19:59:00Z', true], //  19:59 GMT
  ['2026-12-31T20:00:00Z', false], // 20:00 GMT
]

describe('TZ.5 Europe/Dublin pinned values', () => {
  it('withinLocalDaytime: 09:00-20:00 Dublin across both DST changes (zone omitted = Dublin)', () => {
    for (const [iso, day] of DUBLIN_DAYTIME) {
      expect(withinLocalDaytime(ms(iso), DUB)).toBe(day)
      expect(withinLocalDaytime(ms(iso))).toBe(day)
    }
  })
  it('isWithinQuietHours: 21:00-08:00 on the Dublin clock; a stored tz wins; bad configs are never quiet', () => {
    const q = { start: '21:00', end: '08:00' }
    const at = (iso, cfg = q) => isWithinQuietHours(new Date(iso), cfg, DUB)
    expect(at('2026-03-28T20:59:00Z')).toBe(false) // 20:59 GMT
    expect(at('2026-03-29T19:59:00Z')).toBe(false) // 20:59 IST
    expect(at('2026-03-29T20:00:00Z')).toBe(true) //  21:00 IST
    expect(at('2026-10-24T07:00:00Z')).toBe(false) // 08:00 IST
    expect(at('2026-10-25T07:59:00Z')).toBe(true) //  07:59 GMT
    expect(at('2026-10-25T08:00:00Z')).toBe(false) // 08:00 GMT
    expect(at('2026-07-01T20:30:00Z')).toBe(true) //  21:30 IST
    expect(at('2026-07-01T20:30:00Z', { ...q, tz: 'UTC' })).toBe(false) // 20:30 UTC
    expect(at('2026-12-31T23:30:00Z', { start: '09:00', end: '17:00' })).toBe(false)
    expect(at('2026-12-31T12:00:00Z', { start: '09:00', end: '17:00' })).toBe(true)
    expect(at('2026-12-31T23:30:00Z', null)).toBe(false)
    expect(at('2026-12-31T23:30:00Z', { start: '21:00' })).toBe(false)
    expect(at('2026-12-31T23:30:00Z', { start: '09:00', end: '09:00' })).toBe(false)
    expect(at('2026-12-31T23:30:00Z', { ...q, tz: 'Not/AZone' })).toBe(false)
  })
  it('proactiveWindowOpen: daytime first, then the operator\'s quiet hours', () => {
    expect(proactiveWindowOpen(ms('2026-07-01T12:00:00Z'), { quiet_hours: null }, DUB)).toStrictEqual({ open: true })
    expect(proactiveWindowOpen(ms('2026-07-01T23:30:00Z'), { quiet_hours: null }, DUB)).toStrictEqual({ open: false, reason: 'outside_daytime' })
    expect(proactiveWindowOpen(ms('2026-07-01T12:00:00Z'), { quiet_hours: { start: '09:00', end: '17:00' } }, DUB)).toStrictEqual({ open: false, reason: 'operator_quiet_hours' })
  })
  it('reviewWindow: Dublin\'s yesterday, a 23-hour and a 25-hour day across the DST changes', () => {
    expect(reviewWindow(ms('2026-03-30T03:00:00Z'), DUB)).toStrictEqual({
      reviewDate: '2026-03-29', startIso: '2026-03-29T00:00:00.000Z', endIso: '2026-03-29T23:00:00.000Z',
    })
    expect(reviewWindow(ms('2026-10-26T03:00:00Z'), DUB)).toStrictEqual({
      reviewDate: '2026-10-25', startIso: '2026-10-24T23:00:00.000Z', endIso: '2026-10-26T00:00:00.000Z',
    })
    expect(reviewWindow(ms('2026-07-15T03:00:00Z'), DUB)).toStrictEqual({
      reviewDate: '2026-07-14', startIso: '2026-07-13T23:00:00.000Z', endIso: '2026-07-14T23:00:00.000Z',
    })
    expect(reviewWindow(ms('2026-12-31T03:00:00Z'), DUB)).toStrictEqual({
      reviewDate: '2026-12-30', startIso: '2026-12-30T00:00:00.000Z', endIso: '2026-12-31T00:00:00.000Z',
    })
  })
  it('isMondayIn: the Dublin day', () => {
    expect(isMondayIn(ms('2026-03-29T22:59:00Z'), DUB)).toBe(false) // Sun 23:59 IST
    expect(isMondayIn(ms('2026-03-29T23:30:00Z'), DUB)).toBe(true) //  Mon 00:30 IST
    expect(isMondayIn(ms('2026-10-25T23:30:00Z'), DUB)).toBe(false) // Sun 23:30 GMT
    expect(isMondayIn(ms('2026-10-26T00:00:00Z'), DUB)).toBe(true) //  Mon 00:00 GMT
  })
  it('formatClassTime: Dublin wall clock either side of both DST changes', () => {
    expect(formatClassTime(ms('2026-03-29T00:59:00Z') / 1000, DUB)).toBe('Sun 29 Mar, 00:59')
    expect(formatClassTime(ms('2026-03-29T01:00:00Z') / 1000, DUB)).toBe('Sun 29 Mar, 02:00')
    expect(formatClassTime(ms('2026-10-25T00:30:00Z') / 1000, DUB)).toBe('Sun 25 Oct, 01:30') // IST
    expect(formatClassTime(ms('2026-10-25T01:30:00Z') / 1000, DUB)).toBe('Sun 25 Oct, 01:30') // GMT
    expect(formatClassTime(ms('2026-07-01T23:30:00Z') / 1000, DUB)).toBe('Thu 2 Jul, 00:30')
    expect(formatClassTime(ms('2026-12-31T23:30:00Z') / 1000, DUB)).toBe('Thu 31 Dec, 23:30')
  })
  it('dateLabel (zone-free) and todayIn', () => {
    expect(dateLabel('2026-03-29')).toBe('Sun 29 Mar')
    expect(dateLabel('2026-10-25')).toBe('Sun 25 Oct')
    expect(dateLabel('2026-12-31')).toBe('Thu 31 Dec')
    expect(todayIn(ms('2026-03-28T23:30:00Z'), DUB)).toBe('2026-03-28') // 23:30 GMT
    expect(todayIn(ms('2026-03-29T23:30:00Z'), DUB)).toBe('2026-03-30') // 00:30 IST
    expect(todayIn(ms('2026-10-24T23:30:00Z'), DUB)).toBe('2026-10-25') // 00:30 IST
    expect(todayIn(ms('2026-10-25T23:30:00Z'), DUB)).toBe('2026-10-25') // 23:30 GMT
  })
  it('the tool shapers read Dublin labels with the Dublin zone (no zone = Dublin too)', () => {
    const now = ms('2026-10-24T22:00:00Z')
    const events = [{ _id: 'e1', name: 'HIIT', time_start: ms('2026-10-25T00:30:00Z') / 1000, size: 10, booked: 2 }]
    const label = 'Sun 25 Oct, 01:30'
    expect(shapeClassListForAgent(events, now, 15, DUB)[0].time).toBe(label)
    expect(shapeClassListForAgent(events, now)[0].time).toBe(label)
    const bookings = [{ _id: 'b1', event_name: 'HIIT', status: 'BOOKED', time_start: ms('2026-10-25T00:30:00Z') / 1000 }]
    expect(shapeMemberBookingsForAgent(bookings, now, 10, DUB)[0].time).toBe(label)
    expect(formatNextClass(bookings, new Date(now), DUB).class_time).toBe(label)
    expect(formatNextClass(bookings, new Date(now)).class_time).toBe(label)
  })
})

describe('TZ.5 America/New_York follows New York across DST', () => {
  it('a NY studio at 2026-07-01T23:30Z (19:30 EDT) is in daytime; a Dublin studio (00:30) is not', () => {
    expect(withinLocalDaytime(ms('2026-07-01T23:30:00Z'), NY)).toBe(true)
    expect(withinLocalDaytime(ms('2026-07-01T23:30:00Z'), DUB)).toBe(false)
  })
  it('at 2026-11-01T13:30Z NY is 08:30 EST (outside) and Dublin 13:30 (inside)', () => {
    expect(withinLocalDaytime(ms('2026-11-01T13:30:00Z'), NY)).toBe(false)
    expect(withinLocalDaytime(ms('2026-11-01T13:30:00Z'), DUB)).toBe(true)
  })
  it('the 09:00 NY edge moves from 13:00Z (EDT) to 14:00Z (EST) across the fall-back', () => {
    expect(withinLocalDaytime(ms('2026-10-30T12:59:00Z'), NY)).toBe(false)
    expect(withinLocalDaytime(ms('2026-10-30T13:00:00Z'), NY)).toBe(true)
    expect(withinLocalDaytime(ms('2026-11-02T13:59:00Z'), NY)).toBe(false)
    expect(withinLocalDaytime(ms('2026-11-02T14:00:00Z'), NY)).toBe(true)
    // and back across the spring-forward
    expect(withinLocalDaytime(ms('2026-03-06T13:59:00Z'), NY)).toBe(false)
    expect(withinLocalDaytime(ms('2026-03-09T13:00:00Z'), NY)).toBe(true)
  })
  it('quiet hours with no stored tz are the studio\'s own clock; a stored tz still wins', () => {
    const q = { start: '21:00', end: '08:00' }
    // 2026-07-02T01:30Z = 21:30 EDT (quiet in NY) = 02:30 IST (quiet in Dublin too)
    expect(isWithinQuietHours(new Date('2026-07-02T01:30:00Z'), q, NY)).toBe(true)
    // 2026-07-01T23:30Z = 19:30 EDT (not quiet in NY) = 00:30 IST (quiet in Dublin)
    expect(isWithinQuietHours(new Date('2026-07-01T23:30:00Z'), q, NY)).toBe(false)
    expect(isWithinQuietHours(new Date('2026-07-01T23:30:00Z'), q, DUB)).toBe(true)
    expect(isWithinQuietHours(new Date('2026-07-01T23:30:00Z'), { ...q, tz: 'Europe/Dublin' }, NY)).toBe(true)
    // winter: 2026-12-02T02:30Z = 21:30 EST
    expect(isWithinQuietHours(new Date('2026-12-02T02:30:00Z'), q, NY)).toBe(true)
    expect(isWithinQuietHours(new Date('2026-12-02T00:30:00Z'), q, NY)).toBe(false) // 19:30 EST
  })
  it('the live reply gate and the welcome greeting honour the studio zone for quiet hours', () => {
    const settings = { enabled: true, quiet_hours: { start: '21:00', end: '08:00' } }
    const now = new Date('2026-07-01T23:30:00Z') // 19:30 EDT, 00:30 IST
    const reply = (zone) => shouldAgentReply({ settings, conversation: { agent_active: true }, message: { type: 'text', body: 'hi' }, senderPhone: '1', now, zone })
    expect(reply(NY).reason).not.toBe('quiet_hours')
    expect(reply(DUB)).toMatchObject({ reply: false, reason: 'quiet_hours' })
    expect(shouldSendWelcome({ settings, senderPhone: '1', now, zone: NY })).toEqual({ send: true })
    expect(shouldSendWelcome({ settings, senderPhone: '1', now, zone: DUB })).toEqual({ send: false, reason: 'quiet_hours' })
  })
  it('reviewWindow is the studio\'s own yesterday, in UTC instants that follow its offset', () => {
    // 2026-07-15T03:00Z = 23:00 EDT on the 14th → yesterday = the 13th
    expect(reviewWindow(ms('2026-07-15T03:00:00Z'), NY)).toStrictEqual({
      reviewDate: '2026-07-13', startIso: '2026-07-13T04:00:00.000Z', endIso: '2026-07-14T04:00:00.000Z',
    })
    // across the fall-back: the 1st of Nov is a 25-hour day in New York
    expect(reviewWindow(ms('2026-11-02T12:00:00Z'), NY)).toStrictEqual({
      reviewDate: '2026-11-01', startIso: '2026-11-01T04:00:00.000Z', endIso: '2026-11-02T05:00:00.000Z',
    })
    // across the spring-forward: the 8th of Mar is a 23-hour day
    expect(reviewWindow(ms('2026-03-09T12:00:00Z'), NY)).toStrictEqual({
      reviewDate: '2026-03-08', startIso: '2026-03-08T05:00:00.000Z', endIso: '2026-03-09T04:00:00.000Z',
    })
  })
  it('isMondayIn uses the studio\'s day', () => {
    expect(isMondayIn(ms('2026-11-02T03:00:00Z'), DUB)).toBe(true) // Mon 03:00 GMT
    expect(isMondayIn(ms('2026-11-02T03:00:00Z'), NY)).toBe(false) // Sun 22:00 EST
    expect(isMondayIn(ms('2026-11-03T03:00:00Z'), NY)).toBe(true) // Mon 22:00 EST
  })
  it('class times handed to Mia are New York wall clock', () => {
    expect(formatClassTime(ms('2026-07-01T23:30:00Z') / 1000, NY)).toBe('Wed 1 Jul, 19:30')
    expect(formatClassTime(ms('2026-12-01T23:30:00Z') / 1000, NY)).toBe('Tue 1 Dec, 18:30')
    const now = ms('2026-11-01T04:00:00Z')
    const events = [{ _id: 'e1', name: 'HIIT', time_start: ms('2026-11-01T06:30:00Z') / 1000, size: 10, booked: 2 }]
    expect(shapeClassListForAgent(events, now, 15, NY)[0].time).toBe('Sun 1 Nov, 01:30')
    const bookings = [{ _id: 'b1', event_name: 'HIIT', status: 'BOOKED', time_start: ms('2026-11-01T06:30:00Z') / 1000 }]
    expect(shapeMemberBookingsForAgent(bookings, now, 10, NY)[0].time).toBe('Sun 1 Nov, 01:30')
    expect(formatNextClass(bookings, new Date(now), NY).class_time).toBe('Sun 1 Nov, 01:30')
  })
  it('event "today" flips at New York midnight, not Dublin midnight', () => {
    const t = ms('2026-07-02T02:00:00Z') // 22:00 EDT on the 1st, 03:00 IST on the 2nd
    expect(todayIn(t, NY)).toBe('2026-07-01')
    expect(todayIn(t, DUB)).toBe('2026-07-02')
    const race = { active: true, race_date: '2026-07-01' }
    expect(eventOpenForRegistration(race, t, NY)).toEqual({ open: true })
    expect(eventOpenForRegistration(race, t, DUB)).toEqual({ open: false, reason: 'past' })
    expect(classifyEventCancellation({ isOwner: true, status: 'confirmed', eventDate: '2026-07-01', paidCents: 0, nowMs: t, zone: NY })).toEqual({ action: 'direct' })
    expect(classifyEventCancellation({ isOwner: true, status: 'confirmed', eventDate: '2026-07-01', paidCents: 0, nowMs: t })).toEqual({ action: null, reason: 'event_past' })
    const ev = [{ id: 'r1', name: 'Race', slug: 's', race_date: '2026-07-01', waves: [] }]
    expect(shapeEventsForAgent(ev, {}, t, 'https://x', NY)).toHaveLength(1)
    expect(shapeEventsForAgent(ev, {}, t, 'https://x', DUB)).toHaveLength(0)
    const regs = [{ id: 'g1', status: 'confirmed', race_events: { name: 'Race', race_date: '2026-07-01' } }]
    expect(shapeMyRegistrationsForAgent(regs, t, NY)).toHaveLength(1)
    expect(shapeMyRegistrationsForAgent(regs, t, DUB)).toHaveLength(0)
    // A DATE label never shifts a day, in any zone.
    expect(dateLabel('2026-11-01')).toBe('Sun 1 Nov')
  })
  it('settings: quiet_hours.tz defaults to null (the studio\'s zone), a stored zone is kept', () => {
    const base = { enabled: true }
    expect(SettingsSchema.parse({ ...base, quiet_hours: { start: '21:00', end: '08:00' } }).quiet_hours.tz).toBeNull()
    expect(SettingsSchema.parse({ ...base, quiet_hours: { start: '21:00', end: '08:00', tz: null } }).quiet_hours.tz).toBeNull()
    expect(SettingsSchema.parse({ ...base, quiet_hours: { start: '21:00', end: '08:00', tz: 'Europe/Dublin' } }).quiet_hours.tz).toBe('Europe/Dublin')
  })
})

// ── the runners: the daytime gate is per location ────────────────────────────

const agentOn = (extra) => ({ customer_agent: { enabled: true, followups: { enabled: true }, first_class_checkin: { enabled: true }, ...extra } })
const LOC_DUB = { id: 'loc-dub', name: 'Dublin studio', organization_id: null, settings: agentOn() }
const LOC_NY = { id: 'loc-ny', name: 'New York studio', organization_id: null, settings: agentOn() }
const ZONES = { 'loc-dub': DUB, 'loc-ny': NY }

// Records every chain; the locations list, the zone read and everything else
// answer from the options. A candidate query naming a location means that
// location's window was open.
function runnerDb({ locations, zoneError = null, zones = ZONES } = {}) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, cols: '', op: 'select', filters: [], opts: null }
      const answer = () => {
        if (table === 'location_whatsapp_numbers') return { data: locations.map((l) => ({ location_id: l.id })), error: null } // MIAORG.1 Task 6 / WAORGNUMBER.1: a number is switched on at the studio
        if (table === 'locations') {
          if (q.cols.includes('timezone')) {
            if (zoneError) return { data: null, error: zoneError }
            const ids = (q.filters.find((f) => f[0] === 'in')?.[2]) || locations.map((l) => l.id)
            return { data: ids.filter((id) => id in zones).map((id) => ({ id, timezone: zones[id] })), error: null }
          }
          return { data: locations, error: null }
        }
        if (q.opts?.head) return { count: 0, error: null }
        return { data: [], error: null }
      }
      const f = (name) => (...args) => { q.filters.push([name, ...args]); return b }
      const b = {
        select: (cols, o) => { q.cols = cols || ''; if (o) q.opts = o; return b },
        update: () => { q.op = 'update'; return b },
        insert: () => Promise.resolve({ data: null, error: null }),
        eq: f('eq'), in: f('in'), gte: f('gte'), lt: f('lt'), lte: f('lte'), is: f('is'), not: f('not'), or: f('or'),
        order: () => b, limit: () => b, maybeSingle: () => b, single: () => b,
        then: (ok, bad) => { log.push(q); return Promise.resolve(answer()).then(ok, bad) },
      }
      return b
    },
  }
}
const queriedLocations = (db, table) => [...new Set(db.log
  .filter((q) => q.table === table && q.op === 'select')
  .map((q) => q.filters.find((f) => f[0] === 'eq' && f[1] === 'location_id')?.[2])
  .filter(Boolean))].sort()

let warnSpy
beforeEach(() => {
  resetLocationZoneCache()
  vi.clearAllMocks()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { warnSpy.mockRestore() })

describe('TZ.5 runAgentFollowups — each studio gets its own daytime', () => {
  it('2026-07-01T23:30Z: the New York studio runs, the Dublin studio is outside its daytime', async () => {
    const db = runnerDb({ locations: [LOC_DUB, LOC_NY] })
    const out = await runAgentFollowups(db, { nowMs: ms('2026-07-01T23:30:00Z') })
    expect(out.reason).toBeUndefined()
    expect(queriedLocations(db, 'whatsapp_conversations')).toEqual(['loc-ny'])
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('"locationId":"loc-dub","reason":"outside_daytime"')
  })
  it('2026-11-01T13:30Z: the Dublin studio runs, New York (08:30 EST) does not', async () => {
    const db = runnerDb({ locations: [LOC_DUB, LOC_NY] })
    await runAgentFollowups(db, { nowMs: ms('2026-11-01T13:30:00Z') })
    expect(queriedLocations(db, 'whatsapp_conversations')).toEqual(['loc-dub'])
  })
  it('no studio in its daytime: the run is the old quiet_hours no-op', async () => {
    const db = runnerDb({ locations: [LOC_DUB, LOC_NY] })
    const out = await runAgentFollowups(db, { nowMs: ms('2026-07-02T03:00:00Z') }) // 23:00 EDT, 04:00 IST
    expect(out).toEqual({ nudges: 0, templates: 0, skipped: 0, reason: 'quiet_hours' })
    expect(queriedLocations(db, 'whatsapp_conversations')).toEqual([])
  })
  it('a Dublin-only estate runs only inside Dublin daytime, across the DST edges', async () => {
    for (const [iso, day] of DUBLIN_DAYTIME) {
      const db = runnerDb({ locations: [LOC_DUB] })
      const out = await runAgentFollowups(db, { nowMs: ms(iso) })
      expect(out.reason).toBe(day ? undefined : 'quiet_hours')
      expect(queriedLocations(db, 'whatsapp_conversations')).toEqual(day ? ['loc-dub'] : [])
    }
  })
  it('an estate with no active location keeps the old platform-clock answer', async () => {
    const night = await runAgentFollowups(runnerDb({ locations: [] }), { nowMs: ms('2026-07-02T03:00:00Z') })
    expect(night.reason).toBe('quiet_hours')
    const day = await runAgentFollowups(runnerDb({ locations: [] }), { nowMs: ms('2026-07-02T12:00:00Z') })
    expect(day).toEqual({ nudges: 0, templates: 0, skipped: 0 })
  })
  it('a LocationZoneReadError skips every location it covers (never a silent Dublin), logged once', async () => {
    const db = runnerDb({ locations: [LOC_DUB, LOC_NY], zoneError: { message: 'statement timeout', code: '57014' } })
    const out = await runAgentFollowups(db, { nowMs: ms('2026-07-01T12:00:00Z') }) // daytime in both
    expect(out.reason).toBeUndefined() // an outage is not quiet hours
    expect(queriedLocations(db, 'whatsapp_conversations')).toEqual([])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][1]).toMatch(/zone/)
    const warned = warnSpy.mock.calls.flat().join(' ')
    expect(warned).toContain('"locationId":"loc-dub","reason":"zone_read_failed"')
    expect(warned).toContain('"locationId":"loc-ny","reason":"zone_read_failed"')
  })
})

describe('TZ.5 runFirstClassCheckins — each studio gets its own daytime', () => {
  it('2026-07-01T23:30Z: only the New York studio looks for candidates', async () => {
    const db = runnerDb({ locations: [LOC_DUB, LOC_NY] })
    const out = await runFirstClassCheckins(db, { nowMs: ms('2026-07-01T23:30:00Z') })
    expect(out.reason).toBeUndefined()
    expect(out.reasons).toEqual({ outside_daytime: 1 })
    expect(queriedLocations(db, 'contacts')).toEqual(['loc-ny'])
  })
  it('2026-11-01T13:30Z: only the Dublin studio looks for candidates', async () => {
    const db = runnerDb({ locations: [LOC_DUB, LOC_NY] })
    const out = await runFirstClassCheckins(db, { nowMs: ms('2026-11-01T13:30:00Z') })
    expect(out.reasons).toEqual({ outside_daytime: 1 })
    expect(queriedLocations(db, 'contacts')).toEqual(['loc-dub'])
  })
  it('a Dublin-only estate returns the old tick shape, across the DST edges', async () => {
    for (const [iso, day] of DUBLIN_DAYTIME) {
      const db = runnerDb({ locations: [LOC_DUB] })
      const out = await runFirstClassCheckins(db, { nowMs: ms(iso) })
      if (day) {
        expect(out).toEqual({ freeform: 0, templates: 0, skipped: 0, candidates: 0, reasons: {} })
      } else {
        expect(out).toEqual({ freeform: 0, templates: 0, skipped: 0, candidates: 0, reasons: {}, reason: 'quiet_hours' })
      }
    }
  })
  it('a LocationZoneReadError skips each enabled location and says so in the tally', async () => {
    const db = runnerDb({ locations: [LOC_DUB, LOC_NY], zoneError: { message: 'boom' } })
    const out = await runFirstClassCheckins(db, { nowMs: ms('2026-07-01T12:00:00Z') })
    expect(out.reason).toBeUndefined()
    expect(out.reasons).toEqual({ zone_read_failed: 2 })
    expect(queriedLocations(db, 'contacts')).toEqual([])
  })
})

// ── the nightly review: each studio reviews its own yesterday ────────────────

function reviewDb({ locations, messages, reviews = [], zoneError = null }) {
  const log = []
  const inserts = []
  return {
    log,
    inserts,
    from(table) {
      const q = { table, cols: '', filters: [] }
      const val = (name, col) => q.filters.find((f) => f[0] === name && f[1] === col)?.[2]
      const answer = () => {
        if (table === 'location_whatsapp_numbers') return { data: locations.map((l) => ({ location_id: l.id })), error: null } // MIAORG.1 Task 6 / WAORGNUMBER.1: a number is switched on at the studio
        if (table === 'locations') return zoneError ? { data: null, error: zoneError } : { data: locations, error: null }
        if (table === 'whatsapp_messages' && val('eq', 'source') === 'agent') {
          const from = val('gte', 'created_at'); const to = val('lt', 'created_at')
          return { data: messages.filter((m) => m.created_at >= from && m.created_at < to), error: null }
        }
        if (table === 'whatsapp_messages') {
          return { data: [{ direction: 'inbound', source: 'api', body: 'hi', created_at: '2026-07-14T10:00:00Z' }], error: null }
        }
        if (table === 'agent_conversation_reviews' && q.cols.includes('score')) return { data: reviews, error: null }
        return { data: [], error: null }
      }
      const f = (name) => (...args) => { q.filters.push([name, ...args]); return b }
      const b = {
        select: (cols) => { q.cols = cols || ''; return b },
        insert: (row) => { inserts.push(row); return Promise.resolve({ error: null }) },
        eq: f('eq'), in: f('in'), gte: f('gte'), lt: f('lt'),
        order: () => b, limit: () => b, range: () => b,
        then: (ok, bad) => { log.push(q); return Promise.resolve(answer()).then(ok, bad) },
      }
      return b
    },
  }
}
const candidateWindows = (db) => db.log
  .filter((q) => q.table === 'whatsapp_messages' && q.filters.some((f) => f[0] === 'eq' && f[2] === 'agent'))
  .map((q) => [q.filters.find((f) => f[0] === 'gte')[2], q.filters.find((f) => f[0] === 'lt')[2]])

describe('TZ.5 runAgentReview — per-studio window and Monday', () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'k' })
  const LOCS = [{ id: 'loc-dub', timezone: DUB }, { id: 'loc-ny', timezone: NY }]

  it('reviews each studio\'s own yesterday and stamps its own review_date', async () => {
    const messages = [
      { conversation_id: 'c-dub', location_id: 'loc-dub', created_at: '2026-07-14T10:00:00.000Z' },
      { conversation_id: 'c-ny', location_id: 'loc-ny', created_at: '2026-07-13T20:00:00.000Z' },
      // inside Dublin's window but not New York's: never reviewed as a NY row
      { conversation_id: 'c-ny-late', location_id: 'loc-ny', created_at: '2026-07-14T10:00:00.000Z' },
    ]
    const db = reviewDb({ locations: LOCS, messages })
    const out = await runAgentReview(db, { nowMs: ms('2026-07-15T03:00:00Z') })
    expect(candidateWindows(db)).toEqual([
      ['2026-07-13T23:00:00.000Z', '2026-07-14T23:00:00.000Z'], // Dublin's 14th
      ['2026-07-13T04:00:00.000Z', '2026-07-14T04:00:00.000Z'], // New York's 13th
    ])
    expect(db.inserts.map((r) => [r.conversation_id, r.location_id, r.review_date])).toEqual([
      ['c-dub', 'loc-dub', '2026-07-14'],
      ['c-ny', 'loc-ny', '2026-07-13'],
    ])
    expect(out.reviewed).toBe(2)
  })

  it('a Dublin-only estate (Dublin + NULL column) runs the one Dublin window', async () => {
    for (const [iso, w] of [
      ['2026-03-30T03:00:00Z', ['2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z']], // 23-hour day
      ['2026-07-15T03:00:00Z', ['2026-07-13T23:00:00.000Z', '2026-07-14T23:00:00.000Z']],
      ['2026-10-26T03:00:00Z', ['2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z']], // 25-hour day
      ['2026-12-31T03:00:00Z', ['2026-12-30T00:00:00.000Z', '2026-12-31T00:00:00.000Z']],
    ]) {
      const db = reviewDb({ locations: [{ id: 'loc-dub', timezone: DUB }, { id: 'loc-dub2', timezone: null }], messages: [] })
      await runAgentReview(db, { nowMs: ms(iso) })
      expect(candidateWindows(db)).toEqual([w])
    }
  })

  it('the Monday digest goes to each studio on its own Monday', async () => {
    const reviews = [
      { location_id: 'loc-dub', score: 1, flags: [] },
      { location_id: 'loc-ny', score: 1, flags: [] },
    ]
    await runAgentReview(reviewDb({ locations: LOCS, messages: [], reviews }), { nowMs: ms('2026-11-02T03:00:00Z') })
    expect(sendPushToRolesAtLocation.mock.calls.map((c) => c[0])).toEqual(['loc-dub'])
    sendPushToRolesAtLocation.mockClear()
    await runAgentReview(reviewDb({ locations: LOCS, messages: [], reviews }), { nowMs: ms('2026-11-03T03:00:00Z') })
    expect(sendPushToRolesAtLocation.mock.calls.map((c) => c[0])).toEqual(['loc-ny'])
  })

  it('an unreadable zone list skips the run (and the digest), logged, never a Dublin guess', async () => {
    const db = reviewDb({ locations: LOCS, messages: [], reviews: [{ location_id: 'loc-dub', score: 1, flags: [] }], zoneError: { message: 'boom' } })
    const out = await runAgentReview(db, { nowMs: ms('2026-11-02T03:00:00Z') })
    expect(out).toEqual({ reviewed: 0, flagged: 0, skipped: 0, error: 'zone_read_failed' })
    expect(candidateWindows(db)).toEqual([])
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
  })
})
