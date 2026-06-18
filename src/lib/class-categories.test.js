import { describe, it, expect } from 'vitest'
import { mergeSeenWithMappings, CLASS_CATEGORY_VALUES } from './class-categories'

describe('mergeSeenWithMappings', () => {
  it('dedupes seen names by normalized form, attaches category, sorts by name', () => {
    const seen = ['RIDE', 'ride', 'TEMPO', 'DR1VE 45']
    const mappings = [{ class_name_normalized: 'ride', category: 'cardio' }, { class_name_normalized: 'tempo', category: 'strength' }]
    const out = mergeSeenWithMappings(seen, mappings)
    expect(out).toEqual([
      { class_name: 'DR1VE 45', category: null },
      { class_name: 'RIDE', category: 'cardio' },
      { class_name: 'TEMPO', category: 'strength' },
    ])
  })
  it('includes mapped names even if not currently seen', () => {
    const out = mergeSeenWithMappings([], [{ class_name_normalized: 'spin', category: 'cardio' }])
    expect(out).toEqual([{ class_name: 'spin', category: 'cardio' }])
  })
  it('exposes the category enum', () => {
    expect(CLASS_CATEGORY_VALUES).toEqual(['cardio', 'strength', 'conditioning'])
  })
})
