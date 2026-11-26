// MERGEFALLBACK.1 — {{tag|fallback}} in applyMergeTags.
import { describe, it, expect } from 'vitest'
import { applyMergeTags } from './postmark'

const anne = { first_name: 'Anne', name: 'Anne Byrne', email: 'a@example.ie' }
const blank = { first_name: '', name: '', email: 'x@example.ie' }

describe('merge-tag fallbacks (MERGEFALLBACK.1)', () => {
  it('uses the value when there is one', () => {
    expect(applyMergeTags('Hi {{first_name|there}},', anne)).toBe('Hi Anne,')
  })

  it('uses the fallback when the value is empty', () => {
    expect(applyMergeTags('Hi {{first_name|there}},', blank)).toBe('Hi there,')
  })

  it('tolerates spaces and an empty fallback', () => {
    expect(applyMergeTags('Hi {{ first_name | friend }}!', blank)).toBe('Hi friend!')
    expect(applyMergeTags('Hi {{first_name|}}!', blank)).toBe('Hi !')
  })

  it('works for extras such as location_name', () => {
    expect(applyMergeTags('See you at {{location_name|the studio}}', anne, {})).toBe('See you at the studio')
    expect(applyMergeTags('See you at {{location_name|the studio}}', anne, { location_name: 'Stillorgan' })).toBe('See you at Stillorgan')
  })

  it('leaves unknown tags and plain tags as before', () => {
    expect(applyMergeTags('{{nickname|pal}} {{first_name}}', anne)).toBe('{{nickname|pal}} Anne')
  })
})
