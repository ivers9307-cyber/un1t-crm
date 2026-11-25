import { describe, it, expect } from 'vitest'
import { snoozePresets, SNOOZE_MAX_DAYS, SNOOZE_NOTE_MAX } from './inbox-snooze.js'

const at = (iso, zone) => Object.fromEntries(snoozePresets(Date.parse(iso), zone).map((p) => [p.key, p.untilIso]))

describe('snoozePresets', () => {
  it('lists the four presets in order with their labels', () => {
    const list = snoozePresets(Date.parse('2026-11-25T12:00:00Z'), 'Europe/Dublin')
    expect(list.map((p) => [p.key, p.label])).toEqual([
      ['later', 'Later today'], ['tomorrow', 'Tomorrow 09:00'], ['three_days', 'In 3 days'], ['next_week', 'Next week'],
    ])
  })

  it('on a Wednesday in winter: +3h, 09:00 tomorrow, 09:00 in 3 days, next Monday 09:00', () => {
    expect(at('2026-11-25T12:00:00Z', 'Europe/Dublin')).toEqual({
      later: '2026-11-25T15:00:00.000Z',
      tomorrow: '2026-11-26T09:00:00.000Z',
      three_days: '2026-11-28T09:00:00.000Z',
      next_week: '2026-11-30T09:00:00.000Z',
    })
  })

  it('on a Sunday next week is the next day; on a Monday it is seven days ahead', () => {
    expect(at('2026-11-29T12:00:00Z', 'Europe/Dublin').next_week).toBe('2026-11-30T09:00:00.000Z')
    expect(at('2026-11-30T12:00:00Z', 'Europe/Dublin').next_week).toBe('2026-12-07T09:00:00.000Z')
  })

  it('on a Saturday next week is the next-but-one day', () => {
    expect(at('2026-11-28T12:00:00Z', 'Europe/Dublin').next_week).toBe('2026-11-30T09:00:00.000Z')
  })

  it('follows the studio clock across the spring-forward night (Dublin, 29 March 2026)', () => {
    // Saturday 28 Mar is still GMT; Sunday 29 Mar 09:00 is already BST (08:00Z).
    const r = at('2026-03-28T12:00:00Z', 'Europe/Dublin')
    expect(r.tomorrow).toBe('2026-03-29T08:00:00.000Z')
    expect(r.three_days).toBe('2026-03-31T08:00:00.000Z')
    expect(r.later).toBe('2026-03-28T15:00:00.000Z')
  })

  it('follows the studio clock across the autumn fall-back (Dublin, 25 October 2026)', () => {
    const r = at('2026-10-24T12:00:00Z', 'Europe/Dublin')
    expect(r.tomorrow).toBe('2026-10-25T09:00:00.000Z')
    expect(at('2026-10-23T12:00:00Z', 'Europe/Dublin').three_days).toBe('2026-10-26T09:00:00.000Z')
  })

  it('uses the given zone, not Dublin (New York across its fall-back, 1 November 2026)', () => {
    const r = at('2026-10-31T15:00:00Z', 'America/New_York')
    expect(r.tomorrow).toBe('2026-11-01T14:00:00.000Z') // 09:00 EST
    expect(r.later).toBe('2026-10-31T18:00:00.000Z')
  })

  it('uses the zone day, not the UTC day (Auckland is already on Thursday)', () => {
    const r = at('2026-11-25T23:00:00Z', 'Pacific/Auckland') // Thu 26 Nov 12:00 NZDT
    expect(r.tomorrow).toBe('2026-11-26T20:00:00.000Z') // Fri 27 Nov 09:00 NZDT
    expect(r.next_week).toBe('2026-11-29T20:00:00.000Z') // Mon 30 Nov 09:00 NZDT
  })

  it('later is an exact three hours, no rounding, even past 21:00', () => {
    expect(at('2026-11-25T20:17:30Z', 'Europe/Dublin').later).toBe('2026-11-25T23:17:30.000Z')
  })

  it('every preset is in the future', () => {
    const now = Date.parse('2026-11-25T23:59:59Z')
    for (const p of snoozePresets(now, 'Europe/Dublin')) expect(Date.parse(p.untilIso)).toBeGreaterThan(now)
  })
})

describe('limits', () => {
  it('exports the shared limits', () => {
    expect(SNOOZE_MAX_DAYS).toBe(90)
    expect(SNOOZE_NOTE_MAX).toBe(140)
  })
})
