// mobile/lib/studio-device.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k) => (store.has(k) ? store.get(k) : null)),
  setItemAsync: vi.fn(async (k, v) => { store.set(k, v) }),
  deleteItemAsync: vi.fn(async (k) => { store.delete(k) }),
}))

const mod = await import('./studio-device.js')

beforeEach(() => { store.clear() })

describe('pairing', () => {
  it('round-trips a pairing token', async () => {
    expect(await mod.getPairing()).toBe(null)
    await mod.savePairing({ token: 'a'.repeat(20), label: 'Reception' })
    expect(await mod.getPairing()).toEqual({ token: 'a'.repeat(20), label: 'Reception' })
  })
  it('rejects a token shorter than 16 chars', async () => {
    await expect(mod.savePairing({ token: 'short' })).rejects.toThrow()
  })
  it('clearPairing wipes the token AND the menu cache', async () => {
    await mod.savePairing({ token: 'a'.repeat(20) })
    await mod.writeMenuCache('u1', { profile: { id: 'u1' } })
    await mod.clearPairing()
    expect(await mod.getPairing()).toBe(null)
    expect(await mod.readMenuCache('u1')).toBe(null)
  })
})

describe('menu cache', () => {
  it('round-trips a per-user blob and isolates users', async () => {
    await mod.writeMenuCache('u1', { profile: { id: 'u1', role: 'staff' }, locations: [], activeLocation: null })
    expect(await mod.readMenuCache('u1')).toEqual({ profile: { id: 'u1', role: 'staff' }, locations: [], activeLocation: null })
    expect(await mod.readMenuCache('u2')).toBe(null)
  })
  it('clearAllMenuCache wipes every cached user', async () => {
    await mod.writeMenuCache('u1', { profile: { id: 'u1' } })
    await mod.writeMenuCache('u2', { profile: { id: 'u2' } })
    await mod.clearAllMenuCache()
    expect(await mod.readMenuCache('u1')).toBe(null)
    expect(await mod.readMenuCache('u2')).toBe(null)
  })
  it('readMenuCache returns null for a falsy id', async () => {
    expect(await mod.readMenuCache('')).toBe(null)
  })
})
