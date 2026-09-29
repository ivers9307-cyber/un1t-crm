import { describe, it, expect } from 'vitest'
import { waBodyVariables, WA_VARIABLE_FIELDS } from './compose.js'

describe('waBodyVariables', () => {
  const tpl = (text) => ({ components: [{ type: 'HEADER', text: 'hi' }, { type: 'BODY', text }] })

  it('returns [] when no template / no body', () => {
    expect(waBodyVariables(null)).toEqual([])
    expect(waBodyVariables({})).toEqual([])
    expect(waBodyVariables({ components: [{ type: 'HEADER', text: 'x {{1}}' }] })).toEqual([])
  })

  it('extracts, dedupes and sorts numeric placeholders from BODY only', () => {
    expect(waBodyVariables(tpl('Hi {{1}}, your {{2}} is ready'))).toEqual(['1', '2'])
    expect(waBodyVariables(tpl('{{2}} then {{1}} then {{2}} again'))).toEqual(['1', '2'])
    expect(waBodyVariables(tpl('no vars here'))).toEqual([])
  })

  it('sorts numerically, not lexically (10 after 9)', () => {
    expect(waBodyVariables(tpl('{{10}} {{2}} {{1}}'))).toEqual(['1', '2', '10'])
  })

  it('exposes the mappable contact fields', () => {
    expect(WA_VARIABLE_FIELDS).toContain('first_name')
    expect(WA_VARIABLE_FIELDS).toContain('location_name')
  })
})
