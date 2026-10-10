// W1.B2 — the phone reads the tenant's brand through /api/public/branding.
//
// company_settings is closed to client sessions (mig 674), so the phone can
// never read the brand from Supabase; the public branding route resolves the
// chain (company_settings → org_settings → locations.name, W1.B1) and this
// module caches the answer per location. Pure vitest: api() and AsyncStorage
// are stubbed, exactly the two edges the loader has.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
let failStorage = false
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k) => {
      if (failStorage) throw new Error('storage unavailable')
      return store.has(k) ? store.get(k) : null
    }),
    setItem: vi.fn(async (k, v) => {
      if (failStorage) throw new Error('storage unavailable')
      store.set(k, v)
    }),
    removeItem: vi.fn(async (k) => {
      if (failStorage) throw new Error('storage unavailable')
      store.delete(k)
    }),
  },
}))

vi.mock('./api', () => ({
  api: vi.fn(async () => ({
    success: true,
    data: {
      company_name: 'Gym A',
      short_name: 'Gym A',
      logo_url: null,
      product_names: { points: 'Gym A Points', hr: 'Gym A HR' },
      points_unit: 'Gym A',
    },
  })),
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { api } from './api'
import { loadBrand, _resetBrandCache, brandFromApi, brandStorageKey, EMPTY_BRAND } from './brand'

beforeEach(() => {
  _resetBrandCache()
  store.clear()
  failStorage = false
  api.mockClear()
  AsyncStorage.getItem.mockClear()
  AsyncStorage.setItem.mockClear()
})

describe('brand (W1.B2)', () => {
  it('loads the brand for a location once and caches it', async () => {
    expect((await loadBrand('loc-1')).companyName).toBe('Gym A')
    expect((await loadBrand('loc-1')).productNames.points).toBe('Gym A Points')
    expect((await loadBrand('loc-1')).productNames.hr).toBe('Gym A HR')
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith('/api/public/branding?location_id=loc-1')
  })

  it('a failed load yields empty strings, never a literal', async () => {
    api.mockRejectedValueOnce(new Error('offline'))
    const b = await loadBrand('loc-2')
    expect(b.companyName).toBe('')
    expect(b.shortName).toBe('')
    expect(b.logoUrl).toBe(null)
    // Bare nouns, the same answer productName('') gives on the web.
    expect(b.productNames).toEqual({ points: 'Points', hr: 'HR' })
    expect(JSON.stringify(b)).not.toMatch(/UN1T/)
  })

  it('a transport envelope (api() never throws on a dropped link) is a failed load too', async () => {
    api.mockResolvedValueOnce({ success: false, transport: true, error: 'Network error' })
    expect(await loadBrand('loc-3')).toEqual(EMPTY_BRAND)
    // …and a failure is NOT cached: the next call asks again.
    expect((await loadBrand('loc-3')).companyName).toBe('Gym A')
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('persists the brand under brand:<locationId> and serves a cold start from it', async () => {
    await loadBrand('loc-1')
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(brandStorageKey('loc-1'), expect.any(String))
    expect(JSON.parse(store.get('brand:loc-1')).companyName).toBe('Gym A')

    // Cold start: memory gone, storage warm, network down → the stored brand.
    _resetBrandCache()
    api.mockRejectedValueOnce(new Error('offline'))
    expect((await loadBrand('loc-1')).companyName).toBe('Gym A')
  })

  it('a dead AsyncStorage never breaks the load', async () => {
    failStorage = true
    expect((await loadBrand('loc-1')).companyName).toBe('Gym A')
  })

  it('concurrent loads for one location share a single request', async () => {
    const [a, b] = await Promise.all([loadBrand('loc-1'), loadBrand('loc-1')])
    expect(a.companyName).toBe('Gym A')
    expect(b).toBe(a)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('no location → the empty brand, no request', async () => {
    expect(await loadBrand(null)).toEqual(EMPTY_BRAND)
    expect(await loadBrand('')).toEqual(EMPTY_BRAND)
    expect(api).not.toHaveBeenCalled()
  })

  it('brandFromApi derives product names when the route omits them (older deploy)', () => {
    const b = brandFromApi({ company_name: 'Hatch Fitness', short_name: 'Hatch', logo_url: 'https://x/l.png' })
    expect(b.productNames).toEqual({ points: 'Hatch Points', hr: 'Hatch HR' })
    expect(b.pointsUnit).toBe('Hatch')
    expect(b.logoUrl).toBe('https://x/l.png')
    // short_name falls back to the company name, the same way the web resolver does.
    expect(brandFromApi({ company_name: 'Solo Gym' }).shortName).toBe('Solo Gym')
    expect(brandFromApi({ company_name: 'Solo Gym' }).productNames.points).toBe('Solo Gym Points')
    expect(brandFromApi(null)).toEqual(EMPTY_BRAND)
  })
})
