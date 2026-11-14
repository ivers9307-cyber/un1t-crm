import { describe, it, expect } from 'vitest'
import { studioHeaders, withStudio, studioChip, STUDIO_HEADER } from './studio-request'

describe('studioHeaders', () => {
  it('names the item studio, even when it is the active one', () => {
    expect(studioHeaders({ studioId: 's2' }, 's1')).toEqual({ 'x-active-location': 's2' })
    expect(studioHeaders({ studioId: 's1' }, 's1')).toEqual({ 'x-active-location': 's1' })
    expect(STUDIO_HEADER).toBe('x-active-location')
  })
  it('sends nothing for an item with no studio (the This studio view)', () => {
    expect(studioHeaders({ id: 'a' }, 's1')).toEqual({})
    expect(studioHeaders({ studioId: '' }, 's1')).toEqual({})
    expect(studioHeaders(null)).toEqual({})
    expect(studioHeaders(undefined)).toEqual({})
  })
})

describe('withStudio', () => {
  it('merges the header into the init without dropping existing headers', () => {
    const init = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    expect(withStudio({ studioId: 's2' }, init)).toEqual({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-active-location': 's2' },
      body: '{}',
    })
  })
  it('adds headers when the init has none, and works with no init', () => {
    expect(withStudio({ studioId: 's2' }, { method: 'POST' })).toEqual({ method: 'POST', headers: { 'x-active-location': 's2' } })
    expect(withStudio({ studioId: 's2' })).toEqual({ headers: { 'x-active-location': 's2' } })
  })
  it('returns the init untouched for an item with no studio', () => {
    const init = { method: 'POST' }
    expect(withStudio({ id: 'a' }, init)).toBe(init)
    expect(withStudio({ id: 'a' })).toEqual({})
  })
  it('does not mutate the init it was given', () => {
    const init = { headers: { a: '1' } }
    withStudio({ studioId: 's2' }, init)
    expect(init).toEqual({ headers: { a: '1' } })
  })
})

describe('studioChip', () => {
  it('is null without a studio on the item', () => {
    expect(studioChip({ id: 'a' }, 's1')).toBeNull()
    expect(studioChip({ studioId: 's2' }, 's1')).toBeNull()
  })
  it('flags a studio other than the active one', () => {
    expect(studioChip({ studioId: 's2', studioName: 'Hatch' }, 's1')).toEqual({ id: 's2', name: 'Hatch', other: true })
    expect(studioChip({ studioId: 's1', studioName: 'Stillorgan' }, 's1')).toEqual({ id: 's1', name: 'Stillorgan', other: false })
  })
})
