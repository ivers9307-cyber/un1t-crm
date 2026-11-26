import { describe, it, expect } from 'vitest'
import { suggestEmailFix } from './email-typo'

describe('suggestEmailFix (TYPOHINT.1)', () => {
  it.each([
    ['anne@gmial.com', 'anne@gmail.com'],
    ['anne@gmail.co', 'anne@gmail.com'],
    ['anne@gmail.ie', 'anne@gmail.com'],
    ['Anne.B@hotmial.com', 'Anne.B@hotmail.com'],
    ['anne@outlok.com', 'anne@outlook.com'],
    ['anne@icloud.co', 'anne@icloud.com'],
    ['anne@yaho.com', 'anne@yahoo.com'],
  ])('suggests a fix for %s', (input, fixed) => {
    expect(suggestEmailFix(input)).toBe(fixed)
  })

  it.each([
    'anne@gmail.com', 'anne@hotmail.ie', 'anne@un1tdublin.com', 'anne@tcd.ie', 'anne@company.ie',
    'anne@', '@gmail.com', 'anne', '', null,
  ])('says nothing for %s', (input) => {
    expect(suggestEmailFix(input)).toBe(null)
  })
})
