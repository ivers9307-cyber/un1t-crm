// events-races.tz.test.js — TZ.9: events, races, entry moves, the waitlist,
// hyrox and the host schedule take the zone of the studio they belong to
// (race_events.location_id; a host event's location is the host's anchor;
// hyrox_blocks.location_id), not Europe/Dublin.
//
// Two halves, as every sweep: (1) Europe/Dublin is byte-identical to the
// frozen pre-change code (events-races.legacy-dublin.test-helpers.js) over the
// DST-edge samples and every day/hour of 2026; (2) America/New_York follows
// New York's clock across both 2026 US DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fakeDb, eqOf } from './event-waitlist.test-helpers'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/postmark', async (importOriginal) => ({ ...(await importOriginal()), sendTransactionalEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(async () => ({})) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/event-checkin-tokens', () => ({ signCheckinToken: () => 'tok' }))
vi.mock('@/lib/event-comms-location', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEventCommsLocation: vi.fn(async () => null),
}))
vi.mock('@/lib/event-email', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEventEmail: vi.fn(async () => ({ subject: 'Reminder', htmlBody: '<p>hi</p>' })),
}))
vi.mock('@/lib/race-confirmations', async (importOriginal) => ({ ...(await importOriginal()), sendRegistrationMovedEmail: vi.fn(async () => ({ sent: [] })) }))
vi.mock('@/lib/host-contact-list', () => ({ addEventAttendeesToHostList: vi.fn(async () => ({})) }))
vi.mock('@/lib/hyrox/expand-plan', async (importOriginal) => ({ ...(await importOriginal()), weeksNeedingExpansion: vi.fn(() => []) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 1, failed: 0 })), readRoleRecipientIds: vi.fn(async () => ({ ids: new Set(['p1']), error: null })) }))

const LEGACY = await import('./events-races.legacy-dublin.test-helpers.js')
const { todayIsoIn, todayIsoDublin, orderEventsForBrowse } = await import('@shared/events')
const { eventZone, eventToday, earliestLocalToday, eventDateLong } = await import('./event-day.js')
const { runEventReminders, reminderTimeLabel } = await import('./event-attendee-reminders.js')
const { runWaitlistOffers } = await import('./event-waitlist.js')
const { evaluateMove, listMoveTargets } = await import('./registration-move.js')
const { toBrowseCard } = await import('./public-events.js')
const HST = await import('./host-schedule-time.js')
const { weekNoFor, slotFor, zonedDateStr } = await import('./hyrox/mapping.js')
const { runExpandHyroxWeeks } = await import('./hyrox/expand-runner.js')
const { runHyroxClassReminder, hyroxClassTimeLabel } = await import('./hyrox/reminder-runner.js')
const { pickSessionForOccurrence } = await import('./hyrox/publish.js')
const { resetLocationZoneCache } = await import('./location-time.js')
const { sendCustomerPush } = await import('@/lib/customer-push')
const { weeksNeedingExpansion } = await import('@/lib/hyrox/expand-plan')
const { sendPush } = await import('@/lib/push')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', // NY around spring-forward
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', // Dublin around spring-forward
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', // Dublin around fall-back
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', // NY around fall-back
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z', // month/year edges
]
const DAYS_2026 = (() => {
  const out = []
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
})()
const HOURS_2026 = (() => {
  const out = []
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) out.push(t)
  return out
})()
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const loc = (zone, id = zone === NY ? 'L-ny' : 'L-dub') => ({ id, name: 'Studio', is_host_anchor: false, organization_id: 'o1', timezone: zone })

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  resetLocationZoneCache()
})

// ── fakes ──────────────────────────────────────────────────────────────────
// race_events read for the reminders: honours .in('race_date', [...]).
function remindersDb(events) {
  return fakeDb((q) => {
    if (q.table === 'race_events') {
      const inOp = q.ops.find((o) => o[0] === 'in' && o[1] === 'race_date')
      return { data: events.filter((e) => inOp[2].includes(e.race_date)), error: null }
    }
    if (q.table === 'race_registrations') {
      const evId = eqOf(q, 'race_event_id')
      return { data: [{ id: `reg-${evId}`, race_event_id: evId, contact_id: `c-${evId}`, status: 'confirmed', contact: null, wave: null, teams: null }], error: null }
    }
    if (q.table === 'event_reminder_sends' && q.action === 'insert') return { error: null }
    if (q.table === 'event_reminder_sends') return { data: [], error: null }
    return { data: null, error: null }
  })
}
// The pre-TZ.9 "today" (dublin-time's dublinTodayStr) at an instant.
function legacyTodayAt(ms) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ms))
  const today = LEGACY.dublinTodayLegacyDublin()
  vi.useRealTimers()
  return today
}
const pushedFor = () => sendCustomerPush.mock.calls.map(([, contactId, p]) => `${contactId}:${p.data.reminder_offset}`).sort()

// The waitlist round: honours .gte('race.race_date', floor) on the claimed read.
function waitlistDb({ race, claimedRows = [] }) {
  const rows = [{ id: 'wl1', race_event_id: race.id, location_id: race.location_id, contact_id: 'c1', email: 'ann@example.test', status: 'waiting', last_offered_at: null, offer_count: 0 }]
  return fakeDb((q) => {
    const claimedRead = q.ops.some((o) => o[0] === 'eq' && o[1] === 'status' && o[2] === 'claimed')
    if (q.table === 'event_waitlist' && q.action === 'select') {
      if (!claimedRead) return { data: rows, error: null }
      const floor = q.ops.find((o) => o[0] === 'gte' && o[1] === 'race.race_date')[2]
      return { data: claimedRows.filter((r) => r.race.race_date >= floor), error: null }
    }
    if (q.table === 'event_waitlist' && q.action === 'update') return { data: rows.map((r) => ({ id: r.id })), error: null }
    if (q.table === 'race_events') return { data: [race], error: null }
    if (q.table === 'race_registrations') return { data: [], error: null }
    return { data: null, error: null }
  })
}
const writesOf = (db) => db.queries.filter((q) => q.action !== 'select').map((q) => ({ table: q.table, action: q.action, payload: q.payload, ops: q.ops }))

// listMoveTargets: the entry read, then the targets read honouring .gte('race_date').
function moveDb({ events, source }) {
  const registration = {
    id: 'r1', status: 'confirmed', race_event_id: source.id, wave_id: null, team_id: 't1', contact_id: 'c1',
    teams: { id: 't1', size: 1, team_members: [{ id: 'm1', name: 'A', role: 'captain', is_member: false }] }, race: source,
  }
  return fakeDb((q) => {
    if (q.table === 'race_registrations' && q.ops.some((o) => o[0] === 'eq' && o[1] === 'id')) return { data: registration, error: null }
    if (q.table === 'race_events') {
      const floor = q.ops.find((o) => o[0] === 'gte' && o[1] === 'race_date')[2]
      return { data: events.filter((e) => e.race_date >= floor), error: null }
    }
    return { data: [], error: null }
  })
}

// Whole-year loops: seconds of work each, so a loaded CI shard needs more than
// vitest's 5 s default (TZ.6 PR: one timed out at ~7 s on shard 3).
const YEAR_LOOP_TIMEOUT = 30_000

describe('TZ.9 Europe/Dublin is byte-identical', () => {
  it.each(SAMPLES)('shared/events today, the event day and the move rule at %s', async (iso) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
    const legacyToday = LEGACY.todayIsoDublinLegacyDublin()
    expect(todayIsoIn(DUB)).toBe(legacyToday)
    expect(todayIsoIn(DUB, Date.parse(iso))).toBe(legacyToday)
    expect(todayIsoDublin()).toBe(legacyToday)
    expect(LEGACY.dublinTodayLegacyDublin()).toBe(legacyToday)
    const ev = { locations: loc(DUB) }
    expect(eventToday(ev)).toBe(legacyToday)
    expect(eventToday({ locations: null })).toBe(legacyToday) // no location row: Dublin, as before
    expect(eventToday({})).toBe(legacyToday)

    // evaluateMove: the target-date rule with no `today` passed = the old default.
    const base = {
      registration: { id: 'r1', status: 'confirmed', race_event_id: 'e1', teams: { size: 1, team_members: [{}] } },
      sourceEvent: { id: 'e1', location_id: 'L-dub', host_id: null },
      targetWave: null, targetWaveRegistrations: [], checkinCount: 0, existingOnTarget: null,
    }
    for (const n of [-2, -1, 0, 1, 2]) {
      const targetEvent = { id: 'e2', active: true, status: 'published', location_id: 'L-dub', host_id: null, race_date: addDays(iso.slice(0, 10), n), locations: loc(DUB) }
      expect(evaluateMove({ ...base, targetEvent })).toStrictEqual(evaluateMove({ ...base, targetEvent, today: legacyToday }))
    }
  })

  it.each(SAMPLES)('orderEventsForBrowse with a per-event today = the old single Dublin today (%s)', (iso) => {
    const now = Date.parse(iso)
    const legacyToday = legacyTodayAt(now)
    const day = iso.slice(0, 10)
    const events = [-2, -1, 0, 1, 2].map((n, i) => ({ id: `e${i}`, race_date: addDays(day, n), locations: loc(DUB) })).concat([{ id: 'nodate', race_date: null }])
    expect(orderEventsForBrowse(events, (e) => eventToday(e, now))).toStrictEqual(orderEventsForBrowse(events, legacyToday))
  })

  it('every hour of 2026: todayIsoIn(Dublin) and earliestLocalToday', () => {
    for (const t of HOURS_2026) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(t))
      const legacy = LEGACY.todayIsoDublinLegacyDublin()
      expect(todayIsoIn(DUB, t)).toBe(legacy)
      // The query floor is never after the Dublin day (or any zone's day).
      expect(earliestLocalToday(t) <= legacy).toBe(true)
      expect(earliestLocalToday(t) <= todayIsoIn(NY, t)).toBe(true)
      expect(earliestLocalToday(t) <= todayIsoIn('Pacific/Pago_Pago', t)).toBe(true)
      vi.useRealTimers()
    }
  }, YEAR_LOOP_TIMEOUT)

  it('event date labels (reminders, waitlist, race confirmations): every day of 2026', () => {
    for (const d of DAYS_2026) {
      expect(eventDateLong(d)).toBe(LEGACY.eventDateLongLegacyDublin(d))
      for (const reg of [{ wave: { start_time: '09:30:00' } }, {}]) {
        for (const ev of [{ race_date: d, start_time: '18:00:00' }, { race_date: d }]) {
          expect(reminderTimeLabel(reg, ev)).toBe(LEGACY.reminderTimeLabelLegacyDublin(reg, ev))
        }
      }
    }
    for (const d of [null, '', undefined, 'not-a-date']) {
      expect(eventDateLong(d)).toBe(LEGACY.eventDateLongLegacyDublin(d))
      expect(reminderTimeLabel({}, { race_date: d, start_time: '09:00' })).toBe(LEGACY.reminderTimeLabelLegacyDublin({}, { race_date: d, start_time: '09:00' }))
    }
  })

  it('public-events toBrowseCard: the "Opens" badge at every hour of 2026', () => {
    for (const t of HOURS_2026) {
      const e = { slug: 's', name: 'N', kind: 'race', race_date: '2026-12-01', registration_opens_at: new Date(t).toISOString(), waves: [] }
      const now = t - 1
      expect(toBrowseCard(e, { now, zone: DUB })).toStrictEqual(LEGACY.toBrowseCardLegacyDublin(e, { now }))
      expect(toBrowseCard(e, { now })).toStrictEqual(LEGACY.toBrowseCardLegacyDublin(e, { now }))
    }
    const closed = { slug: 's', name: 'N', race_date: '2026-12-01', registration_closes_at: '2026-01-01T00:00:00Z' }
    expect(toBrowseCard(closed, { soldOut: true, now: Date.UTC(2026, 5, 1), zone: DUB })).toStrictEqual(LEGACY.toBrowseCardLegacyDublin(closed, { soldOut: true, now: Date.UTC(2026, 5, 1) }))
  }, YEAR_LOOP_TIMEOUT)

  it('host-schedule-time: every quarter hour of 2026, both directions', () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 15 * 60_000) {
      const inputs = HST.isoToZonedInputs(t, DUB)
      expect(inputs).toStrictEqual(LEGACY.isoToDublinInputsLegacyDublin(t))
      expect(HST.zonedLocalToIso(inputs.date, inputs.time, DUB)).toBe(LEGACY.dublinLocalToIsoLegacyDublin(inputs.date, inputs.time))
      expect(HST.scheduleLabelIn(t, DUB)).toBe(LEGACY.dublinScheduleLabelLegacyDublin(t))
      expect(HST.nextQuarterHour(t, DUB)).toStrictEqual(LEGACY.nextQuarterHourLegacyDublin(t))
    }
    // Every wall clock of the two DST days, gap and overlap included.
    for (const date of ['2026-03-29', '2026-10-25', '2026-02-30', '2026-13-01']) {
      for (let m = 0; m < 24 * 60; m += 5) {
        const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
        expect(HST.zonedLocalToIso(date, time, DUB)).toBe(LEGACY.dublinLocalToIsoLegacyDublin(date, time))
      }
    }
    for (const bad of [null, '', 'garbage', Number.NaN]) {
      expect(HST.isoToZonedInputs(bad, DUB)).toBe(LEGACY.isoToDublinInputsLegacyDublin(bad))
      expect(HST.scheduleLabelIn(bad, DUB)).toBe(LEGACY.dublinScheduleLabelLegacyDublin(bad))
    }
    // The deprecated Dublin names still answer exactly as before (HostEmailReport, TZ.16's).
    expect(HST.dublinScheduleLabel(Date.UTC(2026, 6, 1, 8))).toBe(LEGACY.dublinScheduleLabelLegacyDublin(Date.UTC(2026, 6, 1, 8)))
    expect(HST.scheduleZoneLabel(DUB)).toBe('Dublin')
  }, YEAR_LOOP_TIMEOUT)

  it('hyrox mapping and the class time label: every hour of 2026', () => {
    for (const t of HOURS_2026) {
      const iso = new Date(t).toISOString()
      expect(zonedDateStr(iso, DUB)).toBe(LEGACY.dublinDateStrLegacyDublin(iso))
      expect(weekNoFor('2026-01-05', iso, 52, DUB)).toBe(LEGACY.weekNoForLegacyDublin('2026-01-05', iso, 52))
      expect(weekNoFor('2026-01-05', iso, 52)).toBe(LEGACY.weekNoForLegacyDublin('2026-01-05', iso, 52))
      expect(slotFor([3, 7], iso, DUB)).toBe(LEGACY.slotForLegacyDublin([3, 7], iso))
      expect(slotFor([3, 7], iso)).toBe(LEGACY.slotForLegacyDublin([3, 7], iso))
      expect(hyroxClassTimeLabel(iso, DUB)).toBe(LEGACY.hyroxClassTimeLabelLegacyDublin(iso))
    }
    expect(zonedDateStr('garbage', DUB)).toBe(LEGACY.dublinDateStrLegacyDublin('garbage'))
  }, YEAR_LOOP_TIMEOUT)

  it.each(SAMPLES)('event reminders: same events, same offsets as the Dublin-today run (%s)', async (iso) => {
    const now = Date.parse(iso)
    const legacyToday = legacyTodayAt(now)
    const events = [-1, 0, 1, 2, 3, 4, 5].map((n) => ({
      id: `e${n}`, name: `Event ${n}`, race_date: addDays(iso.slice(0, 10), n), start_time: '09:00:00',
      location_id: 'L-dub', kind: 'race', active: true, locations: loc(DUB),
    }))
    const zoned = await runEventReminders({ db: remindersDb(events), nowMs: now })
    const zonedPushes = pushedFor()
    sendCustomerPush.mockClear()
    const legacy = await runEventReminders({ db: remindersDb(events), todayStr: legacyToday })
    expect(zoned).toStrictEqual(legacy)
    expect(zonedPushes).toStrictEqual(pushedFor())
  })

  it.each(SAMPLES)('the waitlist round: same expiries and writes as the Dublin-today run (%s)', async (iso) => {
    const now = Date.parse(iso)
    const legacyToday = legacyTodayAt(now)
    for (const n of [-2, -1, 0, 1]) {
      const race = { id: 'e1', race_date: addDays(iso.slice(0, 10), n), active: false, status: 'published', location_id: 'L-dub', locations: loc(DUB), waves: [] }
      const claimedRows = [-3, -1, 0, 2].map((k) => ({ id: `cl${k}`, race_event_id: 'e1', status: 'claimed', race: { race_date: addDays(legacyToday, k) }, registration: { id: 'rg', status: 'confirmed', race_event_id: 'e1' } }))
      const a = waitlistDb({ race, claimedRows })
      const b = waitlistDb({ race, claimedRows })
      expect(await runWaitlistOffers(a, { now })).toStrictEqual(await runWaitlistOffers(b, { now, todayStr: legacyToday }))
      expect(writesOf(a)).toStrictEqual(writesOf(b))
    }
  })

  it.each(SAMPLES)('listMoveTargets: the same targets as the Dublin-today run (%s)', async (iso) => {
    const now = Date.parse(iso)
    const legacyToday = legacyTodayAt(now)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
    const source = { id: 'src', race_date: '2026-01-01', location_id: 'L-dub', host_id: null, locations: loc(DUB) }
    const events = [-3, -2, -1, 0, 1, 2].map((n) => ({ id: `t${n}`, name: `T${n}`, race_date: addDays(legacyToday, n), location_id: 'L-dub', host_id: null, active: true, status: 'published', waves: [], locations: loc(DUB) }))
    const zoned = await listMoveTargets(moveDb({ events, source }), { registrationId: 'r1' })
    const legacy = await listMoveTargets(moveDb({ events, source }), { registrationId: 'r1', today: legacyToday })
    expect(zoned).toStrictEqual(legacy)
  })

  it('hyrox expand + reminder runners: Dublin blocks get the old day and label', async () => {
    const nowMs = Date.parse('2026-03-29T00:30:00Z') // Dublin 00:30 GMT, the night clocks go forward
    const block = { id: 'b1', location_id: 'L-dub', starts_on: '2026-03-02', weeks: 8, sessions_per_week: 2, session_weekdays: [7], locations: loc(DUB) }
    const db = { from: () => { const b = { select: () => b, eq: () => b, then: (r) => r({ data: [block], error: null }) }; return b } }
    await runExpandHyroxWeeks(db, { nowMs })
    expect(weeksNeedingExpansion.mock.calls[0][2]).toBe(LEGACY.hyroxExpandTodayLegacyDublin(nowMs))
  })
})

describe('TZ.9 America/New_York follows New York across DST', () => {
  it('shared/events: the day flips at New York midnight, not Dublin midnight', () => {
    // 2026-11-01T03:30Z: Dublin is already Sunday 1 Nov; New York is Saturday 31 Oct 23:30 EDT.
    expect(todayIsoIn(NY, Date.parse('2026-11-01T03:30:00Z'))).toBe('2026-10-31')
    expect(todayIsoIn(DUB, Date.parse('2026-11-01T03:30:00Z'))).toBe('2026-11-01')
    // Fall back: 04:59Z is 00:59 EDT, 05:00Z is 01:00 EDT, 06:00Z is 01:00 EST: all Sunday.
    for (const iso of ['2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z']) {
      expect(todayIsoIn(NY, Date.parse(iso))).toBe('2026-11-01')
    }
    // Spring forward: 04:30Z on 7 Mar is Friday 23:30 EST; 07:00Z on 8 Mar is 03:00 EDT Sunday.
    expect(todayIsoIn(NY, Date.parse('2026-03-07T04:30:00Z'))).toBe('2026-03-06')
    expect(todayIsoIn(NY, Date.parse('2026-03-08T07:00:00Z'))).toBe('2026-03-08')
    expect(eventZone({ locations: loc(NY) })).toBe(NY)
  })

  it('a race on 31 Oct is still upcoming in New York at 03:30Z on 1 Nov, past in Dublin', () => {
    const now = Date.parse('2026-11-01T03:30:00Z')
    const ny = { id: 'ny', race_date: '2026-10-31', locations: loc(NY) }
    const dub = { id: 'dub', race_date: '2026-10-31', locations: loc(DUB) }
    const { upcoming, past } = orderEventsForBrowse([ny, dub], (e) => eventToday(e, now))
    expect(upcoming.map((e) => e.id)).toEqual(['ny'])
    expect(past.map((e) => e.id)).toEqual(['dub'])
  })

  it('a 09:00 race on 2026-11-01 in New York starts at 14:00Z (EST), on 2026-07-01 at 13:00Z (EDT)', async () => {
    const { zonedWallClockToInstant } = await import('./location-time.js')
    expect(new Date(zonedWallClockToInstant('2026-11-01', '09:00', eventZone({ locations: loc(NY) }))).toISOString()).toBe('2026-11-01T14:00:00.000Z')
    expect(new Date(zonedWallClockToInstant('2026-07-01', '09:00', eventZone({ locations: loc(NY) }))).toISOString()).toBe('2026-07-01T13:00:00.000Z')
  })

  it('the move rule: a NY target dated NY-today is still open at 03:30Z on 1 Nov', () => {
    const base = {
      registration: { id: 'r1', status: 'confirmed', race_event_id: 'e1', teams: { size: 1, team_members: [{}] } },
      sourceEvent: { id: 'e1', location_id: 'L-ny', host_id: null },
      targetWave: null, targetWaveRegistrations: [], checkinCount: 0, existingOnTarget: null,
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T03:30:00Z'))
    const target = (zone) => ({ id: 'e2', active: true, status: 'published', location_id: 'L', host_id: null, race_date: '2026-10-31', locations: loc(zone) })
    expect(evaluateMove({ ...base, targetEvent: target(NY) })).toStrictEqual({ ok: true })
    expect(evaluateMove({ ...base, targetEvent: target(DUB) })).toStrictEqual({ ok: false, error: 'target_unavailable' })
  })

  it('the move-options list is by each target studio\'s day (cross-studio list)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T03:30:00Z'))
    const source = { id: 'src', race_date: '2026-10-01', location_id: 'L-ny', host_id: null, locations: loc(NY) }
    const events = [
      { id: 'ny-sat', name: 'NY Sat', race_date: '2026-10-31', location_id: 'L-ny', host_id: null, active: true, status: 'published', waves: [], locations: loc(NY) },
      { id: 'dub-sat', name: 'Dub Sat', race_date: '2026-10-31', location_id: 'L-dub', host_id: null, active: true, status: 'published', waves: [], locations: loc(DUB) },
      { id: 'ny-fri', name: 'NY Fri', race_date: '2026-10-30', location_id: 'L-ny', host_id: null, active: true, status: 'published', waves: [], locations: loc(NY) },
    ]
    const r = await listMoveTargets(moveDb({ events, source }), { registrationId: 'r1' })
    expect(r.targets.map((t) => t.id)).toEqual(['ny-sat'])
  })

  it('event reminders: a NY event is reminded by New York\'s day', async () => {
    // 2026-10-29T02:00Z: Dublin Thu 29 Oct, New York Wed 28 Oct 22:00 EDT.
    const now = Date.parse('2026-10-29T02:00:00Z')
    const events = [
      { id: 'ny1', name: 'NY 1d', race_date: '2026-10-29', start_time: '09:00:00', location_id: 'L-ny', kind: 'race', active: true, locations: loc(NY) },
      { id: 'ny3', name: 'NY 3d', race_date: '2026-10-31', start_time: '09:00:00', location_id: 'L-ny', kind: 'race', active: true, locations: loc(NY) },
      { id: 'dub1', name: 'Dub 1d', race_date: '2026-10-30', start_time: '09:00:00', location_id: 'L-dub', kind: 'race', active: true, locations: loc(DUB) },
      { id: 'nyx', name: 'NY not today', race_date: '2026-10-30', start_time: '09:00:00', location_id: 'L-ny', kind: 'race', active: true, locations: loc(NY) },
    ]
    const res = await runEventReminders({ db: remindersDb(events), nowMs: now })
    expect(res.events).toBe(3)
    expect(pushedFor()).toEqual(['c-dub1:1d', 'c-ny1:1d', 'c-ny3:3d'])
  })

  it('the event date label is the stored day in New York too (a calendar date has no zone)', () => {
    expect(eventDateLong('2026-11-01')).toBe(eventDateLong('2026-11-01'))
    expect(eventDateLong('2026-11-01')).toMatch(/^Sunday,? 1 November 2026$/)
    expect(reminderTimeLabel({ wave: { start_time: '09:00:00' } }, { race_date: '2026-03-08' })).toMatch(/^Sunday,? 8 March 2026 · 09:00$/)
  })

  it('the waitlist: a NY event dated 31 Oct is not expired at 03:30Z on 1 Nov; a Dublin one is', async () => {
    const now = Date.parse('2026-11-01T03:30:00Z')
    const nyRace = { id: 'e1', race_date: '2026-10-31', active: false, status: 'published', location_id: 'L-ny', locations: loc(NY), waves: [] }
    const ny = await runWaitlistOffers(waitlistDb({ race: nyRace }), { now })
    expect(ny.expired).toBe(0)
    const dub = await runWaitlistOffers(waitlistDb({ race: { ...nyRace, location_id: 'L-dub', locations: loc(DUB) } }), { now })
    expect(dub.expired).toBe(1)
  })

  it('public-events: "Opens" names New York\'s date', () => {
    // 2026-11-01T02:00Z is 31 Oct 22:00 EDT.
    const e = { slug: 's', name: 'N', race_date: '2026-12-01', registration_opens_at: '2026-11-01T02:00:00Z', waves: [] }
    expect(toBrowseCard(e, { now: Date.parse('2026-10-01T00:00:00Z'), zone: NY }).badge).toBe('Opens 31 Oct')
    expect(toBrowseCard(e, { now: Date.parse('2026-10-01T00:00:00Z'), zone: DUB }).badge).toBe('Opens 1 Nov')
  })

  it('host-schedule-time: a New York host picks New York wall clock, across both DST edges', () => {
    expect(HST.zonedLocalToIso('2026-11-01', '09:00', NY)).toBe('2026-11-01T14:00:00.000Z')
    expect(HST.zonedLocalToIso('2026-07-01', '09:00', NY)).toBe('2026-07-01T13:00:00.000Z')
    // Spring-forward gap (02:30 does not exist on 8 Mar in New York): refused, as Dublin's gap is.
    expect(HST.zonedLocalToIso('2026-03-08', '02:30', NY)).toBeNull()
    expect(HST.isoToZonedInputs('2026-11-01T06:15:00Z', NY)).toStrictEqual({ date: '2026-11-01', time: '01:15' })
    expect(HST.scheduleLabelIn('2026-11-01T14:00:00Z', NY)).toBe('Sun 1 Nov, 09:00')
    expect(HST.nextQuarterHour(Date.parse('2026-11-01T03:50:00Z'), NY)).toStrictEqual({ date: '2026-11-01', time: '00:15' })
    expect(HST.scheduleZoneLabel(NY)).toBe('New York')
    expect(HST.scheduleZoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
  })

  it('hyrox: the session day is the block studio\'s; a class on Sun 23:30 EST is Sunday, not Monday', () => {
    const iso = '2026-11-02T04:30:00Z' // Sun 1 Nov 23:30 EST; Dublin: Mon 2 Nov 04:30
    expect(zonedDateStr(iso, NY)).toBe('2026-11-01')
    expect(slotFor([3, 7], iso, NY)).toBe(2) // Sunday = 7
    expect(slotFor([3, 7], iso, DUB)).toBe(null) // Monday
    expect(weekNoFor('2026-10-26', iso, 8, NY)).toBe(1)
    expect(weekNoFor('2026-10-26', iso, 8, DUB)).toBe(2)
    expect(hyroxClassTimeLabel('2026-11-01T14:00:00Z', NY)).toBe('09:00')
    expect(hyroxClassTimeLabel('2026-07-01T13:00:00Z', NY)).toBe('09:00')
    const block = { starts_on: '2026-10-26', weeks: 8, session_weekdays: [3, 7] }
    const sessions = [{ week_no: 1, slot: 2, id: 's-ny', status: 'approved' }, { week_no: 2, slot: 1, id: 's-other', status: 'approved' }]
    expect(pickSessionForOccurrence(block, sessions, iso, NY)?.id).toBe('s-ny')
  })

  it('hyrox expand runner: "today" is each block\'s own studio day', async () => {
    const nowMs = Date.parse('2026-11-01T03:30:00Z') // Dublin Sun 1 Nov; New York Sat 31 Oct
    const blocks = [
      { id: 'b-ny', location_id: 'L-ny', starts_on: '2026-10-26', weeks: 8, sessions_per_week: 2, locations: loc(NY) },
      { id: 'b-dub', location_id: 'L-dub', starts_on: '2026-10-26', weeks: 8, sessions_per_week: 2, locations: loc(DUB) },
    ]
    const db = { from: () => { const b = { select: () => b, eq: () => b, then: (r) => r({ data: blocks, error: null }) }; return b } }
    await runExpandHyroxWeeks(db, { nowMs })
    expect(weeksNeedingExpansion.mock.calls.map((c) => [c[0].id, c[2]])).toEqual([['b-ny', '2026-10-31'], ['b-dub', '2026-11-01']])
  })

  it('hyrox reminder: the coach push names the class time in the block studio\'s zone', async () => {
    const nowMs = Date.parse('2026-11-01T13:40:00Z')
    const block = { id: 'b-ny', location_id: 'L-ny', starts_on: '2026-10-26', weeks: 8, session_weekdays: [], locations: loc(NY) }
    const occ = { name: 'HYROX Engine', starts_at: '2026-11-01T14:00:00.000Z', ends_at: '2026-11-01T15:00:00.000Z' }
    const thenable = (v) => ({ then: (r, j) => Promise.resolve(v).then(r, j) })
    const chain = (v) => { const b = { then: (r, j) => Promise.resolve(v).then(r, j) }; for (const m of ['select', 'eq', 'is', 'gte', 'lte', 'order']) b[m] = () => b; b.maybeSingle = () => thenable({ data: null, error: null }); return b }
    const db = {
      rpc: async () => ({ data: [{ profile_id: 'p1' }], error: null }),
      from(table) {
        if (table === 'hyrox_blocks') return chain({ data: [block], error: null })
        if (table === 'class_occurrences') return chain({ data: [occ], error: null })
        if (table === 'hyrox_class_reminders') {
          return {
            select: () => { const q = { eq: () => q, maybeSingle: () => thenable({ data: null, error: null }) }; return q },
            upsert: () => ({ select: () => thenable({ data: [{ id: 'rem-1' }], error: null }) }),
            update: () => ({ eq: () => thenable({ error: null }) }),
          }
        }
        return chain({ data: null, error: null })
      },
    }
    await runHyroxClassReminder(db, { nowMs })
    expect(sendPush.mock.calls[0][1].body).toBe('Review the workout for your 09:00 Hyrox class.')
  })
})
