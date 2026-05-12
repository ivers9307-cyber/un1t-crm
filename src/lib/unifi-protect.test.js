import { describe, it, expect } from 'vitest'
import { getLocationProtectConfig, findProfileByFaceId } from './unifi-protect.js'

describe('getLocationProtectConfig', () => {
  it('returns configured=false for null location', () => {
    expect(getLocationProtectConfig(null).configured).toBe(false)
  })

  it('returns configured=false when settings.unifi_protect is missing', () => {
    expect(getLocationProtectConfig({ settings: {} }).configured).toBe(false)
  })

  it('returns configured=true with both host AND api_key set', () => {
    const cfg = getLocationProtectConfig({
      settings: { unifi_protect: { host: 'https://protect.example', api_key: 'secret' } },
    })
    expect(cfg).toMatchObject({ configured: true, host: 'https://protect.example', apiKey: 'secret' })
  })

  it('strips trailing slash from host', () => {
    const cfg = getLocationProtectConfig({
      settings: { unifi_protect: { host: 'https://protect.example/', api_key: 'k' } },
    })
    expect(cfg.host).toBe('https://protect.example')
  })

  it('falls back to settings.unifi.host when unifi_protect.host is absent', () => {
    // Operators often paste the host once into the Access settings;
    // we re-use it for Protect rather than asking them to paste twice.
    // api_key still has to be Protect-specific (Access uses api_token).
    const cfg = getLocationProtectConfig({
      settings: {
        unifi: { host: 'https://shared.example' },
        unifi_protect: { api_key: 'k' },
      },
    })
    expect(cfg).toMatchObject({ configured: true, host: 'https://shared.example' })
  })

  it('configured=false when api_key missing even if host is set', () => {
    expect(getLocationProtectConfig({
      settings: { unifi_protect: { host: 'https://x' } },
    }).configured).toBe(false)
  })

  it('inherits allow_self_signed from either unifi_protect or unifi', () => {
    expect(getLocationProtectConfig({
      settings: { unifi_protect: { host: 'h', api_key: 'k', allow_self_signed: true } },
    }).allowSelfSigned).toBe(true)
    expect(getLocationProtectConfig({
      settings: {
        unifi: { allow_self_signed: true },
        unifi_protect: { host: 'h', api_key: 'k' },
      },
    }).allowSelfSigned).toBe(true)
  })
})

describe('findProfileByFaceId', () => {
  function fakeDb({ row = null } = {}) {
    const calls = []
    return {
      calls,
      from(_table) {
        return {
          select() {
            return {
              eq(col, val) {
                calls.push([col, val])
                return {
                  eq(col2, val2) {
                    calls.push([col2, val2])
                    return {
                      limit() {
                        return Promise.resolve({ data: row ? [row] : [] })
                      },
                    }
                  },
                }
              },
            }
          },
        }
      },
    }
  }

  it('returns null when db / locationId / faceId missing', async () => {
    expect(await findProfileByFaceId(null, 'l', 'f')).toBeNull()
    expect(await findProfileByFaceId(fakeDb(), null, 'f')).toBeNull()
    expect(await findProfileByFaceId(fakeDb(), 'l', null)).toBeNull()
  })

  it('returns null when no mapping exists', async () => {
    const db = fakeDb({ row: null })
    expect(await findProfileByFaceId(db, 'loc1', 'face1')).toBeNull()
  })

  it('returns the mapping row when found', async () => {
    const db = fakeDb({ row: { profile_id: 'prof1', role: 'manager' } })
    const out = await findProfileByFaceId(db, 'loc1', 'face1')
    expect(out).toEqual({ profile_id: 'prof1', role: 'manager' })
  })

  it('queries by location_id AND protect_face_id', async () => {
    const db = fakeDb({ row: null })
    await findProfileByFaceId(db, 'loc1', 'face1')
    expect(db.calls).toEqual([
      ['location_id', 'loc1'],
      ['protect_face_id', 'face1'],
    ])
  })
})
