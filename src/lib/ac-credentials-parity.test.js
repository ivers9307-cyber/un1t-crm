// ACALLOWLISTGATE.1 — acCredentialsConfigured must agree with what switching a
// unit actually does. The control path (ac-devices.js loadDeviceWithLocation →
// overlayConnections(db, row, ['sensibo','thinq']) → resolveCredentials, via
// the public vendorGetState) is run here against one small fake db with the
// registry UNmocked, for both vendors, and compared.
// Fictional values only (public repo).
import { describe, it, expect, vi } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { acCredentialsConfigured } from './ac-device-admin.js'
import { vendorGetState } from './ac-devices.js'
import { overlayConnections } from './connection-registry.js'

const L = (n) => `a0000000-0000-4000-8000-0000000000b${n}`
const loc = (id, cols = {}) => ({ id, sensibo_api_key: null, thinq_pat: null, thinq_client_id: null, thinq_country_code: null, ...cols })
const conn = (locationId, platform, accessToken, config = {}) => ({
  id: `cc-${platform}-${locationId.slice(-2)}`, location_id: locationId, platform, status: 'connected', is_active: true,
  label: null, display_name: null, external_account_id: null, access_token: accessToken, app_secret: null,
  config, token_expires_at: null, last_error: null, last_ok_at: null,
})

const TABLES = {
  locations: [
    loc(L(1), { sensibo_api_key: 'SYNTH-S' }),                                // legacy Sensibo
    loc(L(2)),                                                                 // registry-only Sensibo
    loc(L(3), { thinq_pat: 'SYNTH-T', thinq_client_id: 'cid' }),              // legacy ThinQ
    loc(L(4), { thinq_pat: 'SYNTH-T' }),                                       // ThinQ without client id
    loc(L(5), { sensibo_api_key: 'SYNTH-S' }),                                // legacy key, registry nulls it
    loc(L(6)),                                                                 // nothing
  ],
  channel_connections: [
    conn(L(2), 'sensibo', 'SYNTH-S-REG'),
    conn(L(5), 'sensibo', null),
    { ...conn(L(6), 'sensibo', 'SYNTH-OFF'), is_active: false },               // inactive: ignored
    conn(L(6), 'unifi', 'SYNTH-U'),                                            // another platform: ignored
  ],
}

function fakeDb(tables) {
  return {
    from(table) {
      let rows = [...(tables[table] || [])]
      const chain = {
        select: () => chain,
        eq: (col, val) => { rows = rows.filter((r) => r[col] === val); return chain },
        in: (col, vals) => { rows = rows.filter((r) => vals.includes(r[col])); return chain },
        order: () => chain,
        then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      }
      return chain
    },
  }
}

const STUB = { getState: async () => ({ power: 'off' }) }
async function controlPathWorks(db, raw) {
  const overlaid = await overlayConnections(db, raw, ['sensibo', 'thinq'])
  for (const provider of ['sensibo', 'thinq']) {
    const r = await vendorGetState({ provider, provider_device_id: 'dev' }, overlaid, { vendorAdapters: { sensibo: STUB, thinq: STUB } })
    if (r.ok) return true
  }
  return false
}

describe('acCredentialsConfigured matches the control path, unmocked', () => {
  it.each([
    ['legacy Sensibo', L(1), true],
    ['registry-only Sensibo', L(2), true],
    ['legacy ThinQ', L(3), true],
    ['ThinQ without a client id', L(4), false],
    ['legacy key nulled by the registry', L(5), false],
    ['nothing (inactive + other-platform rows ignored)', L(6), false],
  ])('%s', async (_label, id, expected) => {
    const db = fakeDb(TABLES)
    const raw = TABLES.locations.find((l) => l.id === id)
    const overlaid = await overlayConnections(db, raw, ['sensibo', 'thinq'])
    expect(acCredentialsConfigured(overlaid)).toBe(await controlPathWorks(db, raw))
    expect(acCredentialsConfigured(overlaid)).toBe(expected) // pinned, so both cannot be wrong alike
  })
})
