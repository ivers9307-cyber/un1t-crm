// STAFFFORMSETTINGS.1 — the staff form's unifi_configured must agree with
// what a save does. The save path (staff-write.js) asks getUnifiConfig(db,
// location): the location's active `unifi` registry row overlaid on its
// legacy settings.unifi, then getLocationUnifiConfig. loadStaffFormLocations
// batches the same overlay (overlayConnectionsMany). This file runs BOTH
// against one small fake db with NOTHING in the registry path mocked (the
// sibling staff-form-locations.test.js mocks overlayConnectionsMany, so it
// cannot see a drift between the two readers).
// Fictional values only (public repo).

import { describe, it, expect, vi } from 'vitest'

// Quiet only; the registry's fail-open logging is not under test here.
vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { loadStaffFormLocations } from './staff-form-locations.js'
import { getUnifiConfig } from './unifi-access.js'
import { acCredentialsConfigured } from './ac-device-admin.js'
import { overlayConnections } from './connection-registry.js'

const LEGACY = 'a0000000-0000-4000-8000-0000000000a1'
const REGISTRY = 'a0000000-0000-4000-8000-0000000000a2'
const BOTH_NULLED = 'a0000000-0000-4000-8000-0000000000a3'
const NEITHER = 'a0000000-0000-4000-8000-0000000000a4'
const AC_REG = 'a0000000-0000-4000-8000-0000000000a5'
const AC_THINQ_HALF = 'a0000000-0000-4000-8000-0000000000a6'

const UNIFI_OK = { host: 'https://unifi.example.test', api_token: 'SYNTH-UT', staff_policy_id: 'p-staff', manager_policy_id: 'p-mgr' }
const { api_token: _token, ...UNIFI_CONFIG } = UNIFI_OK

const loc = (id, name, settings = {}) => ({
  id, name, slug: name.toLowerCase(), address: null, phone: null, email: null, timezone: 'Europe/Dublin',
  active: true, created_at: 'T', updated_at: 'T', country: 'IE', features: {},
  organization_id: 'o0000000-0000-4000-8000-000000000001', is_host_anchor: false,
  settings,
  sensibo_api_key: null, thinq_pat: null, thinq_client_id: null,
})

const conn = (locationId, accessToken) => ({
  id: `cc-${locationId.slice(-2)}`, location_id: locationId, platform: 'unifi', status: 'connected', is_active: true,
  label: null, display_name: null, external_account_id: null, access_token: accessToken, app_secret: null,
  config: UNIFI_CONFIG, token_expires_at: null, last_error: null, last_ok_at: null,
})

const TABLES = {
  locations: [
    loc(LEGACY, 'Alpha', { unifi: UNIFI_OK }),                 // legacy only
    loc(REGISTRY, 'Bravo', {}),                                 // registry only
    loc(BOTH_NULLED, 'Charlie', { unifi: UNIFI_OK }),           // both; the registry nulls the token
    loc(NEITHER, 'Delta', {}),                                  // neither
    loc(AC_REG, 'Echo', {}),                                    // AC (Sensibo) in the registry only
    { ...loc(AC_THINQ_HALF, 'Foxtrot', {}), thinq_pat: 'SYNTH-T' }, // ThinQ PAT, no client id
  ],
  channel_connections: [
    conn(REGISTRY, 'SYNTH-UT-REG'),
    conn(BOTH_NULLED, null),
    // noise the filters must drop: another platform, an inactive row.
    // ACALLOWLISTGATE.1: the other-platform row is a ThinQ PAT with no client
    // id, so it is noise for AC too and "neither" still means neither.
    { ...conn(NEITHER, 'SYNTH-OTHER'), platform: 'thinq', config: {} },
    { ...conn(NEITHER, 'SYNTH-OFF'), is_active: false },
    { ...conn(AC_REG, 'SYNTH-S-REG'), platform: 'sensibo', config: {} },
  ],
}

// A filterable fake: eq/in/order really filter the fixture rows, so it serves
// overlayConnectionsMany's select/in/eq/in AND readActiveConnections'
// select/eq/eq/in (getUnifiConfig's path) from the same data.
function fakeDb(tables) {
  return {
    from(table) {
      let rows = [...(tables[table] || [])]
      const chain = {
        select: () => chain,
        eq: (col, val) => { rows = rows.filter((r) => r[col] === val); return chain },
        in: (col, vals) => { rows = rows.filter((r) => vals.includes(r[col])); return chain },
        order: (col) => { rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col]))); return chain },
        then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      }
      return chain
    },
  }
}

describe('unifi_configured matches the save path (getUnifiConfig), unmocked', () => {
  const cases = [
    ['legacy only', LEGACY, true],
    ['registry only', REGISTRY, true],
    ['both, the registry nulling the token', BOTH_NULLED, false],
    ['neither', NEITHER, false],
  ]

  it.each(cases)('%s', async (_label, id, expected) => {
    const db = fakeDb(TABLES)
    const { locations, error } = await loadStaffFormLocations(db)
    expect(error).toBeNull()
    const formRow = locations.find((l) => l.id === id)
    const rawRow = TABLES.locations.find((l) => l.id === id)
    const saved = await getUnifiConfig(db, rawRow)
    expect(formRow.unifi_configured).toBe(saved.configured)
    // Pinned too, so the parity cannot pass with both readers wrong alike.
    expect(formRow.unifi_configured).toBe(expected)
  })
})

// ACALLOWLISTGATE.1 — ac_configured must agree with the AC control path's
// credential check (ac-devices.js loadDeviceWithLocation: overlayConnections
// with 'sensibo','thinq', then the credential rule acCredentialsConfigured
// names; that function is itself pinned to vendorGetState by
// ac-credentials-parity.test.js).
describe('ac_configured matches the AC control path, unmocked', () => {
  const cases = [
    ['legacy UniFi only', LEGACY, false],
    ['registry UniFi only', REGISTRY, false],
    ['UniFi nulled by the registry', BOTH_NULLED, false],
    ['neither (a ThinQ registry row with no client id)', NEITHER, false],
    ['AC (Sensibo) in the registry only', AC_REG, true],
    ['a ThinQ PAT without a client id', AC_THINQ_HALF, false],
  ]

  it.each(cases)('%s', async (_label, id, expected) => {
    const db = fakeDb(TABLES)
    const { locations, error } = await loadStaffFormLocations(db)
    expect(error).toBeNull()
    const formRow = locations.find((l) => l.id === id)
    const rawRow = TABLES.locations.find((l) => l.id === id)
    const control = acCredentialsConfigured(await overlayConnections(db, rawRow, ['sensibo', 'thinq']))
    expect(formRow.ac_configured).toBe(control)
    // Pinned too, so the parity cannot pass with both readers wrong alike.
    expect(formRow.ac_configured).toBe(expected)
  })
})
