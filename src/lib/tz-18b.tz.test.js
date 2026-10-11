// tz-18b.tz.test.js — TZ.18b. The last files on the Dublin-zone baseline.
//
//   • class-occurrences isTrainerLookupTick: an ops throttle on ONE shared
//     Glofox lookup, so it stays on the platform clock (PLATFORM_TZ). It must
//     still fire at 04:00-04:14 Europe/Dublin, every day of 2026 (byte-identical),
//     whatever the host zone.
//   • event-move-card: a DATE column is a calendar date, not an instant. It is
//     now formatted in UTC (anchored noon UTC), which is the same text the old
//     Europe/Dublin formatter gave for every day of 2026, on any host zone.
//   • agent-followups' checkins_day key (the platform-wide heartbeat row) is
//     pinned in its route test.
process.env.TZ = 'America/New_York' // host zone is not Dublin: nothing may read the host clock
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { isTrainerLookupTick, TRAINER_LOOKUP_DUBLIN_HOUR } = await import('./class-occurrences.js')
const { eventMoveSummary } = await import('./approvals/event-move-card.js')

const D = 'Europe/Dublin'
const dublinHM = new Intl.DateTimeFormat('en-GB', { timeZone: D, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

describe('TZ.18b isTrainerLookupTick stays on the platform clock (Europe/Dublin 04:00-04:14)', () => {
  it('every 5 minutes of 2026: true exactly when Dublin reads 04:00-04:14', () => {
    const diffs = []
    let ticks = 0
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 5 * 60_000) {
      const [h, m] = dublinHM.format(new Date(t)).split(':').map(Number)
      const want = h === TRAINER_LOOKUP_DUBLIN_HOUR && m < 15
      if (want) ticks++
      if (isTrainerLookupTick(t) !== want) diffs.push(new Date(t).toISOString())
    }
    expect(diffs).toEqual([])
    expect(ticks).toBe(365 * 3) // three 5-minute marks a day, both DST days included
  })

  it('pinned across both 2026 EU clock changes', () => {
    expect(isTrainerLookupTick(Date.parse('2026-03-29T03:00:00Z'))).toBe(true) // 04:00 IST, spring-forward day
    expect(isTrainerLookupTick(Date.parse('2026-03-29T04:00:00Z'))).toBe(false) // 05:00 IST
    expect(isTrainerLookupTick(Date.parse('2026-10-25T04:14:00Z'))).toBe(true) // 04:14 GMT, fall-back day
    expect(isTrainerLookupTick(Date.parse('2026-10-25T03:00:00Z'))).toBe(false) // 03:00 GMT
    expect(isTrainerLookupTick(Date.parse('2026-07-01T03:15:00Z'))).toBe(false) // 04:15 IST
    expect(isTrainerLookupTick(NaN)).toBe(false)
  })

  it('ignores New York: 04:00 New York (09:00 Dublin in winter) is not the tick', () => {
    expect(isTrainerLookupTick(Date.parse('2026-01-15T09:00:00Z'))).toBe(false)
    expect(isTrainerLookupTick(Date.parse('2026-01-15T04:05:00Z'))).toBe(true)
  })
})

describe('TZ.18b event-move-card dates are calendar dates (zone-free)', () => {
  const dublinShort = new Intl.DateTimeFormat('en-IE', { timeZone: D, weekday: 'short', day: 'numeric', month: 'short' })
  const old = (iso) => {
    const p = {}
    for (const x of dublinShort.formatToParts(new Date(`${iso}T12:00:00Z`))) p[x.type] = x.value
    return `${p.weekday} ${p.day} ${p.month}`
  }

  it('every day of 2026 reads exactly as the old Europe/Dublin formatter did, on a New York host', () => {
    const diffs = []
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 24 * 3600_000) {
      const iso = new Date(t).toISOString().slice(0, 10)
      const got = eventMoveSummary({ source_event_name: 'A', source_event_date: iso })
      if (got !== `Move entry from A, ${old(iso)}`) diffs.push(`${iso}: ${got}`)
    }
    expect(diffs).toEqual([])
  })

  it('pinned: both 2026 clock-change Sundays (EU and US) and a timestamp-shaped value', () => {
    expect(eventMoveSummary({ source_event_date: '2026-03-29' })).toBe('Move entry from Sun 29 Mar')
    expect(eventMoveSummary({ source_event_date: '2026-10-25' })).toBe('Move entry from Sun 25 Oct')
    expect(eventMoveSummary({ source_event_date: '2026-03-08' })).toBe('Move entry from Sun 8 Mar')
    expect(eventMoveSummary({ source_event_date: '2026-11-01T23:30:00Z' })).toBe('Move entry from Sun 1 Nov')
    expect(eventMoveSummary({ source_event_date: 'nope' })).toBe('Move entry')
  })
})
