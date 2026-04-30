import { describe, it, expect } from 'vitest'
import {
  getStaticHolidays, mergeHolidays, indexByDate,
  SUPPORTED_HOLIDAY_COUNTRIES, countryName,
} from './bank-holidays.js'

describe('getStaticHolidays', () => {
  it('returns the full static list when no range is given', () => {
    const all = getStaticHolidays()
    expect(all.length).toBe(60)  // 10 holidays × 6 years (2025-2030)
  })

  it('filters by inclusive start/end range', () => {
    const r = getStaticHolidays('2025-01-01', '2025-12-31')
    expect(r).toHaveLength(10)
    expect(r[0].date).toBe('2025-01-01')
    expect(r.at(-1).date).toBe('2025-12-26')
  })

  it('every entry is tagged source: national, country code, frozen', () => {
    for (const h of getStaticHolidays()) {
      expect(h.source).toBe('national')
      expect(h.country).toBe('IE')
      expect(Object.isFrozen(h)).toBe(true)
    }
  })

  it('returns an empty list for a country we do not have data for', () => {
    expect(getStaticHolidays(undefined, undefined, 'XX')).toEqual([])
  })

  it('defaults to IE when country is omitted', () => {
    const a = getStaticHolidays('2025-01-01', '2025-12-31')
    const b = getStaticHolidays('2025-01-01', '2025-12-31', 'IE')
    expect(a).toEqual(b)
  })

  it('covers the well-known 2025 dates', () => {
    const stPats = getStaticHolidays('2025-03-17', '2025-03-17')
    expect(stPats).toHaveLength(1)
    expect(stPats[0].name).toBe("St Patrick's Day")

    const xmas = getStaticHolidays('2025-12-25', '2025-12-26')
    expect(xmas.map(h => h.name)).toEqual(['Christmas Day', "St Stephen's Day"])
  })

  it('handles the St Brigids Day Feb-1-Friday rule for 2030', () => {
    const stBrigids2030 = getStaticHolidays('2030-02-01', '2030-02-01')
    expect(stBrigids2030).toHaveLength(1)
    expect(stBrigids2030[0].name).toBe("St Brigid's Day")
  })
})

describe('mergeHolidays', () => {
  it('returns just the static list when custom list is empty', () => {
    const r = mergeHolidays([], { start: '2025-01-01', end: '2025-12-31' })
    expect(r).toHaveLength(10)
    expect(r.every(h => h.source === 'national')).toBe(true)
  })

  it('adds a custom holiday on a non-statutory date', () => {
    const custom = [{ id: 'a', date: '2025-04-18', name: 'Good Friday (closed)', location_id: 'loc1' }]
    const r = mergeHolidays(custom, { start: '2025-04-01', end: '2025-04-30' })
    const gf = r.find(h => h.date === '2025-04-18')
    expect(gf).toBeDefined()
    expect(gf.source).toBe('custom')
    expect(gf.name).toBe('Good Friday (closed)')
  })

  it('overrides the static name when a custom entry shares the date', () => {
    const custom = [{ id: 'a', date: '2025-03-17', name: 'Closed all day', location_id: 'loc1' }]
    const r = mergeHolidays(custom)
    const stPats = r.find(h => h.date === '2025-03-17')
    expect(stPats.source).toBe('custom')
    expect(stPats.name).toBe('Closed all day')
  })

  it('returns sorted ascending by date', () => {
    const custom = [
      { id: 'a', date: '2025-04-18', name: 'Good Friday', location_id: 'loc1' },
      { id: 'b', date: '2025-12-24', name: 'Christmas Eve', location_id: 'loc1' },
    ]
    const r = mergeHolidays(custom, { start: '2025-01-01', end: '2025-12-31' })
    for (let i = 1; i < r.length; i++) {
      expect(r[i].date >= r[i - 1].date).toBe(true)
    }
  })

  it('respects start/end on custom entries', () => {
    const custom = [{ id: 'a', date: '2026-04-18', name: 'Good Friday', location_id: 'loc1' }]
    const r = mergeHolidays(custom, { start: '2025-01-01', end: '2025-12-31' })
    expect(r.find(h => h.id === 'a')).toBeUndefined()
  })

  it('handles null/undefined custom list', () => {
    expect(() => mergeHolidays(null)).not.toThrow()
    expect(() => mergeHolidays(undefined)).not.toThrow()
  })
})

describe('mergeHolidays — country selection', () => {
  it('passes the country through to the static lookup', () => {
    // No IE holidays for an XX country, but custom entries still come through.
    const custom = [{ id: 'a', date: '2025-04-18', name: 'Some Day', location_id: 'loc1' }]
    const r = mergeHolidays(custom, { country: 'XX' })
    expect(r).toHaveLength(1)
    expect(r[0].source).toBe('custom')
  })
})

describe('SUPPORTED_HOLIDAY_COUNTRIES', () => {
  it('lists every country we have static data for', () => {
    expect(SUPPORTED_HOLIDAY_COUNTRIES).toContain('IE')
  })

  it('is frozen', () => {
    expect(Object.isFrozen(SUPPORTED_HOLIDAY_COUNTRIES)).toBe(true)
  })
})

describe('countryName', () => {
  it('returns a friendly name for known codes', () => {
    expect(countryName('IE')).toBe('Ireland')
    expect(countryName('GB')).toBe('United Kingdom')
  })

  it('falls back to the code for unknown countries', () => {
    expect(countryName('XX')).toBe('XX')
    expect(countryName('')).toBe('')
    expect(countryName(null)).toBe('')
  })
})

describe('indexByDate', () => {
  it('builds an O(1) lookup map keyed by date', () => {
    const m = indexByDate(getStaticHolidays('2025-12-25', '2025-12-26'))
    expect(m.size).toBe(2)
    expect(m.get('2025-12-25').name).toBe('Christmas Day')
    expect(m.get('2025-12-27')).toBeUndefined()
  })

  it('handles empty / null input', () => {
    expect(indexByDate([]).size).toBe(0)
    expect(indexByDate(null).size).toBe(0)
  })
})
