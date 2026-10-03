// shared/shift-briefing.test.js
import { describe, it, expect } from 'vitest'
import { BRIEFING_MAX_LENGTH, normaliseBriefing, briefingOf } from './shift-briefing'

describe('normaliseBriefing', () => {
  it('trims, and blank is null (the DB refuses blank: mig 629)', () => {
    expect(normaliseBriefing('  Fire drill at 10  ')).toBe('Fire drill at 10')
    expect(normaliseBriefing('')).toBeNull()
    expect(normaliseBriefing('   \n\t')).toBeNull()
  })

  it('anything that is not a string is null', () => {
    for (const v of [null, undefined, 0, {}, []]) expect(normaliseBriefing(v)).toBeNull()
  })

  it('keeps inner line breaks: a briefing can be a short list', () => {
    expect(normaliseBriefing('Bring:\n- bands\n- timer')).toBe('Bring:\n- bands\n- timer')
  })

  it('the cap is the database cap', () => {
    expect(BRIEFING_MAX_LENGTH).toBe(500)
  })
})

describe('briefingOf', () => {
  it('reads a row\'s top-level briefing, normalised (block, /shifts row and Today row alike)', () => {
    expect(briefingOf({ briefing: ' Cover the intro ' })).toBe('Cover the intro')
    expect(briefingOf({ briefing: null })).toBeNull()
    expect(briefingOf({})).toBeNull()
    expect(briefingOf(null)).toBeNull()
  })
})
