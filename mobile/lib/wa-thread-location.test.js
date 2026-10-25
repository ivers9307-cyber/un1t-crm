import { describe, it, expect } from 'vitest'
import { threadLocationId } from './wa-thread-location'

// INBOXLOC.1 (C37) — the thread screen acts at the CONVERSATION's studio.
describe('threadLocationId', () => {
  const active = { id: 'loc-active' }

  it('once the thread has loaded: the conversation\'s studio, whatever the active one', () => {
    expect(threadLocationId({ id: 'c1', location_id: 'loc-thread' }, active)).toBe('loc-thread')
  })

  it('before it has loaded: the active studio (the server judges the thread\'s studio anyway)', () => {
    expect(threadLocationId(null, active)).toBe('loc-active')
    expect(threadLocationId(undefined, active)).toBe('loc-active')
    expect(threadLocationId({ id: 'c1' }, active)).toBe('loc-active')
  })

  it('a malformed location is ignored, never sent as a header', () => {
    expect(threadLocationId({ location_id: '' }, active)).toBe('loc-active')
    expect(threadLocationId({ location_id: 42 }, active)).toBe('loc-active')
    expect(threadLocationId({ location_id: { id: 'x' } }, active)).toBe('loc-active')
  })

  it('nothing known: undefined (api() then sends no location header)', () => {
    expect(threadLocationId(null, null)).toBeUndefined()
    expect(threadLocationId(null, {})).toBeUndefined()
  })
})
