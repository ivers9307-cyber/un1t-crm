// PHONEHOME.1 — the remembered studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItem: vi.fn(async (k, v) => { store.set(k, v) }),
    removeItem: vi.fn(async (k) => { store.delete(k) }),
  },
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { readActiveLocationId, writeActiveLocationId, rememberAfterMe } from './active-location-store'

beforeEach(() => { store.clear(); vi.clearAllMocks() })

describe('readActiveLocationId / writeActiveLocationId', () => {
  it('keeps one pick per user, so a shared phone never hands it to the next person', async () => {
    await writeActiveLocationId('u1', 'loc-a')
    expect(await readActiveLocationId('u1')).toBe('loc-a')
    expect(await readActiveLocationId('u2')).toBeNull()
  })
  it('clears with a null pick', async () => {
    await writeActiveLocationId('u1', 'loc-a')
    await writeActiveLocationId('u1', null)
    expect(await readActiveLocationId('u1')).toBeNull()
  })
  it('no user, no read or write', async () => {
    await writeActiveLocationId(null, 'loc-a')
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
    expect(await readActiveLocationId(null)).toBeNull()
  })
  it('a storage failure reads as "nothing remembered", never a throw', async () => {
    AsyncStorage.getItem.mockRejectedValueOnce(new Error('disk'))
    expect(await readActiveLocationId('u1')).toBeNull()
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('disk'))
    await expect(writeActiveLocationId('u1', 'x')).resolves.toBeUndefined()
  })
})

describe('rememberAfterMe', () => {
  it('keeps a pick the server honoured', () => {
    expect(rememberAfterMe({ asked: 'loc-a', answered: 'loc-a' })).toBe('keep')
  })
  it('forgets a pick the server did not honour (studio no longer held)', () => {
    expect(rememberAfterMe({ asked: 'loc-a', answered: 'loc-b' })).toBe('clear')
  })
  it('never remembers the server default when nothing was asked', () => {
    expect(rememberAfterMe({ asked: null, answered: 'loc-b' })).toBe('keep')
  })
  it('changes nothing while impersonating', () => {
    expect(rememberAfterMe({ asked: 'loc-a', answered: 'loc-x', impersonating: true })).toBe('keep')
  })
})
