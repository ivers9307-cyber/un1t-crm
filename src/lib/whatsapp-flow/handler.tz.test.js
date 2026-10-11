// handler.tz.test.js — TZ.5. The Flow's class slot times are the studio's own
// clock; a day title is the date itself; a failed zone read still answers, on
// DEFAULT_TZ. The Dublin byte-identity sweep ran in TZ.5 and was retired in
// TZ.18b: Europe/Dublin is pinned by fixed values below, and zoned-time ≡
// dublin-time stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/booking-slots.js', () => ({ computeAvailableDays: vi.fn(), computeAvailableSlots: vi.fn() }))
// TZ.17 — listPublicClasses' real shape carries `day`, the class's day on the
// studio's calendar (public-classes renders it in the studio zone); the test
// says which zone that is through globalThis.__flowZone (default Dublin).
vi.mock('@/lib/public-classes.js', async () => {
  const { dayStrIn } = await import('@shared/zoned-time')
  const raw = [
    { event_id: 'c1', name: 'HIIT', starts_at: '2026-07-01T23:30:00Z' },
    { event_id: 'c2', name: 'Row', starts_at: '2026-11-01T06:30:00Z' },
  ]
  return {
    listPublicClasses: vi.fn(async () => raw.map((c) => ({ ...c, day: dayStrIn(c.starts_at, globalThis.__flowZone || 'Europe/Dublin') }))),
  }
})
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logWarn: vi.fn() }))

const { handleDataExchange, dayLabel, timeLabel } = await import('./handler.js')
const { SCREEN } = await import('./screens.js')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { logWarn } = await import('@/lib/log')

function zoneDb(answer) {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => answer }
  return { from: () => chain }
}
const slotTitles = async (db, day) => (await handleDataExchange(db, {
  decryptedBody: { action: 'data_exchange', screen: SCREEN.DAY, data: { path: 'class', day } },
  contact: null, locationId: 'loc-x', config: {},
})).data.slots.map((s) => s.title)

beforeEach(() => { resetLocationZoneCache(); vi.clearAllMocks(); globalThis.__flowZone = 'Europe/Dublin' })

describe('TZ.5 Europe/Dublin pinned values', () => {
  it('dayLabel: the date itself, across both DST Sundays', () => {
    expect(dayLabel('2026-03-29')).toBe('Sun, 29 Mar')
    expect(dayLabel('2026-07-01')).toBe('Wed, 1 Jul')
    expect(dayLabel('2026-10-25')).toBe('Sun, 25 Oct')
    expect(dayLabel('2026-12-31')).toBe('Thu, 31 Dec')
  })
  it('timeLabel: Dublin wall clock either side of both DST changes (zone omitted = Dublin)', () => {
    expect(timeLabel('2026-03-29T00:59:00Z', 'Europe/Dublin')).toBe('00:59') // GMT
    expect(timeLabel('2026-03-29T01:00:00Z', 'Europe/Dublin')).toBe('02:00') // IST
    expect(timeLabel('2026-07-01T23:30:00Z', 'Europe/Dublin')).toBe('00:30')
    expect(timeLabel('2026-10-25T00:59:00Z', 'Europe/Dublin')).toBe('01:59') // IST
    expect(timeLabel('2026-10-25T01:00:00Z', 'Europe/Dublin')).toBe('01:00') // GMT
    expect(timeLabel('2026-12-31T23:30:00Z', 'Europe/Dublin')).toBe('23:30')
    expect(timeLabel('2026-07-01T23:30:00Z')).toBe('00:30')
  })
  it('a Dublin (or NULL) location shows the old slot titles', async () => {
    expect(await slotTitles(zoneDb({ data: { id: 'loc-x', timezone: 'Europe/Dublin' }, error: null }), '2026-07-02')).toEqual(['00:30 HIIT'])
    resetLocationZoneCache()
    expect(await slotTitles(zoneDb({ data: { id: 'loc-x', timezone: null }, error: null }), '2026-07-02')).toEqual(['00:30 HIIT'])
  })
  // TZ.17 ⚠️ — the 00:30 IST class is a 2 Jul class: it used to be grouped and
  // filtered under its UTC day (1 Jul), so a member picking 1 Jul was offered
  // a class that runs after midnight on 2 Jul, and picking 2 Jul did not show it.
  it('TZ.17: a 00:30 IST class sits under its Dublin day, not the UTC day before', async () => {
    const db = zoneDb({ data: { id: 'loc-x', timezone: 'Europe/Dublin' }, error: null })
    expect(await slotTitles(db, '2026-07-01')).toEqual([])
    const init = await handleDataExchange(db, { decryptedBody: { action: 'INIT' }, contact: null, locationId: 'loc-x', config: {} })
    expect(init.data.days.map((d) => d.id)).toEqual(['2026-07-02', '2026-11-01'])
  })
})

describe('TZ.5 America/New_York follows New York across DST', () => {
  it('slot times are New York wall clock (EDT in summer, EST after the fall-back)', async () => {
    globalThis.__flowZone = 'America/New_York'
    const db = zoneDb({ data: { id: 'loc-x', timezone: 'America/New_York' }, error: null })
    expect(await slotTitles(db, '2026-07-01')).toEqual(['19:30 HIIT'])
    expect(await slotTitles(db, '2026-11-01')).toEqual(['01:30 Row'])
    expect(timeLabel('2026-11-01T05:30:00Z', 'America/New_York')).toBe('01:30') // 01:30 EDT, before the fall-back
    expect(timeLabel('2026-03-08T07:30:00Z', 'America/New_York')).toBe('03:30') // after the spring-forward
  })
  it('a day title is the date itself in any zone', () => {
    expect(dayLabel('2026-11-01')).toBe('Sun, 1 Nov')
    expect(dayLabel('2026-03-08')).toBe('Sun, 8 Mar')
  })
  it('a failed zone read still answers the customer: DEFAULT_TZ, with a warning', async () => {
    const db = zoneDb({ data: null, error: { message: 'statement timeout', code: '57014' } })
    expect(await slotTitles(db, '2026-07-02')).toEqual(['00:30 HIIT'])
    expect(logWarn).toHaveBeenCalledWith('whatsapp-flow', expect.stringMatching(/zone unreadable/), expect.objectContaining({ locationId: 'loc-x' }))
  })
})
