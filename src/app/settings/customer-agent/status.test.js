import { describe, it, expect } from 'vitest'
import { statusOf, flagsFor } from './status'

describe('statusOf', () => {
  it('reads all four flag pairs', () => {
    expect(statusOf({ enabled: false, test_mode: false })).toBe('off')
    expect(statusOf({ enabled: false, test_mode: true })).toBe('test')
    expect(statusOf({ enabled: true, test_mode: false })).toBe('live')
    expect(statusOf({ enabled: true, test_mode: true })).toBe('live_and_test')
  })
  it('treats missing flags as off', () => {
    expect(statusOf({})).toBe('off')
    expect(statusOf()).toBe('off')
  })
})

describe('flagsFor', () => {
  it('maps each choice to the stored flags', () => {
    expect(flagsFor('off')).toEqual({ enabled: false, test_mode: false })
    expect(flagsFor('test')).toEqual({ enabled: false, test_mode: true })
    expect(flagsFor('live')).toEqual({ enabled: true, test_mode: false })
  })
})
