// SHELLY-UI.3 — /api/shelly/connection.
//
// What this suite is actually protecting:
//
//  1. THE KEY NEVER LEAVES. Every fixture connection row carries a real-looking
//     auth_key, and every assertion about a response body runs against
//     JSON.stringify(body) — so a route that spread the row instead of
//     projecting publicConnectionView() fails here rather than in production.
//     The fingerprint is held to the same rule: it is a sha256 OF the key.
//
//  2. A RE-PASTE MUST NOT WIPE THE CREDENTIAL. The UI renders the key as
//     "••••abcd" and posts it back blank, so "change only the server" arrives
//     as an empty auth_key. If that were read as "clear it", an owner
//     correcting a typo in the host would disconnect their studio.
//
//  3. THE CROSS-ORG REFUSAL NAMES NOBODY. classifyFingerprintClash is the REAL
//     one here (only probeConnection and findFingerprintRows are stubbed), and
//     the 409 body is checked for the foreign location's name by string search.
//
//  4. guardMasterOrOwner IS THE REAL FUNCTION. A manager holds device_control
//     by role default, so the permission gate lets them through and only the
//     owner/master gate stops them — which is exactly the pairing that would
//     silently invert if either half were stubbed.
//
// @/lib/auth is mocked PARTIALLY (importOriginal) so guardMasterOrOwner is the
// shipped implementation and only getCurrentUser is a stub; next/headers is
// mocked because that module imports it at load time and the test env is node.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})
// PARTIAL: classifyFingerprintClash, publicConnectionView and
// loadPublicConnection stay real (they are the security logic under test);
// only the two functions that would reach the network or need a richer fake
// db are stubbed.
vi.mock('@/lib/shelly/connections', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, probeConnection: vi.fn(), findFingerprintRows: vi.fn() }
})

import { GET, PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { probeConnection, findFingerprintRows } from '@/lib/shelly/connections'
import { fingerprintAuthKey } from '@/lib/shelly/client'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const ORG_1 = '11111111-1111-4111-8111-111111111111'
const ORG_2 = '22222222-2222-4222-8222-222222222222'

// >= MIN_AUTH_KEY_LENGTH (16). Distinctive strings so a leak is greppable.
const STORED_KEY = 'STOREDKEY_abcdef0123456789'
const FRESH_KEY = 'FRESHKEY_9876543210fedcba'
const HOST = 'shelly-68-eu.shelly.cloud'

const HOST_HELP = 'Enter your account server from the Shelly app, e.g. shelly-<region>.shelly.cloud'

const locA = { id: LOC_A, organization_id: ORG_1, features: {} }
const OWNER_A = { id: 'u-owner', role: 'owner', profileRole: 'owner', rolesByLocation: { [LOC_A]: 'owner' }, activeLocation: locA }
const MANAGER_A = { id: 'u-manager', role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC_A]: 'manager' }, activeLocation: locA }
const MASTER = { id: 'u-master', role: 'master', profileRole: 'master', rolesByLocation: {}, activeLocation: locA }
const STAFF_A = { id: 'u-staff', role: 'staff', profileRole: 'staff', rolesByLocation: { [LOC_A]: 'staff' }, activeLocation: locA }

// A stored row exactly as the table holds it — SECRET INCLUDED, so every
// "the response has no key" assertion is testing the projection, not the
// fixture being conveniently thin.
const storedRow = (over = {}) => ({
  host: HOST,
  auth_key: STORED_KEY,
  auth_key_fingerprint: fingerprintAuthKey(STORED_KEY),
  key_hint: '6789',
  status: 'connected',
  last_ok_at: '2026-08-22T10:00:00.000Z',
  last_error: null,
  last_error_at: null,
  ...over,
})

/**
 * Minimal chainable supabase double. Records upsert payloads + options and
 * the delete's filters; resolves selects from the configured fixture.
 */
function makeDb(cfg = {}) {
  const conf = {
    connectionRow: null,
    connectionError: null,
    deviceCount: 0,
    deviceCountError: null,
    upsertError: null,
    upsertRow: undefined, // undefined => derive the returning row from the payload
    upsertLenient: false, // true => a driver that answers .single() with { data: null, error: null }
    deleteError: null,
    ...cfg,
  }
  const calls = { upserts: [], deletes: [], selects: [] }

  function resolveRow(st, { strict }) {
    if (st.op === 'upsert') {
      if (conf.upsertError) return { data: null, error: conf.upsertError }
      const p = st.payload
      const data = conf.upsertRow !== undefined ? conf.upsertRow : {
        host: p.host,
        key_hint: p.key_hint,
        status: p.status,
        last_ok_at: p.last_ok_at,
        last_error: p.last_error,
        last_error_at: p.last_error_at,
      }
      // PostgREST: .single() on zero rows is an ERROR, not a null row.
      // `upsertLenient` models a driver that does NOT do that, which is the
      // only world in which the route's `!row` guard is reachable — and the
      // reason that guard exists at all.
      if (!data && strict && !conf.upsertLenient) {
        return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
      }
      return { data, error: null }
    }
    if (conf.connectionError) return { data: null, error: conf.connectionError }
    // The .single()/.maybeSingle() ASYMMETRY IS THE POINT of modelling this
    // faithfully: PostgREST errors a .single() whenever the row count is
    // anything but exactly one, and answers a .maybeSingle() with a plain
    // null. A double that returns `{ data: null, error: null }` for both
    // makes the route's .maybeSingle() choice invisible — a route that used
    // .single() on the stored-row read would 500 every first connect in
    // production and pass every test here.
    if (!conf.connectionRow && strict) {
      return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
    }
    return { data: conf.connectionRow, error: null }
  }

  function resolveTerminal(st) {
    if (st.table === 'shelly_devices') {
      return { data: null, count: conf.deviceCount, error: conf.deviceCountError }
    }
    if (st.op === 'delete') return { data: null, error: conf.deleteError }
    return { data: null, error: null }
  }

  return {
    conf,
    calls,
    from(table) {
      const st = { table, op: 'select', cols: null, selectOpts: null, filters: {}, payload: null, upsertOpts: null }
      const b = {
        select: (cols, opts) => {
          st.cols = cols
          if (opts) st.selectOpts = opts
          if (st.op === 'select') calls.selects.push(st)
          return b
        },
        eq: (col, val) => { st.filters[col] = val; return b },
        upsert: (payload, opts) => {
          st.op = 'upsert'
          st.payload = payload
          st.upsertOpts = opts
          calls.upserts.push(st)
          return b
        },
        delete: () => { st.op = 'delete'; calls.deletes.push(st); return b },
        maybeSingle: () => Promise.resolve(resolveRow(st, { strict: false })),
        single: () => Promise.resolve(resolveRow(st, { strict: true })),
        then: (onOk, onErr) => Promise.resolve(resolveTerminal(st)).then(onOk, onErr),
      }
      return b
    },
  }
}

const getReq = () => new Request('http://localhost/api/shelly/connection')
const putReq = (body) => new Request('http://localhost/api/shelly/connection', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const delReq = () => new Request('http://localhost/api/shelly/connection', { method: 'DELETE' })

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  useDb()
  getCurrentUser.mockResolvedValue(OWNER_A)
  probeConnection.mockResolvedValue({ ok: true, deviceCount: 2 })
  findFingerprintRows.mockResolvedValue({ ok: true, rows: [] })
})

describe('GET /api/shelly/connection', () => {
  it('returns the public view, can_manage true for an owner, and the device count', async () => {
    useDb({ connectionRow: storedRow(), deviceCount: 4 })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.can_manage).toBe(true)
    expect(body.device_count).toBe(4)
    expect(body.connection).toEqual({
      host: HOST,
      key_hint: '6789',
      has_auth_key: true,
      status: 'connected',
      last_ok_at: '2026-08-22T10:00:00.000Z',
      last_error: null,
      last_error_at: null,
    })
    // The fixture row carried both secrets; the response carries neither.
    expect(JSON.stringify(body)).not.toContain(STORED_KEY)
    expect(JSON.stringify(body)).not.toContain(fingerprintAuthKey(STORED_KEY))
  })

  it('scopes both reads to the session location and never asks for auth_key', async () => {
    useDb({ connectionRow: storedRow(), deviceCount: 1 })
    await GET(getReq())
    for (const st of db.calls.selects) {
      expect(st.filters.location_id).toBe(LOC_A)
      expect(String(st.cols)).not.toContain('auth_key')
    }
    const counted = db.calls.selects.find((s) => s.table === 'shelly_devices')
    expect(counted.selectOpts).toEqual({ count: 'exact', head: true })
  })

  it('can_manage is FALSE for a manager, who still gets to see the connection', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    useDb({ connectionRow: storedRow(), deviceCount: 2 })
    const body = await (await GET(getReq())).json()
    expect(body.can_manage).toBe(false)
    expect(body.connection.host).toBe(HOST)
  })

  it('can_manage is true for a master with no per-location role row', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    useDb({ connectionRow: storedRow() })
    expect((await (await GET(getReq())).json()).can_manage).toBe(true)
  })

  it('answers connection:null when the location has never connected', async () => {
    useDb({ connectionRow: null, deviceCount: 0 })
    const body = await (await GET(getReq())).json()
    expect(body.connection).toBeNull()
    expect(body.device_count).toBe(0)
  })

  it('a failed device count degrades to null rather than a confident zero', async () => {
    useDb({ connectionRow: storedRow(), deviceCountError: { message: 'boom' } })
    const body = await (await GET(getReq())).json()
    expect(body.success).toBe(true)
    expect(body.device_count).toBeNull()
  })

  // SHELLY-UI.9b — the OTHER half of that class, and the one `count ?? 0`
  // used to swallow: PostgREST answers a null count with NO error alongside it
  // (a missing Prefer header, a driver quirk). The panel spends this number on
  // the Disconnect confirm — "your N plugs stay adopted" — so a fabricated 0
  // reads as "there is nothing to lose here" at the exact moment an operator
  // is deciding whether to unlink a studio with twelve plugs on it.
  it('an UNCOMPUTED count with no error is also null, never 0', async () => {
    useDb({ connectionRow: storedRow(), deviceCount: null })
    const body = await (await GET(getReq())).json()
    expect(body.success).toBe(true)
    expect(body.device_count).toBeNull()
    // A genuine zero still reads as zero — the fix must not blind the panel to
    // a real empty account.
    useDb({ connectionRow: storedRow(), deviceCount: 0 })
    expect((await (await GET(getReq())).json()).device_count).toBe(0)
  })

  it('a failed connection read is a 500, never a silent "not connected"', async () => {
    useDb({ connectionError: { message: 'db down' } })
    const res = await GET(getReq())
    expect(res.status).toBe(500)
  })

  it('403s a staff member — device_control is not a staff surface', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await GET(getReq())).status).toBe(403)
  })
})

describe('PUT /api/shelly/connection — host + key handling', () => {
  it('normalises a pasted URL down to the account hostname', async () => {
    const res = await PUT(putReq({ server: 'https://shelly-68-eu.shelly.cloud/', auth_key: FRESH_KEY }))
    expect(res.status).toBe(200)
    expect(db.calls.upserts[0].payload.host).toBe(HOST)
    // The probe is run against the NORMALISED host, not the pasted string.
    expect(probeConnection).toHaveBeenCalledWith({ host: HOST, auth_key: FRESH_KEY })
  })

  it("answers a malformed server with normaliseShellyHost's own copy", async () => {
    const res = await PUT(putReq({ server: 'https://evil.example/collect', auth_key: FRESH_KEY }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(HOST_HELP)
    expect(db.calls.upserts).toEqual([])
  })

  it('a BLANK auth_key on re-paste keeps the stored key (and its fingerprint)', async () => {
    useDb({ connectionRow: storedRow() })
    const res = await PUT(putReq({ server: 'shelly-99-eu.shelly.cloud', auth_key: '' }))
    expect(res.status).toBe(200)

    const { payload } = db.calls.upserts[0]
    expect(payload.auth_key).toBe(STORED_KEY)
    expect(payload.auth_key_fingerprint).toBe(fingerprintAuthKey(STORED_KEY))
    expect(payload.key_hint).toBe(STORED_KEY.slice(-4))
    // The host DID change — that is the whole point of a key-less re-paste.
    expect(payload.host).toBe('shelly-99-eu.shelly.cloud')
    expect(probeConnection).toHaveBeenCalledWith({ host: 'shelly-99-eu.shelly.cloud', auth_key: STORED_KEY })
  })

  it('an ABSENT auth_key on re-paste keeps the stored key too', async () => {
    useDb({ connectionRow: storedRow() })
    await PUT(putReq({ server: HOST }))
    expect(db.calls.upserts[0].payload.auth_key).toBe(STORED_KEY)
  })

  it('a WHITESPACE-ONLY auth_key keeps the stored key — it is not a new credential', async () => {
    useDb({ connectionRow: storedRow() })
    await PUT(putReq({ server: HOST, auth_key: '   ' }))
    expect(db.calls.upserts[0].payload.auth_key).toBe(STORED_KEY)
  })

  it('the MASKED ECHO the UI renders is kept, never stored as the key', async () => {
    // isFreshSecret rejects anything starting with the bullet run, so a form
    // that posts its own placeholder back cannot overwrite the credential
    // with "••••6789" — which would be unrecoverable without the real key.
    useDb({ connectionRow: storedRow() })
    await PUT(putReq({ server: HOST, auth_key: '••••6789' }))
    expect(db.calls.upserts[0].payload.auth_key).toBe(STORED_KEY)
    expect(db.calls.upserts[0].payload.key_hint).toBe(STORED_KEY.slice(-4))
  })

  it('first connect — no stored row and no key asks for the key, it does not 500', async () => {
    // The stored read is .maybeSingle() precisely so zero rows is a null row
    // rather than a PGRST116 error. With a .single() there this would be a
    // 500 on every studio's very first connect.
    useDb({ connectionRow: null })
    const res = await PUT(putReq({ server: HOST }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Paste the cloud auth key from the Shelly app')
  })

  it('a fresh key overwrites the stored one', async () => {
    useDb({ connectionRow: storedRow() })
    await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(db.calls.upserts[0].payload.auth_key).toBe(FRESH_KEY)
    expect(db.calls.upserts[0].payload.auth_key_fingerprint).toBe(fingerprintAuthKey(FRESH_KEY))
  })

  it('asks for a key when there is nothing stored and nothing pasted', async () => {
    const res = await PUT(putReq({ server: HOST }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Paste the cloud auth key from the Shelly app')
    expect(probeConnection).not.toHaveBeenCalled()
    expect(db.calls.upserts).toEqual([])
  })

  it('refuses a key shorter than the realistic floor before it is ever sent', async () => {
    const res = await PUT(putReq({ server: HOST, auth_key: 'too-short' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("That doesn't look like a Shelly auth key")
    expect(probeConnection).not.toHaveBeenCalled()
    expect(db.calls.upserts).toEqual([])
  })

  it('an unreadable stored row + a BLANK key refuses — there is nothing to proceed with', async () => {
    // Treating the unreadable row as "no row" would tell an already-connected
    // owner to paste a key the UI never shows them.
    useDb({ connectionError: { message: 'db down' } })
    const res = await PUT(putReq({ server: HOST, auth_key: '' }))
    expect(res.status).toBe(500)
    expect(db.calls.upserts).toEqual([])
  })

  it('an unreadable stored row + a FRESH key still LINKS — the row was not load-bearing', async () => {
    // The stored row feeds exactly one thing, the key fallback. Refusing here
    // would lock the only person who can fix a broken connection out of
    // fixing it, at the moment the database is already flaky — the louder
    // failure, not the safer one. host comes from normalised.host regardless.
    useDb({ connectionError: { message: 'db down' } })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(200)
    expect(db.calls.upserts[0].payload.auth_key).toBe(FRESH_KEY)
    expect(db.calls.upserts[0].payload.host).toBe(HOST)
  })
})

describe('PUT /api/shelly/connection — what the cloud says', () => {
  it('maps an auth failure to key_rejected, and writes nothing', async () => {
    probeConnection.mockResolvedValue({ ok: false, kind: 'auth', statusCode: 401 })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('key_rejected')
    expect(body.error).toContain('Authorization cloud key')
    expect(db.calls.upserts).toEqual([])
  })

  it('maps a config failure back to the host copy', async () => {
    probeConnection.mockResolvedValue({ ok: false, kind: 'config', statusCode: 0 })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(HOST_HELP)
  })

  it('a network blip is a 502 that blames the cloud, not the key', async () => {
    probeConnection.mockResolvedValue({ ok: false, kind: 'network', statusCode: 0 })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.code).toBe('network')
    expect(body.error).toBe('Shelly cloud did not answer — try again in a minute')
    expect(db.calls.upserts).toEqual([])
  })

  it('a rate limit is a 429, not a 502 — the caller can retry, the far end is not broken', async () => {
    probeConnection.mockResolvedValue({ ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('rate_limited')
    expect(db.calls.upserts).toEqual([])
  })

  it('surfaces devices_seen so "connected, 0 devices" is a visible state', async () => {
    probeConnection.mockResolvedValue({ ok: true, deviceCount: 0 })
    const body = await (await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))).json()
    expect(body.devices_seen).toBe(0)
  })

  it('passes an UNCOUNTABLE body through as null — not as a zero nobody can act on', async () => {
    probeConnection.mockResolvedValue({ ok: true, deviceCount: null })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(200)
    expect((await res.json()).devices_seen).toBeNull()
  })
})

describe('PUT /api/shelly/connection — tenancy', () => {
  it('refuses a key already linked in ANOTHER organisation, naming nobody', async () => {
    findFingerprintRows.mockResolvedValue({
      ok: true,
      rows: [{ location_id: LOC_B, locations: { organization_id: ORG_2, name: 'Rival Gym Ranelagh' } }],
    })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(409)

    const body = await res.json()
    expect(body.error).toBe('This Shelly account is already linked to another business')
    // Deliberately code-less, unlike the transient verification failure: this
    // one is not retryable, and a code is one more thing that could grow into
    // a hint about the other tenant.
    expect(body.code).toBeUndefined()
    const json = JSON.stringify(body)
    expect(json).not.toContain('Rival Gym Ranelagh')
    expect(json).not.toContain(LOC_B)
    expect(json).not.toContain(ORG_2)
    expect(json).not.toContain('auth_key')
    expect(json).not.toContain(FRESH_KEY)
    expect(db.calls.upserts).toEqual([])
  })

  it('allows a SAME-org sibling and names it in shared_with', async () => {
    findFingerprintRows.mockResolvedValue({
      ok: true,
      rows: [{ location_id: LOC_B, locations: { organization_id: ORG_1, name: 'UN1T Hatch Street' } }],
    })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(200)
    expect((await res.json()).shared_with).toEqual(['UN1T Hatch Street'])
    expect(db.calls.upserts).toHaveLength(1)
  })

  it('refuses the link when the fingerprint read was capped — every doubtful case refuses', async () => {
    findFingerprintRows.mockResolvedValue({ ok: false, reason: 'fingerprint_rows_capped' })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Could not verify this Shelly account right now')
    // Coded so the client can offer a retry — this refusal is transient,
    // unlike the other_org one, which stays code-less and generic.
    expect(body.code).toBe('verification_unavailable')
    // The reason describes OUR database; it is logged, never returned.
    expect(JSON.stringify(body)).not.toContain('fingerprint_rows_capped')
    expect(db.calls.upserts).toEqual([])
  })

  it('refuses on a db_error from the fingerprint read too', async () => {
    findFingerprintRows.mockResolvedValue({ ok: false, reason: 'db_error', error: 'connection reset' })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).not.toContain('connection reset')
    expect(db.calls.upserts).toEqual([])
  })

  it('the location under re-paste is its own row, not a clash', async () => {
    findFingerprintRows.mockResolvedValue({
      ok: true,
      rows: [{ location_id: LOC_A, locations: { organization_id: ORG_1, name: 'UN1T Stillorgan' } }],
    })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(200)
    expect((await res.json()).shared_with).toEqual([])
  })
})

describe('PUT /api/shelly/connection — the write', () => {
  it('upserts on location_id, marks it connected and CLEARS the error state', async () => {
    useDb({ connectionRow: storedRow({ status: 'action_needed', last_error: 'Shelly rejected the key', last_error_at: '2026-08-20T09:00:00.000Z' }) })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(200)

    const { payload, upsertOpts } = db.calls.upserts[0]
    expect(upsertOpts).toEqual({ onConflict: 'location_id' })
    expect(payload.location_id).toBe(LOC_A)
    expect(payload.status).toBe('connected')
    expect(payload.last_error).toBeNull()
    expect(payload.last_error_at).toBeNull()
    expect(payload.last_ok_at).toEqual(expect.any(String))
    expect(payload.updated_at).toEqual(expect.any(String))
    expect(payload.linked_by).toBe('u-owner')

    // The response reflects the cleared state — the hub's "Action needed"
    // chip is driven by status, so a stale one here would be the bug.
    const body = await res.json()
    expect(body.connection.status).toBe('connected')
    expect(body.connection.last_error).toBeNull()
  })

  it('never returns the key or the fingerprint it just wrote', async () => {
    const body = await (await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))).json()
    const json = JSON.stringify(body)
    expect(json).not.toContain(FRESH_KEY)
    expect(json).not.toContain(fingerprintAuthKey(FRESH_KEY))
    expect(json).not.toContain('auth_key_fingerprint')
    expect(Object.keys(body.connection).sort()).toEqual([
      'has_auth_key', 'host', 'key_hint', 'last_error', 'last_error_at', 'last_ok_at', 'status',
    ])
    // ...but the hint IS there, so the panel can render "••••dcba".
    expect(body.connection.key_hint).toBe(FRESH_KEY.slice(-4))
  })

  it('maps a CHECK violation (23514) to readable copy, never the pg message', async () => {
    useDb({ upsertError: { code: '23514', message: 'new row violates check constraint "shelly_connections_host_check"' } })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Shelly rejected the server or key format')
    expect(JSON.stringify(body)).not.toContain('check constraint')
  })

  it('maps a UNIQUE violation (23505) to a generic 409', async () => {
    useDb({ upsertError: { code: '23505', message: 'duplicate key value violates unique constraint' } })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Could not link this Shelly account')
  })

  it('any other write failure is a 500, not a success', async () => {
    useDb({ upsertError: { code: '08006', message: 'connection failure' } })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(500)
  })

  it('a returning row that never arrived is a 500, not an all-null "connected"', async () => {
    // PostgREST errors a zero-row .single(), so this lands on the error branch.
    useDb({ upsertRow: null })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(500)
  })

  it('...and still a 500 if a driver answered {data:null,error:null} — the !row backstop', async () => {
    // publicConnectionView(null) is a well-formed all-null connection with
    // has_auth_key:false, so without the guard a failed save would render as
    // "not connected" and nothing would look broken.
    useDb({ upsertRow: null, upsertLenient: true })
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('the stored read names exactly host+auth_key and the returning select is the non-secret list', async () => {
    useDb({ connectionRow: storedRow() })
    await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))

    const storedRead = db.calls.selects.find((s) => s.table === 'shelly_connections' && s.cols === 'host, auth_key')
    expect(storedRead).toBeDefined()
    expect(storedRead.filters.location_id).toBe(LOC_A)

    // Never '*': a column added to the table later must not start appearing
    // in a response because nobody remembered to subtract it.
    expect(db.calls.upserts[0].cols).toBe('host, key_hint, status, last_ok_at, last_error, last_error_at')
    expect(db.calls.upserts[0].cols).not.toContain('*')
    expect(db.calls.upserts[0].cols).not.toContain('auth_key')
  })
})

describe('PUT / DELETE — owner or master only', () => {
  it('403s a MANAGER on PUT even though they hold device_control', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(403)
    expect(probeConnection).not.toHaveBeenCalled()
    expect(db.calls.upserts).toEqual([])
  })

  it('403s a MANAGER on DELETE', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await DELETE(delReq())).status).toBe(403)
    expect(db.calls.deletes).toEqual([])
  })

  it('403s a staff member on PUT at the permission gate', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))).status).toBe(403)
    expect(db.calls.upserts).toEqual([])
  })

  it('a MASTER may link', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(putReq({ server: HOST, auth_key: FRESH_KEY }))
    expect(res.status).toBe(200)
    expect(db.calls.upserts[0].payload.linked_by).toBe('u-master')
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq())).status).toBe(401)
    expect((await DELETE(delReq())).status).toBe(401)
  })
})

describe('DELETE /api/shelly/connection', () => {
  it('deletes only this location\'s row and says the devices are kept', async () => {
    const res = await DELETE(delReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.message).toBe('Disconnected. Your adopted devices are kept; re-link to control them again.')
    expect(db.calls.deletes).toHaveLength(1)
    expect(db.calls.deletes[0].table).toBe('shelly_connections')
    expect(db.calls.deletes[0].filters.location_id).toBe(LOC_A)
  })

  it('is idempotent — disconnecting twice is still a success', async () => {
    expect((await DELETE(delReq())).status).toBe(200)
    expect((await DELETE(delReq())).status).toBe(200)
    expect(db.calls.deletes).toHaveLength(2)
  })

  it('does NOT answer "Disconnected" when the delete failed', async () => {
    useDb({ deleteError: { message: 'db down' } })
    const res = await DELETE(delReq())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
