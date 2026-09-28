// ACDEVLOC.1 — helpers shared by /api/locations/[id]/ac-devices,
// …/discover and …/[deviceId].
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/connection-registry', () => ({ overlayConnections: vi.fn() }))

import {
  normaliseDevicePatch, buildDeviceInsert, readAcCredentials,
  redactSecrets, publicPod, publicThinqDevice,
} from './ac-device-admin.js'
import { overlayConnections } from '@/lib/connection-registry'

const LOC = 'b0000000-0000-4000-8000-00000000000b'

describe('normaliseDevicePatch', () => {
  it('keeps only editable keys, so identity columns can never change', () => {
    expect(normaliseDevicePatch({ label: 'Floor', provider: 'thinq', location_id: 'x', provider_device_id: 'y' }))
      .toEqual({ patch: { label: 'Floor' } })
  })
  it('coerces numbers, trims, and turns a blank group or auto-off into null', () => {
    expect(normaliseDevicePatch({
      device_group: '  ', default_temp_c: '21', session_minutes: '45', external_auto_off_minutes: '',
    })).toEqual({ patch: { device_group: null, default_temp_c: 21, session_minutes: 45, external_auto_off_minutes: null } })
    expect(normaliseDevicePatch({ external_auto_off_minutes: '90.4' })).toEqual({ patch: { external_auto_off_minutes: 90 } })
    expect(normaliseDevicePatch({ external_auto_off_minutes: -5 })).toEqual({ patch: { external_auto_off_minutes: null } })
  })
  it('accepts enabled true (re-enable) and false (disable)', () => {
    expect(normaliseDevicePatch({ enabled: true })).toEqual({ patch: { enabled: true } })
    expect(normaliseDevicePatch({ enabled: false })).toEqual({ patch: { enabled: false } })
  })
  it('refuses an empty patch, a blank label and a non-boolean enabled', () => {
    expect(normaliseDevicePatch({})).toEqual({ error: 'No editable fields supplied.' })
    expect(normaliseDevicePatch({ label: '   ' })).toEqual({ error: 'label cannot be empty.' })
    expect(normaliseDevicePatch({ enabled: 'yes' })).toEqual({ error: 'enabled must be true or false.' })
  })
})

describe('buildDeviceInsert', () => {
  it('builds the row at the given location with the provider default group', () => {
    expect(buildDeviceInsert(LOC, { provider: 'Sensibo', provider_device_id: ' pod-1 ', label: ' Floor ' })).toEqual({
      insert: { location_id: LOC, label: 'Floor', provider: 'sensibo', provider_device_id: 'pod-1', device_group: 'Gym Floor' },
    })
    expect(buildDeviceInsert(LOC, { provider: 'thinq', provider_device_id: 'lg-1', label: 'Bath M', default_temp_c: '20' }).insert)
      .toMatchObject({ provider: 'thinq', device_group: 'Bathrooms', default_temp_c: 20 })
  })
  it('refuses an unknown provider, a missing id and a missing label', () => {
    expect(buildDeviceInsert(LOC, { provider: 'daikin', provider_device_id: 'a', label: 'b' }).error).toBe('provider must be "sensibo" or "thinq".')
    expect(buildDeviceInsert(LOC, { provider: 'sensibo', label: 'b' }).error).toBe('provider_device_id is required.')
    expect(buildDeviceInsert(LOC, { provider: 'sensibo', provider_device_id: 'a' }).error).toBe('label is required.')
  })
})

describe('redactSecrets', () => {
  it('replaces every occurrence of each secret', () => {
    expect(redactSecrets('bad key sk-123456 (sk-123456)', ['sk-123456'])).toBe('bad key •••• (••••)')
    expect(redactSecrets('pat p-abcdef and key k-zyxwvu', ['p-abcdef', 'k-zyxwvu'])).toBe('pat •••• and key ••••')
  })
  it('ignores empty, short and non-string secrets, and a missing message', () => {
    expect(redactSecrets('a b c', ['', 'ab', null, undefined, 42])).toBe('a b c')
    expect(redactSecrets(undefined, ['sk-123456'])).toBe('')
  })
})

describe('publicPod / publicThinqDevice', () => {
  it('return ids and names only, never the vendor raw object', () => {
    expect(publicPod({ id: 'p1', room_name: 'Floor', product_model: 'sky', on: true, raw: { x: 1 } }))
      .toEqual({ id: 'p1', room_name: 'Floor', product_model: 'sky' })
    expect(publicThinqDevice({ device_id: 'd1', alias: 'Bath', model: 'm', device_type: 'AC', raw: { y: 2 } }))
      .toEqual({ device_id: 'd1', alias: 'Bath', model: 'm' })
  })
})

describe('readAcCredentials', () => {
  function db(result) {
    const calls = []
    return {
      calls,
      from: (table) => {
        const call = { table, filters: [] }
        calls.push(call)
        const chain = { select: () => chain, eq: (c, v) => { call.filters.push([c, v]); return chain }, maybeSingle: () => Promise.resolve(result) }
        return chain
      },
    }
  }
  beforeEach(() => { vi.clearAllMocks(); overlayConnections.mockImplementation(async (_db, loc) => loc) })

  it('reads the given location and applies the registry overlay', async () => {
    const d = db({ data: { id: LOC, sensibo_api_key: 'sk-legacy', thinq_pat: null, thinq_client_id: null, thinq_country_code: null }, error: null })
    overlayConnections.mockImplementation(async (_db, loc) => ({ ...loc, sensibo_api_key: 'sk-registry' }))
    const out = await readAcCredentials(d, LOC)
    expect(d.calls[0].filters).toEqual([['id', LOC]])
    expect(overlayConnections).toHaveBeenCalledWith(d, expect.objectContaining({ id: LOC }), ['sensibo', 'thinq'])
    expect(out).toEqual({ creds: { sensiboApiKey: 'sk-registry', thinqPat: null, thinqClientId: null, thinqCountryCode: null } })
  })
  it('a failed read is an error, never "no credentials"', async () => {
    const out = await readAcCredentials(db({ data: null, error: { message: 'boom' } }), LOC)
    expect(out).toEqual({ error: { message: 'boom' } })
    expect(overlayConnections).not.toHaveBeenCalled()
  })
  it('a missing location is notFound', async () => {
    expect(await readAcCredentials(db({ data: null, error: null }), LOC)).toEqual({ notFound: true })
  })
})
