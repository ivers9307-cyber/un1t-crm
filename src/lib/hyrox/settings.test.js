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

describe('resolveHyroxSettings house style + examples', () => {
  it('defaults house style to empty and examples to []', () => {
    const s = resolveHyroxSettings({})
    expect(s.houseStyle).toBe('')
    expect(s.styleExamples).toEqual([])
  })
  it('reads house style and a well-formed examples array', () => {
    const loc = { settings: { hyrox: { house_style: 'Partner relays, loud cueing.', style_examples: [
      { id: 'a', source: 'pasted', label: 'Wed engine', text: 'run 500m then...', added_at: '2026-07-01T00:00:00Z' },
    ] } } }
    const s = resolveHyroxSettings(loc)
    expect(s.houseStyle).toBe('Partner relays, loud cueing.')
    expect(s.styleExamples).toHaveLength(1)
    expect(s.styleExamples[0].text).toContain('run 500m')
  })
  it('drops malformed example entries (no text)', () => {
    const loc = { settings: { hyrox: { style_examples: [{ id: 'x' }, { text: 'ok text', source: 'pasted' }] } } }
    expect(resolveHyroxSettings(loc).styleExamples).toHaveLength(1)
  })
})
