// handler.tz.test.js — TZ.5. The Flow's class slot times are the studio's own
// clock; a day title is the date itself. Europe/Dublin is byte-identical to the
// frozen pre-change labels; a failed zone read still answers, on DEFAULT_TZ.
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/booking-slots.js', () => ({ computeAvailableDays: vi.fn(), computeAvailableSlots: vi.fn() }))
vi.mock('@/lib/public-classes.js', () => ({
  listPublicClasses: vi.fn(async () => ([
    { event_id: 'c1', name: 'HIIT', starts_at: '2026-07-01T23:30:00Z' },
    { event_id: 'c2', name: 'Row', starts_at: '2026-11-01T06:30:00Z' },
  ])),
}))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logWarn: vi.fn() }))

const { handleDataExchange, dayLabel, timeLabel } = await import('./handler.js')
const { SCREEN } = await import('./screens.js')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { logWarn } = await import('@/lib/log')
const LEGACY = await import('../agent/agent-zone.legacy-dublin.test-helpers.js')

const H = 3600_000
const ms = (iso) => Date.parse(iso)

function zoneDb(answer) {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => answer }
  return { from: () => chain }
}
const slotTitles = async (db, day) => (await handleDataExchange(db, {
  decryptedBody: { action: 'data_exchange', screen: SCREEN.DAY, data: { path: 'class', day } },
  contact: null, locationId: 'loc-x', config: {},
})).data.slots.map((s) => s.title)

beforeEach(() => { resetLocationZoneCache(); vi.clearAllMocks() })

describe('TZ.5 Europe/Dublin is byte-identical', () => {
  it('dayLabel: every calendar day of 2026', () => {
    for (let t = ms('2026-01-01T12:00:00Z'); t < ms('2027-01-01T00:00:00Z'); t += 24 * H) {
      const d = new Date(t).toISOString().slice(0, 10)
      expect(dayLabel(d)).toBe(LEGACY.flowDayLabelLegacyDublin(d))
    }
  })
  it('timeLabel: every hour of 2026 (and the DST minutes)', () => {
    const extra = ['2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z']
    for (let t = ms('2026-01-01T00:00:00Z'); t < ms('2027-01-01T00:00:00Z'); t += H) {
      const iso = new Date(t).toISOString()
      expect(timeLabel(iso, 'Europe/Dublin')).toBe(LEGACY.flowTimeLabelLegacyDublin(iso))
    }
    for (const iso of extra) expect(timeLabel(iso, 'Europe/Dublin')).toBe(LEGACY.flowTimeLabelLegacyDublin(iso))
  })
  it('a Dublin (or NULL) location shows the old slot titles', async () => {
    expect(await slotTitles(zoneDb({ data: { id: 'loc-x', timezone: 'Europe/Dublin' }, error: null }), '2026-07-01')).toEqual(['00:30 HIIT'])
    resetLocationZoneCache()
    expect(await slotTitles(zoneDb({ data: { id: 'loc-x', timezone: null }, error: null }), '2026-07-01')).toEqual(['00:30 HIIT'])
  })
})

describe('TZ.5 America/New_York follows New York across DST', () => {
  it('slot times are New York wall clock (EDT in summer, EST after the fall-back)', async () => {
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
    expect(await slotTitles(db, '2026-07-01')).toEqual(['00:30 HIIT'])
    expect(logWarn).toHaveBeenCalledWith('whatsapp-flow', expect.stringMatching(/zone unreadable/), expect.objectContaining({ locationId: 'loc-x' }))
  })
})
