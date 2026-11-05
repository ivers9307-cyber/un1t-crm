import { describe, it, expect } from 'vitest'
import { filterKnowledge } from './knowledge-filter'

const entries = [
  { id: 1, category: 'hours', title: 'Opening hours', content: 'Mon to Fri 6am' },
  { id: 2, category: 'sales', title: 'Trial offer', content: 'First class FREE' },
  { id: 3, category: 'faq', title: 'Parking', content: 'Opening times of the car park' },
  { id: 4, category: 'sales', title: null, content: null },
]
const ids = (o) => filterKnowledge(entries, o).map((e) => e.id)

describe('filterKnowledge', () => {
  it('no filter keeps every entry, in order', () => {
    expect(ids({})).toEqual([1, 2, 3, 4])
    expect(ids({ query: '   ', category: '' })).toEqual([1, 2, 3, 4])
  })
  it('the query matches title and content, case-insensitive', () => {
    expect(ids({ query: 'OPENING' })).toEqual([1, 3])
    expect(ids({ query: 'free' })).toEqual([2])
    expect(ids({ query: 'nothing here' })).toEqual([])
  })
  it('the category narrows to one', () => {
    expect(ids({ category: 'sales' })).toEqual([2, 4])
  })
  it('both must match', () => {
    expect(ids({ query: 'opening', category: 'faq' })).toEqual([3])
    expect(ids({ query: 'free', category: 'faq' })).toEqual([])
  })
  it('copes with no entries', () => {
    expect(filterKnowledge(undefined, { query: 'a' })).toEqual([])
  })
})
