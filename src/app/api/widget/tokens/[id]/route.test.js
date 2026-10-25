// WIDGET.1 — DELETE /api/widget/tokens/[id], revocation.
//
// SESSION-ONLY (no allowWidgetToken — see route.js's sibling suite).
//
// Three properties this suite exists to pin:
//   1. Revoke STAMPS revoked_at, it never deletes the row — the row is the
//      audit trail for every door that token opened (mig 607).
//   2. 404, never 403, for a token that exists but belongs to someone else
//      and the caller lacks staff_management — a distinct 403 would confirm
//      the id exists, the enumeration this repo avoids everywhere else.
//   3. A zero-row UPDATE (PostgREST: no error, just an empty array) must be
//      judged as a 404, not silently treated as success.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-1', role: 'staff', profileRole: 'staff', activeLocation: { id: 'loc-1' } },
  locationId: 'loc-1',
  db: null,
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign(
    async (request, ctx) => handler({
      user: h.user,
      db: h.db,
      locationId: h.locationId,
      request,
      params: ctx?.params ? await ctx.params : undefined,
    }),
    { _opts: opts }
  ),
}))

vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))

import { DELETE } from './route.js'
import { hasPermission } from '@/lib/permissions'

function req(id = 'tok-1') {
  return new Request(`https://x.test/api/widget/tokens/${id}`, { method: 'DELETE' })
}

function ctx(id = 'tok-1') {
  return { params: Promise.resolve({ id }) }
}

// Configurable fake DB: select (existence + ownership lookup) then update
// (the revoke stamp). Captures the update payload so the "stamps, never
// deletes" property is checkable directly.
function mockDb({
  selectRow = { id: 'tok-1', profile_id: 'prof-1' },
  selectError = null,
  updateRows = [{ id: 'tok-1' }],
  updateError = null,
} = {}) {
  const calls = { selectEq: null, updateEq: null, updatePatch: null }
  const db = {
    from: (table) => {
      if (table !== 'widget_tokens') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (col, val) => {
            calls.selectEq = [col, val]
            return { maybeSingle: () => Promise.resolve({ data: selectRow, error: selectError }) }
          },
        }),
        update: (patch) => {
          calls.updatePatch = patch
          return {
            eq: (col, val) => {
              calls.updateEq = [col, val]
              return {
                select: () => Promise.resolve({ data: updateRows, error: updateError }),
              }
            },
          }
        },
      }
    },
  }
  return { db, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.user = { id: 'prof-1', role: 'staff', profileRole: 'staff', activeLocation: { id: 'loc-1' } }
  h.locationId = 'loc-1'
  hasPermission.mockReturnValue(false)
})

describe('session-only: no allowWidgetToken', () => {
  it('DELETE does not carry allowWidgetToken', () => {
    expect(DELETE._opts.allowWidgetToken).toBeFalsy()
  })
})

describe('DELETE /api/widget/tokens/[id] (revoke)', () => {
  it('stamps revoked_at rather than deleting the row', async () => {
    const { db, calls } = mockDb({ selectRow: { id: 'tok-1', profile_id: 'prof-1' } })
    h.db = db

    const res = await DELETE(req('tok-1'), ctx('tok-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(calls.updatePatch).toHaveProperty('revoked_at')
    expect(typeof calls.updatePatch.revoked_at).toBe('string')
    // The fake table builder exposes only select/update — a route that
    // reached for db.from('widget_tokens').delete() instead would throw
    // here (not a function) rather than silently pass.
  })

  it('404s for an unknown id', async () => {
    const { db } = mockDb({ selectRow: null })
    h.db = db

    const res = await DELETE(req('nope'), ctx('nope'))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
  })

  it("404s (not 403) for someone else's token when the caller lacks staff_management", async () => {
    const { db } = mockDb({ selectRow: { id: 'tok-1', profile_id: 'someone-else' } })
    h.db = db
    hasPermission.mockReturnValue(false)

    const res = await DELETE(req('tok-1'), ctx('tok-1'))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(res.status).not.toBe(403)
    expect(body.success).toBe(false)
  })

  it("revokes someone else's token when the caller holds staff_management", async () => {
    const { db, calls } = mockDb({ selectRow: { id: 'tok-1', profile_id: 'someone-else' } })
    h.db = db
    hasPermission.mockReturnValue(true)

    const res = await DELETE(req('tok-1'), ctx('tok-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(calls.updatePatch).toHaveProperty('revoked_at')
  })

  it('treats a zero-row UPDATE as a 404, not a success — PostgREST returns no error for it', async () => {
    const { db } = mockDb({
      selectRow: { id: 'tok-1', profile_id: 'prof-1' },
      updateRows: [], // zero rows, error: null — the PostgREST "matched nothing" shape
      updateError: null,
    })
    h.db = db

    const res = await DELETE(req('tok-1'), ctx('tok-1'))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
  })
})
