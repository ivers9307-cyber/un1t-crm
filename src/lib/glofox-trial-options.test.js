import { describe, it, expect } from 'vitest'
import { buildTrialOptions } from './glofox-trial-options.js'

const CATALOGUE = [
  { membership_id: 'm1', plan_code: 'p1', label: 'Trial — 1 week' },
  { membership_id: 'm2', plan_code: 'p2' },
]

describe('buildTrialOptions', () => {
  it('maps the catalogue to {value,label}, using a fallback label when none', () => {
    expect(buildTrialOptions(CATALOGUE, '')).toEqual([
      { value: 'm1:p1', label: 'Trial — 1 week' },
      { value: 'm2:p2', label: 'm2 / p2' },
    ])
  })

  it('does NOT duplicate the saved value when it is already in the catalogue', () => {
    const opts = buildTrialOptions(CATALOGUE, 'm1:p1')
    expect(opts.filter((o) => o.value === 'm1:p1')).toHaveLength(1)
    expect(opts).toHaveLength(2)
  })

  it('prepends the saved value as an option when the catalogue is empty (loading / error)', () => {
    expect(buildTrialOptions([], '620bdab4df0f8054814cd7be:1644944026897')).toEqual([
      { value: '620bdab4df0f8054814cd7be:1644944026897', label: 'Current selection (620bdab4df0f8054814cd7be)' },
    ])
  })

  it('prepends the saved value when the catalogue loaded but no longer contains it', () => {
    const opts = buildTrialOptions(CATALOGUE, 'gone:plan')
    expect(opts[0]).toEqual({ value: 'gone:plan', label: 'Current selection (gone)' })
    expect(opts).toHaveLength(3)
  })

  it('returns only the catalogue when no value is saved', () => {
    expect(buildTrialOptions(CATALOGUE, '')).toHaveLength(2)
  })

  it('handles a null / non-array catalogue without throwing', () => {
    expect(buildTrialOptions(null, '')).toEqual([])
    expect(buildTrialOptions(undefined, 'x:y')).toEqual([
      { value: 'x:y', label: 'Current selection (x)' },
    ])
  })
})
