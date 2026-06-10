import { describe, it, expect } from 'vitest'
import { PUBLISH_STATES, tileModeFor, isPubliclyVisible } from './landing-page-visibility'

describe('landing-page visibility helpers', () => {
  it('lists exactly the three states in order', () => {
    expect(PUBLISH_STATES).toEqual(['live', 'coming_soon', 'hidden'])
  })

  it('tileModeFor maps each known state', () => {
    expect(tileModeFor('live')).toBe('active')
    expect(tileModeFor('coming_soon')).toBe('coming_soon')
    expect(tileModeFor('hidden')).toBe('hidden')
  })

  it('tileModeFor fails closed on unknown / null / undefined', () => {
    expect(tileModeFor(null)).toBe('hidden')
    expect(tileModeFor(undefined)).toBe('hidden')
    expect(tileModeFor('bogus')).toBe('hidden')
  })

  it('isPubliclyVisible is true only for live', () => {
    expect(isPubliclyVisible('live')).toBe(true)
    expect(isPubliclyVisible('coming_soon')).toBe(false)
    expect(isPubliclyVisible('hidden')).toBe(false)
    expect(isPubliclyVisible(null)).toBe(false)
  })
})
