// STUDIO-PIN.1 — coverage for the PIN hash + verify primitives and
// the findProfileByPin matcher. The format guard, hash round-trip,
// tampering, and per-profile safety cap are the cases that matter.
// PINSCOPE.1 adds who is in the candidate pool: the device studio's
// members, its organisation's org admins and the masters, never the estate.

import { describe, it, expect, vi } from 'vitest'
import {
  isValidPinFormat,
  hashPin,
  verifyPin,
  findProfileByPin,
  pinHoldersInOrgs,
  PinAmbiguousError,
} from './studio-pin'

describe('isValidPinFormat', () => {
  it('accepts exactly 4 digits', () => {
    expect(isValidPinFormat('0000')).toBe(true)
    expect(isValidPinFormat('1234')).toBe(true)
    expect(isValidPinFormat('9999')).toBe(true)
  })

  it('rejects other lengths', () => {
    expect(isValidPinFormat('123')).toBe(false)
    expect(isValidPinFormat('12345')).toBe(false)
    expect(isValidPinFormat('')).toBe(false)
  })

  it('rejects non-digit characters', () => {
    expect(isValidPinFormat('12a4')).toBe(false)
    expect(isValidPinFormat(' 123')).toBe(false)
    expect(isValidPinFormat('12.4')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isValidPinFormat(1234)).toBe(false)
    expect(isValidPinFormat(null)).toBe(false)
    expect(isValidPinFormat(undefined)).toBe(false)
  })
})

describe('hashPin + verifyPin round-trip', () => {
  it('hashes a valid PIN and verifies it back', async () => {
    const hash = await hashPin('4271')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPin('4271', hash)).toBe(true)
  })

  it('produces a different hash each call (fresh salt)', async () => {
    const a = await hashPin('1234')
    const b = await hashPin('1234')
    expect(a).not.toBe(b)
    expect(await verifyPin('1234', a)).toBe(true)
    expect(await verifyPin('1234', b)).toBe(true)
  })

  it('rejects a wrong PIN against a real hash', async () => {
    const hash = await hashPin('4271')
    expect(await verifyPin('4272', hash)).toBe(false)
    expect(await verifyPin('1234', hash)).toBe(false)
    expect(await verifyPin('0000', hash)).toBe(false)
  })

  it('throws on malformed PIN to hash', async () => {
    await expect(hashPin('123')).rejects.toThrow(/4 digits/)
    await expect(hashPin('12a4')).rejects.toThrow(/4 digits/)
    await expect(hashPin('')).rejects.toThrow(/4 digits/)
  })
})

describe('verifyPin malformed input', () => {
  it('returns false on malformed PIN', async () => {
    const hash = await hashPin('1111')
    expect(await verifyPin('abc', hash)).toBe(false)
    expect(await verifyPin('', hash)).toBe(false)
    expect(await verifyPin(null, hash)).toBe(false)
  })

  it('returns false on malformed hash', async () => {
    expect(await verifyPin('1111', '')).toBe(false)
    expect(await verifyPin('1111', 'plain-text')).toBe(false)
    expect(await verifyPin('1111', 'scrypt$nothex$alsonothex')).toBe(false)
    expect(await verifyPin('1111', 'scrypt$00$00')).toBe(false) // wrong lengths
    expect(await verifyPin('1111', 'bcrypt$abc$def')).toBe(false) // wrong algo tag
  })

  it('returns false on tampered hash', async () => {
    const hash = await hashPin('1111')
    // Flip a byte in the derived key.
    const parts = hash.split('$')
    const dk = Buffer.from(parts[2], 'hex')
    dk[0] = dk[0] ^ 0x01
    const tampered = `scrypt$${parts[1]}$${dk.toString('hex')}`
    expect(await verifyPin('1111', tampered)).toBe(false)
  })
})

// PINSCOPE.1 — a small table-aware fake: the candidate pool is built from
// profile_locations (members), profile_organizations (org admins) and
// profiles (masters), so the fake applies the filters that decide WHO is in
// the pool. The embed-level pin/active filters are re-applied by the lib.
function buildWorld({ profiles = [], memberships = [], orgAdmins = [], locations = [], errors = {} }) {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const orgOf = new Map(locations.map((l) => [l.id, l.organization_id]))
  const calls = []
  function rowsFor(table, f) {
    if (table === 'locations') {
      const l = locations.find((x) => x.id === f.eq.id)
      return l ? { organization_id: l.organization_id } : null
    }
    if (table === 'profiles') {
      return profiles.filter((p) => (f.eq.role ? p.role === f.eq.role : true))
    }
    if (table === 'profile_locations') {
      return memberships
        .filter((m) => (f.eq.location_id ? m.location_id === f.eq.location_id : true))
        .filter((m) => (f.in['locations.organization_id']
          ? f.in['locations.organization_id'].includes(orgOf.get(m.location_id))
          : true))
        .map((m) => ({ profiles: byId.get(m.profile_id), locations: { organization_id: orgOf.get(m.location_id) } }))
        .filter((r) => r.profiles)
    }
    if (table === 'profile_organizations') {
      return orgAdmins
        .filter((g) => (f.eq.organization_id ? g.organization_id === f.eq.organization_id : true))
        .filter((g) => (f.in.organization_id ? f.in.organization_id.includes(g.organization_id) : true))
        .filter((g) => (f.eq.role ? g.role === f.eq.role : true))
        .map((g) => ({ profiles: byId.get(g.profile_id) }))
        .filter((r) => r.profiles)
    }
    throw new Error(`unexpected table ${table}`)
  }
  const db = {
    from(table) {
      calls.push(table)
      const f = { eq: {}, in: {} }
      const result = () => (errors[table]
        ? { data: null, error: { message: errors[table] } }
        : { data: rowsFor(table, f), error: null })
      const b = {
        select() { return b },
        not() { return b },
        eq(col, v) { f.eq[col] = v; return b },
        in(col, v) { f.in[col] = v; return b },
        limit() { return Promise.resolve(result()) },
        maybeSingle() { return Promise.resolve(result()) },
      }
      return b
    },
  }
  return { db, calls }
}

const LOC_A = 'loc-a'
const LOC_A2 = 'loc-a2'
const LOC_B = 'loc-b'
const LOCATIONS = [
  { id: LOC_A, organization_id: 'org-a' },
  { id: LOC_A2, organization_id: 'org-a' },
  { id: LOC_B, organization_id: 'org-b' },
]

describe('findProfileByPin', () => {
  it('returns null when nobody at the studio has a PIN set', async () => {
    const { db } = buildWorld({ locations: LOCATIONS })
    expect(await findProfileByPin({ db, pin: '1234', locationId: LOC_A })).toBeNull()
  })

  it('returns the member at the device studio whose PIN matches', async () => {
    const hash = await hashPin('4271')
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [{ id: 'p1', full_name: 'Alice', pin_hash: hash, active: true, role: 'staff' }],
      memberships: [{ profile_id: 'p1', location_id: LOC_A }],
    })
    expect(await findProfileByPin({ db, pin: '4271', locationId: LOC_A }))
      .toEqual({ id: 'p1', full_name: 'Alice' })
  })

  it('never matches someone with no membership at the device studio (cross-tenant)', async () => {
    const hash = await hashPin('4271')
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [{ id: 'a-staff', full_name: 'Org A staffer', pin_hash: hash, active: true, role: 'staff' }],
      memberships: [{ profile_id: 'a-staff', location_id: LOC_A }],
    })
    // Org B's paired device, org A's PIN.
    expect(await findProfileByPin({ db, pin: '4271', locationId: LOC_B })).toBeNull()
  })

  it("matches an org admin of the studio's organisation without a membership there", async () => {
    const hash = await hashPin('5555')
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [{ id: 'oa', full_name: 'Org admin', pin_hash: hash, active: true, role: 'owner' }],
      orgAdmins: [{ profile_id: 'oa', organization_id: 'org-a', role: 'org_admin' }],
    })
    expect(await findProfileByPin({ db, pin: '5555', locationId: LOC_A2 })).toEqual({ id: 'oa', full_name: 'Org admin' })
    expect(await findProfileByPin({ db, pin: '5555', locationId: LOC_B })).toBeNull()
  })

  it('matches the master at any studio', async () => {
    const hash = await hashPin('9090')
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [{ id: 'm', full_name: 'Master', pin_hash: hash, active: true, role: 'master' }],
    })
    expect(await findProfileByPin({ db, pin: '9090', locationId: LOC_B })).toEqual({ id: 'm', full_name: 'Master' })
  })

  it('ignores inactive members', async () => {
    const hash = await hashPin('4271')
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [{ id: 'gone', full_name: 'Gone', pin_hash: hash, active: false, role: 'staff' }],
      memberships: [{ profile_id: 'gone', location_id: LOC_A }],
    })
    expect(await findProfileByPin({ db, pin: '4271', locationId: LOC_A })).toBeNull()
  })

  it('iterates all candidates and finds the right one', async () => {
    const [aHash, bHash, cHash] = await Promise.all([hashPin('1111'), hashPin('2222'), hashPin('3333')])
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [
        { id: 'a', full_name: 'A', pin_hash: aHash, active: true, role: 'staff' },
        { id: 'b', full_name: 'B', pin_hash: bHash, active: true, role: 'staff' },
        { id: 'c', full_name: 'C', pin_hash: cHash, active: true, role: 'staff' },
      ],
      memberships: ['a', 'b', 'c'].map((id) => ({ profile_id: id, location_id: LOC_A })),
    })
    expect(await findProfileByPin({ db, pin: '2222', locationId: LOC_A })).toEqual({ id: 'b', full_name: 'B' })
  })

  it('refuses a PIN two candidates share rather than picking by row order', async () => {
    const [h1, h2] = await Promise.all([hashPin('7777'), hashPin('7777')])
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [
        { id: 'x', full_name: 'X', pin_hash: h1, active: true, role: 'staff' },
        { id: 'm', full_name: 'M', pin_hash: h2, active: true, role: 'master' },
      ],
      memberships: [{ profile_id: 'x', location_id: LOC_A }],
    })
    await expect(findProfileByPin({ db, pin: '7777', locationId: LOC_A })).rejects.toBeInstanceOf(PinAmbiguousError)
  })

  it('counts a member who is also an org admin once', async () => {
    const hash = await hashPin('4444')
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles: [{ id: 'both', full_name: 'Both', pin_hash: hash, active: true, role: 'owner' }],
      memberships: [{ profile_id: 'both', location_id: LOC_A }],
      orgAdmins: [{ profile_id: 'both', organization_id: 'org-a', role: 'org_admin' }],
    })
    expect(await findProfileByPin({ db, pin: '4444', locationId: LOC_A })).toEqual({ id: 'both', full_name: 'Both' })
  })

  it('returns null on malformed PIN without touching the db', async () => {
    const { db, calls } = buildWorld({ locations: LOCATIONS })
    expect(await findProfileByPin({ db, pin: 'abc', locationId: LOC_A })).toBeNull()
    expect(calls).toEqual([])
  })

  it('requires the device location (no estate-wide scan)', async () => {
    const { db } = buildWorld({ locations: LOCATIONS })
    await expect(findProfileByPin({ db, pin: '1111' })).rejects.toThrow(/locationId is required/)
  })

  it('throws when more candidates than safetyCap have PINs (misconfig signal)', async () => {
    const hash = await hashPin('1111')
    const profiles = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`, full_name: `P${i}`, pin_hash: hash, active: true, role: 'staff',
    }))
    const { db } = buildWorld({
      locations: LOCATIONS,
      profiles,
      memberships: profiles.map((p) => ({ profile_id: p.id, location_id: LOC_A })),
    })
    await expect(findProfileByPin({ db, pin: '1111', locationId: LOC_A, safetyCap: 2 }))
      .rejects.toThrow(/more than 2 profiles/)
  })

  it('surfaces db errors', async () => {
    const { db } = buildWorld({ locations: LOCATIONS, errors: { profile_locations: 'db down' } })
    await expect(findProfileByPin({ db, pin: '1111', locationId: LOC_A })).rejects.toThrow('db down')
  })
})

describe('pinHoldersInOrgs (set-pin uniqueness pool)', () => {
  const world = async () => {
    const hash = await hashPin('1234')
    return buildWorld({
      locations: LOCATIONS,
      profiles: [
        { id: 'a1', full_name: 'A1', pin_hash: hash, active: true, role: 'staff' },
        { id: 'b1', full_name: 'B1', pin_hash: hash, active: true, role: 'staff' },
        { id: 'oa', full_name: 'OA', pin_hash: hash, active: true, role: 'owner' },
        { id: 'm', full_name: 'M', pin_hash: hash, active: true, role: 'master' },
      ],
      memberships: [
        { profile_id: 'a1', location_id: LOC_A2 },
        { profile_id: 'b1', location_id: LOC_B },
      ],
      orgAdmins: [{ profile_id: 'oa', organization_id: 'org-a', role: 'org_admin' }],
    })
  }

  it("holds everyone who can work anywhere in the caller's organisations, plus masters", async () => {
    const { db } = await world()
    const ids = (await pinHoldersInOrgs({ db, orgIds: ['org-a'] })).map((p) => p.id).sort()
    expect(ids).toEqual(['a1', 'm', 'oa'])
  })

  it("leaves out another organisation's staff", async () => {
    const { db } = await world()
    const ids = (await pinHoldersInOrgs({ db, orgIds: ['org-b'] })).map((p) => p.id).sort()
    expect(ids).toEqual(['b1', 'm'])
  })

  it('with no organisation, only the masters', async () => {
    const { db } = await world()
    const ids = (await pinHoldersInOrgs({ db, orgIds: [] })).map((p) => p.id)
    expect(ids).toEqual(['m'])
  })
})
