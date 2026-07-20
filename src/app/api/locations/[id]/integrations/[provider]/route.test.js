// Route-level tests for PUT/DELETE /api/locations/[id]/integrations/[provider]
// (INTEG hub inline #4 Phase 2).
//
// These pin the two things the orchestrator reviews:
//   1. The GLOFOX NULL-COLLAPSE GUARD end-to-end — a blank PUT on
//      Stillorgan's LIVE Glofox connection persists the slice UNCHANGED and
//      leaves the registry row ACTIVE (status 'connected'), never wiping it.
//   2. Per-provider role gates + assertLocationAccess, secret masking
//      (has_* only, no token in the response), sibling-slice non-clobber,
//      and disconnect = deactivate (is_active=false, not hard-delete).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'loc-still'

function liveGlofoxLocation() {
  return {
    id: LOC,
    name: 'Stillorgan',
    features: { bca_submit: true },
    settings: {
      // A sibling slice that must survive a Glofox write untouched.
      customer_agent: { enabled: true, agent_name: 'Mia' },
      glofox: {
        branch_id: 'branch-abc',
        api_key: 'LIVE_KEY',
        api_token: 'LIVE_TOKEN',
        webhook_secret: 'LIVE_SECRET',
        namespace: 'untstillorgan',
        trial_membership_id: 'mem-1',
      },
    },
    sensibo_api_key: null,
    thinq_pat: null,
    thinq_client_id: null,
    thinq_country_code: null,
    twilio_alpha_sender_id: null,
    bca_config: null,
  }
}

// Minimal Supabase mock: an in-memory `locations` row + `channel_connections`
// array. Records every write so tests can assert on the persisted payloads.
function makeDb({ location, channelConnections = [] }) {
  const locRow = { ...location }
  const cc = channelConnections.map((r) => ({ ...r }))
  const log = { locationUpdates: [], ccUpdates: [], ccInserts: [] }

  function from(table) {
    const state = { table, op: 'select', payload: null, filters: [] }
    const rowsFor = () => {
      if (table === 'locations') return [locRow]
      return cc
    }
    const matches = (row) =>
      state.filters.every(([col, val]) => (col === '__in__' ? true : row[col] === val))

    function finalize({ single = false } = {}) {
      if (state.op === 'select') {
        const found = rowsFor().filter(matches)
        if (single) return { data: found[0] || null, error: found[0] ? null : (table === 'locations' ? { message: 'not found' } : null) }
        return { data: found, error: null }
      }
      if (state.op === 'update') {
        if (table === 'locations') {
          Object.assign(locRow, state.payload)
          log.locationUpdates.push(state.payload)
        } else {
          for (const row of cc.filter(matches)) Object.assign(row, state.payload)
          log.ccUpdates.push(state.payload)
        }
        return { data: null, error: null }
      }
      if (state.op === 'insert') {
        const row = { id: `cc-${cc.length + 1}`, ...state.payload }
        cc.push(row)
        log.ccInserts.push(state.payload)
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }

    const builder = {
      select() { return builder },
      update(p) { state.op = 'update'; state.payload = p; return builder },
      insert(p) { state.op = 'insert'; state.payload = p; return builder },
      eq(col, val) { state.filters.push([col, val]); return builder },
      in() { return builder },
      maybeSingle() { return Promise.resolve(finalize({ single: true })) },
      single() { return Promise.resolve(finalize({ single: true })) },
      then(res, rej) { return Promise.resolve(finalize()).then(res, rej) },
    }
    return builder
  }

  return { db: { from }, log, locRow, cc }
}

function req(body) {
  return { json: async () => body }
}
const props = (id, provider) => ({ params: Promise.resolve({ id, provider }) })

const MASTER = { id: 'm', isMaster: true, role: 'master', rolesByLocation: {}, locations: [{ id: LOC }] }
const OWNER = { id: 'o', isMaster: false, role: 'owner', rolesByLocation: { [LOC]: 'owner' }, locations: [{ id: LOC }] }
const MANAGER = { id: 'mg', isMaster: false, role: 'manager', rolesByLocation: { [LOC]: 'manager' }, locations: [{ id: LOC }] }
const HEAD_COACH = { id: 'hc', isMaster: false, role: 'head_coach', rolesByLocation: { [LOC]: 'head_coach' }, locations: [{ id: LOC }] }
const OUTSIDER = { id: 'x', isMaster: false, role: 'owner', rolesByLocation: { 'other': 'owner' }, locations: [{ id: 'other' }] }

beforeEach(() => vi.clearAllMocks())

describe('Glofox null-collapse guard (the core regression)', () => {
  it('a BLANK save on the live connection persists the slice UNCHANGED and keeps the registry ACTIVE', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const { db, log, locRow, cc } = makeDb({
      location: liveGlofoxLocation(),
      channelConnections: [{ id: 'cc-g', location_id: LOC, platform: 'glofox', is_active: true, access_token: 'LIVE_KEY' }],
    })
    createServerClient.mockReturnValue(db)

    // The drawer's no-op save: secrets blank/masked, non-secrets echoed back.
    const res = await PUT(req({ branch_id: 'branch-abc', namespace: 'untstillorgan', api_key: '', api_token: '••••••', webhook_secret: '' }), props(LOC, 'glofox'))
    const body = await res.json()

    expect(res.status).toBe(200)
    // Persisted slice still carries every live secret.
    expect(locRow.settings.glofox.api_key).toBe('LIVE_KEY')
    expect(locRow.settings.glofox.api_token).toBe('LIVE_TOKEN')
    expect(locRow.settings.glofox.webhook_secret).toBe('LIVE_SECRET')
    expect(locRow.settings.glofox).not.toBeNull()
    // Sibling slice untouched.
    expect(locRow.settings.customer_agent).toEqual({ enabled: true, agent_name: 'Mia' })
    // Registry row stays ACTIVE (updated to status connected, never deactivated).
    expect(cc[0].is_active).toBe(true)
    expect(log.ccUpdates.some((u) => u.status === 'connected')).toBe(true)
    expect(log.ccUpdates.some((u) => u.is_active === false)).toBe(false)
    // Masked echo — presence booleans only, no secret value in the response.
    expect(body.data.has_api_key).toBe(true)
    expect(JSON.stringify(body.data)).not.toContain('LIVE_KEY')
  })

  it('a FRESH api_key overwrites only that field; the others are preserved', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const { db, locRow } = makeDb({ location: liveGlofoxLocation() })
    createServerClient.mockReturnValue(db)

    await PUT(req({ branch_id: 'branch-abc', api_key: 'ROTATED', api_token: '', webhook_secret: '••••••' }), props(LOC, 'glofox'))

    expect(locRow.settings.glofox.api_key).toBe('ROTATED')
    expect(locRow.settings.glofox.api_token).toBe('LIVE_TOKEN')
    expect(locRow.settings.glofox.webhook_secret).toBe('LIVE_SECRET')
    expect(locRow.settings.glofox.trial_membership_id).toBe('mem-1') // non-exposed field survives
  })

  it('DELETE disconnect clears the slice AND deactivates the registry row', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const { db, log, locRow, cc } = makeDb({
      location: liveGlofoxLocation(),
      channelConnections: [{ id: 'cc-g', location_id: LOC, platform: 'glofox', is_active: true, access_token: 'LIVE_KEY' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(req(), props(LOC, 'glofox'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.disconnected).toBe(true)
    expect(locRow.settings.glofox).toBeNull()
    expect(locRow.settings.customer_agent).toEqual({ enabled: true, agent_name: 'Mia' }) // sibling survives
    expect(cc[0].is_active).toBe(false) // deactivated, NOT hard-deleted
    expect(log.ccUpdates.some((u) => u.is_active === false)).toBe(true)
  })
})

describe('role gates + access', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(req({}), props(LOC, 'glofox'))
    expect(res.status).toBe(401)
  })

  it('404 for an unknown provider (before auth work)', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await PUT(req({}), props(LOC, 'nope'))
    expect(res.status).toBe(404)
  })

  it('403 when the location is not in the caller assignments (assertLocationAccess)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const res = await PUT(req({ branch_id: 'x' }), props(LOC, 'glofox'))
    expect(res.status).toBe(403)
  })

  it('Glofox (admin tier): manager is allowed, head_coach is 403', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    let { db } = makeDb({ location: liveGlofoxLocation() })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ branch_id: 'branch-abc' }), props(LOC, 'glofox'))).status).toBe(200)

    getCurrentUser.mockResolvedValue(HEAD_COACH)
    ;({ db } = makeDb({ location: liveGlofoxLocation() }))
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ branch_id: 'x' }), props(LOC, 'glofox'))).status).toBe(403)
  })

  it('UniFi (master tier): owner is 403, master is allowed', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const { db } = makeDb({ location: liveGlofoxLocation() })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ host: 'https://x:12445' }), props(LOC, 'unifi'))).status).toBe(403)

    getCurrentUser.mockResolvedValue(MASTER)
    const m = makeDb({ location: liveGlofoxLocation() })
    createServerClient.mockReturnValue(m.db)
    const res = await PUT(req({ host: 'https://x:12445', api_token: 'UNIFI_TOK' }), props(LOC, 'unifi'))
    expect(res.status).toBe(200)
    expect(m.locRow.settings.unifi.api_token).toBe('UNIFI_TOK')
    expect(m.locRow.settings.glofox).toBeTruthy() // sibling glofox slice survived
  })

  it('AC (master tier): master save keeps blank sensibo secret, updates country', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const loc = liveGlofoxLocation()
    loc.sensibo_api_key = 'SENSIBO_LIVE'
    const m = makeDb({ location: loc })
    createServerClient.mockReturnValue(m.db)
    const res = await PUT(req({ sensibo_api_key: '', thinq_pat: '', thinq_client_id: 'cid', thinq_country_code: 'GB' }), props(LOC, 'ac'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(m.locRow.sensibo_api_key).toBe('SENSIBO_LIVE') // blank kept
    expect(m.locRow.thinq_country_code).toBe('GB')
    expect(body.data.has_sensibo_key).toBe(true)
    expect(JSON.stringify(body.data)).not.toContain('SENSIBO_LIVE')
  })

  it('AC: a fresh ThinQ PAT with no client_id auto-generates a uuid client_id', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const m = makeDb({ location: liveGlofoxLocation() })
    createServerClient.mockReturnValue(m.db)
    const res = await PUT(req({ thinq_pat: 'FRESH_PAT', thinq_client_id: '', thinq_country_code: 'IE' }), props(LOC, 'ac'))
    expect(res.status).toBe(200)
    expect(m.locRow.thinq_pat).toBe('FRESH_PAT')
    expect(m.locRow.thinq_client_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('Twilio: sender ID is returned in full (not a secret)', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const m = makeDb({ location: liveGlofoxLocation() })
    createServerClient.mockReturnValue(m.db)
    const res = await PUT(req({ sender_id: 'UN1T STILL' }), props(LOC, 'twilio'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(m.locRow.twilio_alpha_sender_id).toBe('UN1T STILL')
    expect(body.data.sender_id).toBe('UN1T STILL')
  })
})
