import { describe, it, expect } from 'vitest'
import { parseHiddenKeywords } from './class-keywords.js'
import { parseHiddenKeywords as viaPublicClasses } from './public-classes.js'

describe('class-keywords', () => {
  it('parses a string or list into trimmed lower-case keywords', () => {
    expect(parseHiddenKeywords('Elites, Open Gym\nHYROX')).toEqual(['elites', 'open gym', 'hyrox'])
    expect(parseHiddenKeywords([' A ', '', 'b'])).toEqual(['a', 'b'])
    expect(parseHiddenKeywords(7)).toEqual([])
  })
  it('public-classes re-exports the very same function', () => {
    expect(viaPublicClasses).toBe(parseHiddenKeywords)
  })
})
