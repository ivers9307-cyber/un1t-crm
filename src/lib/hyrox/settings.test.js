import { describe, it, expect } from 'vitest'
import { resolveHyroxSettings } from './settings'
import { DEFAULT_CHARTER } from './constants'

describe('resolveHyroxSettings', () => {
  it('falls back to the default charter when unset', () => {
    expect(resolveHyroxSettings({}).charter).toBe(DEFAULT_CHARTER)
    expect(resolveHyroxSettings(null).charter).toBe(DEFAULT_CHARTER)
    expect(resolveHyroxSettings({ settings: {} }).charter).toBe(DEFAULT_CHARTER)
  })
  it('uses a non-empty operator override', () => {
    const loc = { settings: { hyrox: { charter: 'Be brutal but brief.' } } }
    expect(resolveHyroxSettings(loc).charter).toBe('Be brutal but brief.')
  })
  it('ignores a blank override', () => {
    const loc = { settings: { hyrox: { charter: '   ' } } }
    expect(resolveHyroxSettings(loc).charter).toBe(DEFAULT_CHARTER)
  })
})
