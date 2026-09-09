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
  notifyUsersOnce: vi.fn(() => Promise.resolve()),
  notifyUsersAtRolesOnce: vi.fn(() => Promise.resolve()),
}))

// ROSTER-FIX.8f — the open-pool fan-out now subtracts the managers who were
// already told, resolving them with the same helper notifyUsersAtRolesOnce uses.
vi.mock('@/lib/push', () => ({
  resolveRoleRecipientIds: vi.fn(() => Promise.resolve([])),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('@/lib/push-dedup')
const { resolveRoleRecipientIds } = await import('@/lib/push')
const { MANAGER_ROLES } = await import('@/lib/schemas')
const { POST } = await import('./route.js')

// The notification fan-out is fire-and-forget (never blocks the response) and
// the open-pool leg awaits a query first, so a test has to let the
// microtask queue drain before asserting on the spies.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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
// poolRows / poolError back the ROSTER-FIX.8d open-pool recipient query
// (every live assignment at the location on that date).
function buildDb({ assignmentsById, openSwaps = [], openSwapsError = null, insertErr = null, poolRows = [], poolError = null }) {
  const insertSpy = vi.fn()
  const poolFilters = []
  const db = {
    from: (table) => {
      if (table === 'shift_assignments') {
        return {
          select: () => {
            const chain = { _id: null, _profile: null }
            chain.eq = (col, val) => {
              if (col === 'id') chain._id = val
              if (col === 'profile_id') chain._profile = val
              if (col.startsWith('shift_blocks.')) poolFilters.push([col, val])
              return chain
            }
            // Awaiting the chain itself (no .single()) is the open-pool read.
            chain.then = (onFulfilled, onRejected) => Promise.resolve(
              poolError ? { data: null, error: poolError } : { data: poolRows, error: null },
            ).then(onFulfilled, onRejected)
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
          select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: openSwapsError ? null : openSwaps, error: openSwapsError }) }) }),
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
  return { db, insertSpy, poolFilters }
}

const future = '2099-01-01'
const base = {
  [A_REQ]: { id: A_REQ, profile_id: REQ, status: 'scheduled', location_id: LOC, block_date: future },
  [A_TGT]: { id: A_TGT, profile_id: TGT, status: 'scheduled', location_id: LOC, block_date: future },
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  notifyUsersOnce.mockClear()
  notifyUsersAtRolesOnce.mockClear()
  resolveRoleRecipientIds.mockReset()
  resolveRoleRecipientIds.mockResolvedValue([])
})

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

  it('400 when the target shift sits on a draft roster', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: { ...base, [A_TGT]: { ...base[A_TGT], roster_status: 'draft' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: TGT }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Target shift is not published yet' })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 when the target shift is in the past', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: { ...base, [A_TGT]: { ...base[A_TGT], block_date: '2000-01-01' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_shift_id: A_TGT, target_id: TGT }))
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 when the caller targets themselves', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ, target_id: REQ }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'You cannot target yourself' })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('500 (no insert) when the open-swap guard query fails', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, insertSpy } = buildDb({ assignmentsById: base, openSwapsError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(500)
    expect(insertSpy).not.toHaveBeenCalled()
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

// ROSTER-FIX.8d — a swap notification that only ever went out as a push
// reached nobody without the app installed. These pin the switch to
// notifyUsersOnce / notifyUsersAtRolesOnce (push + registry-gated email
// fallback, the shape time-off already uses) and the open-pool fan-out.
describe('POST /api/schedule/swaps — notifications', () => {
  const COACH_A = U('0a0a0a0a')
  const COACH_B = U('0b0b0b0b')
  const COACH_DRAFT = U('0c0c0c0c')

  // ROSTER-FIX.8e — the embed the route reads carries the roster status, so
  // the fixture rows carry it too.
  const onRoster = (status) => ({ rosters: { status } })

  // Every row the location/date query returns, in the shape the embed gives.
  const pool = [
    { profile_id: COACH_A, status: 'scheduled', shift_blocks: onRoster('published') },
    { profile_id: COACH_B, status: 'confirmed', shift_blocks: onRoster('published') },
    // the requester's own shift — the one that is up for swap
    { profile_id: REQ, status: 'scheduled', shift_blocks: onRoster('published') },
    // a tombstone and a duplicate: neither may reach a recipient list
    { profile_id: TGT, status: 'cancelled', shift_blocks: onRoster('published') },
    { profile_id: COACH_A, status: 'scheduled', shift_blocks: onRoster('published') },
    // ROSTER-FIX.8e — D1: rostered, but on a roster nobody has published.
    { profile_id: COACH_DRAFT, status: 'scheduled', shift_blocks: onRoster('draft') },
  ]

  it('notifies a named target with an email fallback, not a bare push', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ, target_id: TGT }))
    expect(res.status).toBe(201)
    await flush()

    expect(notifyUsersOnce).toHaveBeenCalled()
    const [, key, ids, payload] = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_inbound:'))
    expect(key).toBe('swap_inbound:swap-1')
    expect(ids).toEqual([TGT])
    expect(payload.category).toBe('swap')
    expect(payload.emailSubject).toBeTruthy()
  })

  it('notifies managers of an open swap through the email-fallback sender', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base, poolRows: pool })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(201)
    await flush()

    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    const [, key, locationId, roles, payload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(key).toBe('swap_open:swap-1')
    expect(locationId).toBe(LOC)
    expect(roles).toContain('manager')
    expect(payload.category).toBe('swap')
    expect(payload.emailSubject).toBeTruthy()
  })

  it('notifies the eligible coaches on that date, never the requester', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db, poolFilters } = buildDb({ assignmentsById: base, poolRows: pool })
    createServerClient.mockReturnValue(db)

    await POST(req({ requester_shift_id: A_REQ }))
    await flush()

    // scoped to the swap's own location and date
    expect(poolFilters).toEqual(
      expect.arrayContaining([
        ['shift_blocks.location_id', LOC],
        ['shift_blocks.block_date', future],
      ]),
    )

    const call = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_open_pool:'))
    expect(call).toBeTruthy()
    const [, key, ids, payload] = call
    expect(key).toBe('swap_open_pool:swap-1')
    // deduped, tombstone dropped, requester excluded
    expect([...ids].sort()).toEqual([COACH_A, COACH_B].sort())
    expect(ids).not.toContain(REQ)
    expect(ids).not.toContain(TGT)
    expect(payload.category).toBe('swap')
    expect(payload.emailSubject).toBeTruthy()
  })

  // ROSTER-FIX.8e — the open-pool push is the one surface that could tell a
  // coach they are rostered before anyone published the roster. D1 says it
  // must not, so a draft-rostered coach is not a recipient even though they
  // are on the same location and date as the swap.
  it('excludes a coach whose only shift that day is on a draft roster', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base, poolRows: pool })
    createServerClient.mockReturnValue(db)

    await POST(req({ requester_shift_id: A_REQ }))
    await flush()

    const [, , ids] = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_open_pool:'))
    expect(ids).not.toContain(COACH_DRAFT)
    expect([...ids].sort()).toEqual([COACH_A, COACH_B].sort())
  })

  it('still answers 201 and still tells managers when the pool query fails', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base, poolError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(201)
    await flush()

    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce.mock.calls.filter(c => c[1].startsWith('swap_open_pool:'))).toHaveLength(0)
  })

  it('does not run the open-pool fan-out for a targeted swap', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    const { db } = buildDb({ assignmentsById: base, poolRows: pool })
    createServerClient.mockReturnValue(db)

    await POST(req({ requester_shift_id: A_REQ, target_id: TGT }))
    await flush()

    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    expect(notifyUsersOnce.mock.calls.filter(c => c[1].startsWith('swap_open_pool:'))).toHaveLength(0)
  })
})

// ROSTER-FIX.8f — review fixes on the notification copy and the pool set.
describe('POST /api/schedule/swaps — notification recipients and copy', () => {
  const COACH_A = U('0a0a0a0a')
  const HEAD_COACH = U('0d0d0d0d')
  const onRoster = (status) => ({ rosters: { status } })

  // full_name is nullable on profiles. Before this fix the coach's name was
  // interpolated bare, so a blank one shipped the literal string "null" to a
  // lock screen and an email subject line.
  it('falls back to "A coach" when the requester has no full_name', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: null })
    const { db } = buildDb({ assignmentsById: base })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ, target_id: TGT }))
    expect(res.status).toBe(201)
    await flush()

    const [, , , payload] = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_inbound:'))
    expect(payload.body).toBe('A coach wants to swap a shift with you. Tap to review.')
    expect(payload.emailSubject).toBe('A coach wants to swap a shift with you')
    expect(payload.body).not.toContain('null')
  })

  it('falls back to "A coach" for the manager and open-pool copy too', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: '' })
    const { db } = buildDb({
      assignmentsById: base,
      poolRows: [{ profile_id: COACH_A, status: 'scheduled', shift_blocks: onRoster('published') }],
    })
    createServerClient.mockReturnValue(db)

    await POST(req({ requester_shift_id: A_REQ }))
    await flush()

    const [, , , , managerPayload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(managerPayload.body).toBe('A coach posted a shift for swap. Tap to review.')

    const [, , , poolPayload] = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_open_pool:'))
    expect(poolPayload.body).toBe('A coach posted a shift for swap on a day you are working. Tap to take it.')
  })

  // A manager rostered that day matched BOTH fan-outs, and the dedup ledger is
  // keyed per event, so swap_open and swap_open_pool could not see each other:
  // two notifications for one swap, the second inviting them to claim a shift
  // they are there to approve.
  it('excludes a head coach rostered that day — they already got swap_open', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    resolveRoleRecipientIds.mockResolvedValue([HEAD_COACH])
    const { db } = buildDb({
      assignmentsById: base,
      poolRows: [
        { profile_id: COACH_A, status: 'scheduled', shift_blocks: onRoster('published') },
        { profile_id: HEAD_COACH, status: 'scheduled', shift_blocks: onRoster('published') },
      ],
    })
    createServerClient.mockReturnValue(db)

    await POST(req({ requester_shift_id: A_REQ }))
    await flush()

    // Resolved against the swap's location with the same role set the manager
    // fan-out used, so the two recipient sets cannot drift apart.
    expect(resolveRoleRecipientIds).toHaveBeenCalledWith(db, LOC, MANAGER_ROLES)

    const [, , ids] = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_open_pool:'))
    expect(ids).not.toContain(HEAD_COACH)
    expect(ids).toEqual([COACH_A])
    // and they are still told once, as a manager
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
  })

  it('runs no open-pool notification when every eligible coach is a manager', async () => {
    getCurrentUser.mockResolvedValue({ id: REQ, role: 'staff', full_name: 'R' })
    resolveRoleRecipientIds.mockResolvedValue([HEAD_COACH])
    const { db } = buildDb({
      assignmentsById: base,
      poolRows: [{ profile_id: HEAD_COACH, status: 'scheduled', shift_blocks: onRoster('published') }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ requester_shift_id: A_REQ }))
    expect(res.status).toBe(201)
    await flush()

    expect(notifyUsersOnce.mock.calls.filter(c => c[1].startsWith('swap_open_pool:'))).toHaveLength(0)
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
  })
})
