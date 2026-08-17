// PHASE2 stage C — last-used-side persistence for dual (staff+member)
// identities. Pure round-trip + validation: a corrupt or foreign value in
// SecureStore must read as "no preference" (boot then defaults to staff),
// never as a route the resolver would honour blindly.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({ values: new Map() }))

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k) => (store.values.has(k) ? store.values.get(k) : null)),
  setItemAsync: vi.fn(async (k, v) => { store.values.set(k, v) }),
  deleteItemAsync: vi.fn(async (k) => { store.values.delete(k) }),
}))

import { LAST_SIDE_KEY, readLastSide, writeLastSide, clearLastSide, routeForSide } from './last-side'
import { STAFF_HOME, MEMBER_HOME } from './identity'

beforeEach(() => { store.values.clear() })

describe('last-side persistence', () => {
  it('null when never set', async () => {
    expect(await readLastSide()).toBe(null)
  })

  it('round-trips staff and member', async () => {
    await writeLastSide('member')
    expect(await readLastSide()).toBe('member')
    await writeLastSide('staff')
    expect(await readLastSide()).toBe('staff')
  })

  it('rejects junk on write (no-op) and on read (null)', async () => {
    await writeLastSide('admin')
    expect(await readLastSide()).toBe(null)
    store.values.set(LAST_SIDE_KEY, 'garbage')
    expect(await readLastSide()).toBe(null)
  })

  it('clears', async () => {
    await writeLastSide('member')
    await clearLastSide()
    expect(await readLastSide()).toBe(null)
  })
})

describe('routeForSide', () => {
  it('maps each side to its shell home', () => {
    expect(routeForSide('staff')).toBe(STAFF_HOME)
    expect(routeForSide('member')).toBe(MEMBER_HOME)
  })

  it('defaults junk to the staff home (fail-safe)', () => {
    expect(routeForSide('nope')).toBe(STAFF_HOME)
    expect(routeForSide(null)).toBe(STAFF_HOME)
  })
})
