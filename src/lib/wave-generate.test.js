// WAVEGEN.1 — bulk wave generation for the staff race editor.

import { describe, it, expect } from 'vitest'
import { generateWaveTimes, MAX_GENERATED_WAVES } from './wave-generate'

describe('generateWaveTimes', () => {
  it('generates inclusive start→end times at the given cadence', () => {
    expect(generateWaveTimes('10:00', '10:21', 7)).toEqual(['10:00', '10:07', '10:14', '10:21'])
  })

  it('stops before an end time that is not on the cadence', () => {
    expect(generateWaveTimes('10:00', '10:20', 7)).toEqual(['10:00', '10:07', '10:14'])
  })

  it('crosses the hour boundary with zero-padded output', () => {
    expect(generateWaveTimes('09:45', '10:15', 15)).toEqual(['09:45', '10:00', '10:15'])
  })

  it('yields a single wave when start equals end', () => {
    expect(generateWaveTimes('10:00', '10:00', 7)).toEqual(['10:00'])
  })

  it('returns [] for end before start, bad interval, or unparsable times', () => {
    expect(generateWaveTimes('11:00', '10:00', 7)).toEqual([])
    expect(generateWaveTimes('10:00', '11:00', 0)).toEqual([])
    expect(generateWaveTimes('10:00', '11:00', -5)).toEqual([])
    expect(generateWaveTimes('10:00', '11:00', 'x')).toEqual([])
    expect(generateWaveTimes('', '11:00', 7)).toEqual([])
    expect(generateWaveTimes('10:00', '25:00', 7)).toEqual([])
  })

  it('accepts a numeric string interval (form inputs are strings)', () => {
    expect(generateWaveTimes('10:00', '10:14', '7')).toEqual(['10:00', '10:07', '10:14'])
  })

  it('caps a runaway generation at MAX_GENERATED_WAVES', () => {
    const times = generateWaveTimes('00:00', '23:59', 1)
    expect(times).toHaveLength(MAX_GENERATED_WAVES)
    expect(times[0]).toBe('00:00')
  })
})
