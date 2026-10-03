// LOCFIX-ROLEGATE.1 — POST /api/locations/[id]/channels creates a channel
// connection (Instagram / Messenger creds, incl. an access token and an app
// secret) on the PATH-PARAM location.
//
// THE GATE IS THE POINT. The old gate was ONE boolean —
//   user.role === 'master' || (MANAGER_ROLES.includes(user.role) && member)
// — and `user.role` resolves at the caller's ACTIVE location (with auth.js's
// highest-role-anywhere fallback). So a manager at studio A who is plain
// STAFF at studio B could POST /api/locations/<B>/channels and attach their
// own Instagram account to B, taking over B's DMs, with a 200. The boolean is
// now split into the two questions it was conflating: membership
// (assertLocationAccess) and the role AT THE TARGET (hasRoleAtLocation +
// MANAGER_ROLES).
//
// The membership half therefore now answers assertLocationAccess's own copy
// ("Forbidden — location not in your assignments") instead of the generic
// "Forbidden" — an intended, more informative change, pinned below.
//
// TIER A: MANAGER_ROLES INCLUDES head_coach — pinned, and deliberately
// different from the stripe-connect routes' ['master','owner','manager'].
//
// Every refusal asserts NO WRITE HAPPENED, not merely the status code.
// @/lib/auth is REAL (importActual) with only getCurrentUser mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const MANAGER_A = {
  id: 'u1', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — manager at the ACTIVE studio, plain staff at the target.
const MANAGER_A_STAFF_B = {
  id: 'u2', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
// The mirror image — the target's real manager, active studio elsewhere.
const STAFF_A_MANAGER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'manager' },
  activeLocation: { id: LOC_A },
}
const STAFF_A_HEAD_COACH_B = {
  id: 'u4', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'head_coach' },
  activeLocation: { id: LOC_A },
}
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}
const STAFF_A = {
  id: 'u6', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'staff' },
  activeLocation: { id: LOC_A },
}

// The route's shapes against channel_connections, modelled honestly:
//   POST .insert(row).select().single()          → echoes the inserted row
//        (or `insertError`; CHANNELREAD.1 removed the one-active sweep)
//   GET  .select('*').eq('location_id').order().order()
// Echoing the inserted row back means pinning the success BODY also pins the
// WRITE. Fail LOUD on any other table or any other chain.
function makeDb({ rows = [], insertError = null } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      if (table !== 'channel_connections') throw new Error(`unexpected db.from('${table}') in channels test`)
      return {
        update(patch) {
          const filters = {}
          const builder = {
            eq(col, val) { filters[col] = val; return builder },
            then: (res, rej) => {
              writes.push({ op: 'update', patch, filters })
              return Promise.resolve({ data: null, error: null }).then(res, rej)
            },
          }
          return builder
        },
        insert(row) {
          writes.push({ op: 'insert', row })
          return {
            select: () => ({
              single: () => Promise.resolve(insertError
                ? { data: null, error: insertError }
                : { data: { id: 'conn-1', ...row }, error: null }),
            }),
          }
        },
        select() {
          let out = rows
          const builder = {
            eq(col, val) {
              if (col !== 'location_id') throw new Error(`unexpected .eq('${col}') in channels GET`)
              out = out.filter(r => r.location_id === val)
              return builder
            },
            order: () => builder,
            then: (res, rej) => Promise.resolve({ data: out, error: null }).then(res, rej),
          }
          return builder
        },
      }
    },
  }
}

const props = (id) => ({ params: { id } })
const post = (id, body) => new Request(`http://localhost/api/locations/${id}/channels`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/channels`)

const VALID = { platform: 'instagram', label: 'Studio IG', access_token: 'IGTOKENabcdef123456' }

// The exact body the channels card parses today — the masked shape, pinned as
// a literal rather than rebuilt from maskConnectionRow, so a change to the
// shape is a diff here and not a silently re-derived expectation.
const successBody = (locationId, updatedBy) => ({
  success: true,
  connection: {
    id: 'conn-1',
    location_id: locationId,
    updated_by: updatedBy,
    platform: 'instagram',
    label: 'Studio IG',
    is_active: true,
    token_expires_at: null,
    token_refreshed_at: null,
    access_token: '••••••',
    has_access_token: true,
    app_secret: null,
    has_app_secret: false,
  },
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MANAGER_A)
})

describe('POST /api/locations/[id]/channels — the legitimate flow is byte-identical', () => {
  it('a manager connecting their own studio gets exactly the masked body they always did', async () => {
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_A, 'u1'))
  })

  // CHANNELREAD.1 — POST used to deactivate the live row and insert the new
  // one, so a card that wrongly believed nothing was connected (a failed
  // read) REPLACED a working connection. It now only inserts; the partial
  // unique index refuses a second active row (next describe).
  it('inserts against the target location and never deactivates a live row', async () => {
    await POST(post(LOC_A, VALID), props(LOC_A))
    expect(db.writes.map(w => w.op)).toEqual(['insert'])
    expect(db.writes[0].row.location_id).toBe(LOC_A)
    expect(db.writes[0].row.updated_by).toBe('u1')
    expect(db.writes[0].row.is_active).toBe(true)
  })

  it('400s an unsupported platform without writing (unchanged)', async () => {
    const res = await POST(post(LOC_A, { platform: 'tiktok' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })
})

describe('POST /api/locations/[id]/channels — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses a manager-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden')
    expect(db.writes).toEqual([])
  })

  it('(b) lets the MANAGER AT THE TARGET through, byte-identical, with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u3'))
    expect(db.writes[0].row.location_id).toBe(LOC_B)
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u5'))
  })

  // The intended copy change: the membership half now answers
  // assertLocationAccess's own message instead of the generic "Forbidden".
  it('(d) 403s a non-member on the MEMBERSHIP copy, not the generic Forbidden', async () => {
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden — location not in your assignments')
    expect(db.writes).toEqual([])
  })

  it('(e) 401s an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(401)
    expect(db.writes).toEqual([])
  })

  it('(f) TIER A: a HEAD COACH at the target succeeds — head_coach is in MANAGER_ROLES', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u4'))
  })

  it('403s plain staff at their OWN studio on the ROLE copy, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden')
    expect(db.writes).toEqual([])
  })

  it('the gate answers before validation — a refused caller learns nothing about the schema', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, { nonsense: true }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })
})

describe('POST /api/locations/[id]/channels — refuses over a live connection (CHANNELREAD.1)', () => {
  it('409s already_connected when an active row exists, having written nothing else', async () => {
    db = makeDb({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "idx_channel_connections_one_active"' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('already_connected')
    // The card reloads itself and switches to Update, so the copy never
    // asks the operator to reload.
    expect(body.error).toBe('This location already has an Instagram connection. Use Update to change its token.')
    // The only write attempted is the refused insert: no deactivation.
    expect(db.writes.map(w => w.op)).toEqual(['insert'])
  })

  it('a 23505 on the index named only in details still 409s', async () => {
    db = makeDb({ insertError: { code: '23505', message: 'duplicate key', details: 'Key (location_id, platform)=(x, instagram) already exists. idx_channel_connections_one_active' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(409)
  })

  it('a 23505 from any OTHER unique constraint is a 500, never already_connected', async () => {
    db = makeDb({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "channel_connections_pkey"' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBeUndefined()
  })

  it('a bare 23505 that names no index is a 500', async () => {
    db = makeDb({ insertError: { code: '23505', message: 'duplicate key' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(500)
  })

  it('any other insert failure is still a 500', async () => {
    db = makeDb({ insertError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(500)
  })

  it('an explicitly inactive row can still be added beside a live one (no index conflict)', async () => {
    const res = await POST(post(LOC_A, { ...VALID, is_active: false }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.writes[0].row.is_active).toBe(false)
  })
})

// SECFIX.3a (review S1) — the read side used to be MEMBERSHIP ONLY with a
// mask that kept the last 6 characters of access_token / app_secret and left
// `config` alone, where the registry keeps a Glofox connection's api_token. So
// any plain staff member of a studio could read its Glofox API token in
// clear. The GET now uses the write gate (the role AT THE TARGET, MANAGER_ROLES:
// whoever may replace a token may see that it is set; the Integrations cards
// that call this are owner/master screens), and every secret, at any depth,
// is presence only.
const SYNTH_ROWS = [
  {
    id: 'c1', location_id: LOC_A, platform: 'instagram', display_name: '@studio',
    access_token: 'SYNTH-IG-TOKEN-abcdef123456', app_secret: 'SYNTH-IG-APPSECRET-654321', config: {},
  },
  {
    id: 'c3', location_id: LOC_A, platform: 'glofox', external_account_id: 'branch-1',
    access_token: 'SYNTH-GLOFOX-KEY-111111', app_secret: 'SYNTH-GLOFOX-WEBHOOK-222222',
    config: { api_token: 'SYNTH-GLOFOX-TOKEN-333333', namespace: 'ns-1' },
  },
  { id: 'c2', location_id: LOC_B, platform: 'instagram', access_token: 'SYNTH-OTHERSTUDIO' },
]
const NO_SYNTH = /SYNTH|abcdef|123456|654321|111111|222222|333333/

describe('GET /api/locations/[id]/channels — managers at the target only, every secret presence-only', () => {
  it('a manager at the target lists it: tokens and config.api_token masked, no character of any value', async () => {
    createServerClient.mockReturnValue(makeDb({ rows: SYNTH_ROWS }))
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(NO_SYNTH)
    const body = JSON.parse(text)
    expect(body.connections.map(c => c.id)).toEqual(['c1', 'c3'])
    const [ig, glofox] = body.connections
    expect(ig.access_token).toBe('••••••')
    expect(ig.has_access_token).toBe(true)
    expect(ig.app_secret).toBe('••••••')
    expect(ig.display_name).toBe('@studio')
    expect(glofox.config).toEqual({ api_token: '••••••', namespace: 'ns-1' })
    expect(glofox.has_access_token).toBe(true)
  })

  it('a plain STAFF member of the target is refused on the role copy, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    const guarded = makeDb({ rows: SYNTH_ROWS })
    guarded.from = () => { throw new Error('the DB must not be read for a refused caller') }
    createServerClient.mockReturnValue(guarded)
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).not.toMatch(NO_SYNTH)
    expect(JSON.parse(text)).toEqual({ success: false, error: 'Forbidden' })
  })

  it('a manager at A who is plain staff at B is refused at B', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    createServerClient.mockReturnValue(makeDb({ rows: SYNTH_ROWS }))
    expect((await GET(get(LOC_B), props(LOC_B))).status).toBe(403)
  })

  it('the manager / head coach AT THE TARGET and a master get through', async () => {
    for (const u of [STAFF_A_MANAGER_B, STAFF_A_HEAD_COACH_B, MASTER]) {
      getCurrentUser.mockResolvedValue(u)
      createServerClient.mockReturnValue(makeDb({ rows: SYNTH_ROWS }))
      const res = await GET(get(LOC_B), props(LOC_B))
      expect([u.id, res.status]).toEqual([u.id, 200])
      expect(await res.text()).not.toMatch(NO_SYNTH)
    }
  })

  it('403s a non-member on the MEMBERSHIP copy and 401s an anonymous caller', async () => {
    const res = await GET(get(LOC_B), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden — location not in your assignments')
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(401)
  })
})

describe('POST /api/locations/[id]/channels — the echo is presence-only', () => {
  it('a freshly pasted token comes back as the mask, never a character of it', async () => {
    const res = await POST(post(LOC_A, { ...VALID, access_token: 'SYNTH-NEW-TOKEN-987654', app_secret: 'SYNTH-NEW-SECRET-456789' }), props(LOC_A))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/SYNTH|987654|456789/)
    expect(JSON.parse(text).connection).toMatchObject({ access_token: '••••••', has_access_token: true, app_secret: '••••••', has_app_secret: true })
  })
})

// MIANITS (Richard's call, 30 Sep) — Mia's on/off switch for a channel
// (agent_enabled) is OWNER-ONLY, like Mia's settings: canEditMiaSettings at
// the target (owner there, or a master). Only that field is gated; managers
// and head coaches still connect channels as before. agent_enabled defaults
// to false (mig 407), so a create that leaves Mia off changes nothing.
describe('POST /api/locations/[id]/channels — Mia on at create is owner-only (MIANITS)', () => {
  const OWNER_A = {
    id: 'u7', role: 'owner', profileRole: 'owner', isMaster: false,
    locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
    activeLocation: { id: LOC_A },
  }

  it('a manager creating a connection with agent_enabled true is refused, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await POST(post(LOC_A, { ...VALID, agent_enabled: true }), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/Only an owner/)
    expect(db.writes).toEqual([])
  })

  it('a head coach at the target is refused too', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await POST(post(LOC_B, { ...VALID, agent_enabled: true }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })

  it('an owner at the target may switch Mia on at create', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const res = await POST(post(LOC_A, { ...VALID, agent_enabled: true }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.writes[0].row.agent_enabled).toBe(true)
  })

  it('a master may too', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(post(LOC_B, { ...VALID, agent_enabled: true }), props(LOC_B))
    expect(res.status).toBe(200)
  })

  it('a manager connecting with Mia left off (false or omitted) is still allowed', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await POST(post(LOC_A, { ...VALID, agent_enabled: false }), props(LOC_A))).status).toBe(200)
    expect((await POST(post(LOC_A, VALID), props(LOC_A))).status).toBe(200)
  })
})

// MIANITS — the card greys out Mia's per-channel switch for anyone the PATCH
// would refuse, so the GET says whether this caller may flip it: the same
// canEditMiaSettings predicate the writes gate on.
describe('GET /api/locations/[id]/channels — can_edit_agent (MIANITS)', () => {
  const OWNER_A = {
    id: 'u7', role: 'owner', profileRole: 'owner', isMaster: false,
    locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
    activeLocation: { id: LOC_A },
  }
  const flagFor = async (user, loc) => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(makeDb({ rows: [] }))
    return (await (await GET(get(loc), props(loc))).json()).can_edit_agent
  }

  it('is true for an owner at the target and for a master', async () => {
    expect(await flagFor(OWNER_A, LOC_A)).toBe(true)
    expect(await flagFor(MASTER, LOC_B)).toBe(true)
  })

  it('is false for a manager or a head coach at the target', async () => {
    expect(await flagFor(MANAGER_A, LOC_A)).toBe(false)
    expect(await flagFor(STAFF_A_HEAD_COACH_B, LOC_B)).toBe(false)
  })
})
