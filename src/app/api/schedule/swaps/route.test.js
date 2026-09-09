// ROSTER-FIX.2 — contract tests for POST /api/schedule/swaps.
//
// The target side of a swap used to be inserted unchecked: any
// shift_assignments.id in the database could be named as target_shift_id
// and, on approval, reassigned to the requester. These lock the target
// ownership / location / date checks, the D1 published gate on the
// requester's own shift, and one-open-swap-per-shift.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/push-dedup', () => ({
  sendPushOnce: vi.fn(() => Promise.resolve()),
  sendPushToRolesAtLocationOnce: vi.fn(() => Promise.resolve()),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')

// UUID-shaped ids. `uuidLike` is hex-only (src/lib/uuid-shape.js), so the
// mnemonic prefix has to be hex too or Zod rejects the body before the
// route logic runs.
const U = (hex) => `${hex.padEnd(8, '0')}-0000-4000-8000-000000000000`
const REQ = U('11111111')
const TGT = U('22222222')
const A_REQ = U('aaaaaaaa')
const A_TGT = U('bbbbbbbb')
const LOC = U('cccccccc')
const LOC2 = U('dddddddd')
const OTHER = U('eeeeeeee')

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// assignmentsById: id → { id, profile_id, status, block_date, location_id, roster_status? }
function buildDb({ assignmentsById, openSwaps = [], insertErr = null }) {
  const insertSpy = vi.fn()
  const db = {
    from: (table) => {
      if (table === 'shift_assignments') {
        return {
          select: () => {
            const chain = { _id: null, _profile: null }
            chain.eq = (col, val) => {
              if (col === 'id') chain._id = val
              if (col === 'profile_id') chain._profile = val
              return chain
            }
            chain.single = () => {
              const a = assignmentsById[chain._id]
              const ok = a && (!chain._profile || a.profile_id === chain._profile)
              return Promise.resolve({
                data: ok
                  ? {
                    id: a.id,
                    profile_id: a.profile_id,
                    status: a.status,
                    shift_blocks: {
                      location_id: a.location_id,
                      block_date: a.block_date,
                      rosters: { status: a.roster_status ?? 'published' },
                    },
                  }
                  : null,
                error: ok ? null : { message: 'no' },
              })
            }
            chain.maybeSingle = chain.single
            return chain
          },
        }
      }
      if (table === 'shift_swap_requests') {
        return {
          select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: openSwaps, error: null }) }) }),
          insert: (row) => {
            insertSpy(row)
            return {
              select: () => ({
                single: () => Promise.resolve({
                  data: insertErr ? null : { id: 'swap-1', ...row },
                  error: insertErr,
                }),
              }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, insertSpy }
}

const future = '2099-01-01'
const base = {
  [A_REQ]: { id: A_REQ, profile_id: REQ, status: 'scheduled', location_id: LOC, block_date: future },
  [A_TGT]: { id: A_TGT, profile_id: TGT, status: 'scheduled', location_id: LOC, block_date: future },
}

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('POST /api/schedule/swaps — target validation', () => {
  it('201 for a valid reciprocal swap', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: TGT }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('400 when target_shift_id does not belong to target_id', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: OTHER }))
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 when target_shift_id is given without target_id', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT }))
    expect(res.status).toBe(400)
  })

  it('400 when the target shift is at another location', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: { ...base, [A_TGT]: { ...base[A_TGT], location_id: LOC2 } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: TGT }))
    expect(res.status).toBe(400)
  })

  it('400 when the requester shift is not published (D1 — coaches cannot act on drafts)', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: { ...base, [A_REQ]: { ...base[A_REQ], roster_status: 'draft' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(400)
  })

  it('400 when the requester shift is in the past', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: { ...base, [A_REQ]: { ...base[A_REQ], block_date: '2000-01-01' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(400)
  })

  it('400 when the requester shift is cancelled', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: { ...base, [A_REQ]: { ...base[A_REQ], status: 'cancelled' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(400)
  })

  it('409 when the requester shift already has an open swap', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base, openSwaps: [{ id: 'existing' }] })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(409)
  })

  it('409 when the insert trips the one-open-swap unique index', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base, insertErr: { code: '23505', message: 'dupe' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(409)
  })
})
