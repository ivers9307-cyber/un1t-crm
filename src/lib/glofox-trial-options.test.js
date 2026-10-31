import { describe, it, expect } from 'vitest'
import { buildTrialOptions } from './glofox-trial-options.js'

// Real catalogue shape as returned by listGlofoxMemberships /
// GET /api/locations/[id]/glofox-memberships: memberships with nested plans[].
const CATALOGUE = [
  { _id: 'm1', name: 'UN1T Trial', trial: true, plans: [{ code: 'p1', name: '3 classes' }] },
  { _id: 'm2', name: 'Intro Pack', plans: [{ code: 'p2' }] }, // plan has no name
]

describe('buildTrialOptions', () => {
  it('flattens membership×plan into {value,label}, plan name appended when present', () => {
    expect(buildTrialOptions(CATALOGUE, '')).toEqual([
      { value: 'm1:p1', label: 'UN1T Trial — 3 classes' },
      { value: 'm2:p2', label: 'Intro Pack' },
    ])
  })

  it('emits one option per plan for a multi-plan membership', () => {
    const multi = [{ _id: 'mx', name: 'Flex', plans: [{ code: 'a', name: 'Weekly' }, { code: 'b', name: 'Monthly' }] }]
    expect(buildTrialOptions(multi, '')).toEqual([
      { value: 'mx:a', label: 'Flex — Weekly' },
      { value: 'mx:b', label: 'Flex — Monthly' },
    ])
  })

  it('skips memberships without an _id and plans without a code', () => {
    const messy = [
      { name: 'no id', plans: [{ code: 'p' }] },
      { _id: 'ok', name: 'Ok', plans: [{ name: 'no code' }, { code: 'good', name: 'Good' }] },
    ]
    expect(buildTrialOptions(messy, '')).toEqual([
      { value: 'ok:good', label: 'Ok — Good' },
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

  // GLOFOXPRIVATE.1 — a membership learned by id because Glofox's list hides it.
  it('marks a private membership in its label and leaves public ones alone', () => {
    const withPrivate = [
      ...CATALOGUE,
      { _id: '68b17bbd4e9e83430f0ddcdc', name: '1) The Elites Trial', private: true, plans: [{ code: '1756461990251', name: 'The Elites Trial' }] },
    ]
    const opts = buildTrialOptions(withPrivate, '')
    expect(opts[0].label).toBe('UN1T Trial — 3 classes')
    expect(opts[2]).toEqual({ value: '68b17bbd4e9e83430f0ddcdc:1756461990251', label: '1) The Elites Trial — The Elites Trial (private)' })
    // private:false and an absent flag read the same: public.
    expect(buildTrialOptions([{ ...CATALOGUE[1], private: false }], '')[0].label).toBe('Intro Pack')
  })

  it('handles a null / non-array catalogue without throwing', () => {
    expect(buildTrialOptions(null, '')).toEqual([])
    expect(buildTrialOptions(undefined, 'x:y')).toEqual([
      { value: 'x:y', label: 'Current selection (x)' },
    ])
  })
})
