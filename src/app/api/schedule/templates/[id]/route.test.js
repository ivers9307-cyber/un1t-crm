// SAAS-11 — route-level SECURITY tests for PUT/DELETE
// /api/schedule/templates/[id].
//
// The detail route runs createServerClient() — the service-role client,
// which BYPASSES RLS. Application-layer location scoping is therefore the
// ONLY thing standing between a manager at tenant A and a cross-tenant
// read/edit/deactivate of tenant B's shift template (and, via PUT's
// future-block propagation, tenant B's roster blocks).
//
// SECURITY REGRESSION GUARD. Before this fix both handlers gated only on
// MANAGER_ROLES.includes(user.role) and then operated on shift_templates
// (and PUT also mutated shift_blocks) BY BARE ID with no location check —
// a classic cross-tenant IDOR.
//
// Approach: mirror the two-location in-memory fixture style from
// src/app/api/assistant/chat/route.test.js. @/lib/supabase is mocked to
// return a tiny in-memory Supabase-shaped client that ACTUALLY applies
// the eq / in / gte filters it is given against a two-location fixture —
// so a FORGOTTEN `.eq('location_id', …)` would return the foreign row and
// fail the assertion (a real leak guard, not a spy check). @/lib/auth is
// mocked with a real-equivalent assertLocationAccessOr404 (inlined to keep
// its next/headers import out of the node test env, same pattern as
// src/app/api/orders/[id]/route.test.js) and a stubbed getCurrentUser.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WEEKDAY_CODES } from '@/lib/roster'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    }
    return null
  },
}))

import { PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// ─── In-memory Supabase-shaped mock ──────────────────────────────────
// Chainable builder that records its op + filters + payload and, on
// await / .single() / .maybeSingle(), resolves against the fixture rows
// for its table — applying eq / in / gte the way PostgREST would. Writes
// (update / delete / upsert) are recorded in `_writes` (with their
// filters) so tests can assert both that a mutation DID or DID NOT happen
// and that it carried the location_id scope. delete() also mutates the
// fixture in place so subsequent reads reflect the removal.

function makeDb(fixtures = {}) {
  const writes = []

  function builder(table) {
    const state = { table, op: 'select', payload: null, opts: null, filters: [] }

    function rowsAfterFilters() {
      let rows = (fixtures[table] || []).slice()
      for (const f of state.filters) {
        if (f.type === 'eq') rows = rows.filter((r) => r[f.col] === f.val)
        else if (f.type === 'in') rows = rows.filter((r) => f.val.includes(r[f.col]))
        else if (f.type === 'gte') rows = rows.filter((r) => r[f.col] >= f.val)
        else if (f.type === 'lte') rows = rows.filter((r) => r[f.col] <= f.val)
      }
      return rows
    }

    function settle(single) {
      if (state.op === 'insert' || state.op === 'upsert') {
        const payloads = Array.isArray(state.payload) ? state.payload : [state.payload]
        const inserted = payloads.map((p, i) => ({ id: `${table}-new-${i}`, ...p }))
        writes.push({ table, op: state.op, payload: state.payload, opts: state.opts })
        return { data: single ? inserted[0] : inserted, error: null }
      }
      if (state.op === 'update') {
        const affected = rowsAfterFilters().map((r) => ({ ...r, ...state.payload }))
        writes.push({ table, op: 'update', payload: state.payload, filters: state.filters, affected: affected.length })
        return {
          data: single ? (affected[0] ?? null) : affected,
          error: single && affected.length === 0 ? { message: 'no rows' } : null,
        }
      }
      if (state.op === 'delete') {
        const affected = rowsAfterFilters()
        const ids = new Set(affected.map((r) => r.id))
        if (fixtures[table]) fixtures[table] = fixtures[table].filter((r) => !ids.has(r.id))
        writes.push({ table, op: 'delete', filters: state.filters, affected: affected.length })
        return { data: single ? (affected[0] ?? null) : affected, error: null }
      }
      const rows = rowsAfterFilters()
      return { data: single ? (rows[0] ?? null) : rows, error: null }
    }

    const chain = {
      select() { return chain },
      insert(payload) { state.op = 'insert'; state.payload = payload; return chain },
      update(payload) { state.op = 'update'; state.payload = payload; return chain },
      upsert(payload, opts) { state.op = 'upsert'; state.payload = payload; state.opts = opts; return chain },
      delete() { state.op = 'delete'; return chain },
      eq(col, val) { state.filters.push({ type: 'eq', col, val }); return chain },
      in(col, val) { state.filters.push({ type: 'in', col, val }); return chain },
      gte(col, val) { state.filters.push({ type: 'gte', col, val }); return chain },
      lte(col, val) { state.filters.push({ type: 'lte', col, val }); return chain },
      limit() { return chain },
      order() { return chain },
      single() { return Promise.resolve(settle(true)) },
      maybeSingle() { return Promise.resolve(settle(true)) },
      then(onF, onR) { return Promise.resolve(settle(false)).then(onF, onR) },
    }
    return chain
  }

  return { from: (table) => builder(table), _writes: writes, _fixtures: fixtures }
}

// Manager assigned ONLY to loc-a. Clears MANAGER_ROLES but must be barred
// from loc-b's rows by the location gate.
const MANAGER_A = { role: 'manager', locations: [{ id: 'loc-a' }] }
// Master sees every active location — getCurrentUser populates
// user.locations with all of them, so assertLocationAccessOr404 is a
// no-op for master. Mirror that here.
const MASTER = { role: 'master', locations: [{ id: 'loc-a' }, { id: 'loc-b' }] }

function req(body) {
  return { json: () => Promise.resolve(body) }
}

function useDb(fixtures) {
  const db = makeDb(fixtures)
  vi.mocked(createServerClient).mockReturnValue(db)
  return db
}

// A far-future date is always >= today; a far-past date never is —
// keeps the "future block" propagation assertions deterministic
// regardless of the day the suite runs.
const FUTURE = '2099-12-31'
const PAST = '2020-01-01'

function templates() {
  return [
    { id: 'tmpl-a', location_id: 'loc-a', name: 'A morning', start_time: '09:00', end_time: '10:00', days_of_week: ['mon', 'tue'], max_coaches: 10, active: true },
    { id: 'tmpl-b', location_id: 'loc-b', name: 'B morning', start_time: '09:00', end_time: '10:00', days_of_week: ['mon', 'tue'], max_coaches: 10, active: true },
  ]
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  vi.mocked(getCurrentUser).mockReset()
})

// ─── PUT — cross-tenant edit ─────────────────────────────────────────
describe('PUT /api/schedule/templates/[id] — location scoping', () => {
  it('(a) manager at loc-a editing a loc-b template → 404, template + blocks UNTOUCHED', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [
        { id: 'blk-b1', location_id: 'loc-b', template_id: 'tmpl-b', block_date: FUTURE, start_time: '09:00', end_time: '10:00', max_coaches: 10 },
      ],
    })

    const res = await PUT(req({ start_time: '08:00', name: 'HIJACK' }), { params: { id: 'tmpl-b' } })
    expect(res.status).toBe(404)

    // No write of ANY kind reached the DB — the guard fired first.
    expect(db._writes).toHaveLength(0)
    // The loc-b template + block are byte-identical to the fixture.
    expect(db._fixtures.shift_templates.find((t) => t.id === 'tmpl-b').name).toBe('B morning')
    expect(db._fixtures.shift_templates.find((t) => t.id === 'tmpl-b').start_time).toBe('09:00')
    expect(db._fixtures.shift_blocks.find((b) => b.id === 'blk-b1').start_time).toBe('09:00')
  })

  it('(d) missing id → 404, no write', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), shift_blocks: [] })
    const res = await PUT(req({ name: 'X' }), { params: { id: 'does-not-exist' } })
    expect(res.status).toBe(404)
    expect(db._writes).toHaveLength(0)
  })

  it('(c1) manager editing OWN-location template → future-field propagation runs, past block untouched, writes scoped to location', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [
        { id: 'blk-a-future', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, start_time: '09:00', end_time: '10:00', max_coaches: 10 },
        { id: 'blk-a-past', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST, start_time: '09:00', end_time: '10:00', max_coaches: 10 },
      ],
    })

    // Change start_time only; no days_of_week key → no day diff, no deletes.
    const res = await PUT(req({ start_time: '08:30' }), { params: { id: 'tmpl-a' } })
    expect(res.status ?? 200).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.start_time).toBe('08:30')
    // Only the FUTURE block was propagated to (gte today); past untouched.
    expect(body.propagation.futureBlocksUpdated).toBe(1)
    expect(body.propagation.futureBlocksDeleted).toBe(0)

    // The shift_templates UPDATE carried BOTH id and location_id filters.
    const tmplUpdate = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'update')
    expect(tmplUpdate.filters.some((f) => f.col === 'location_id' && f.val === 'loc-a')).toBe(true)
    // The shift_blocks future-field UPDATE was scoped to the location too.
    const blkUpdate = db._writes.find((w) => w.table === 'shift_blocks' && w.op === 'update')
    expect(blkUpdate.affected).toBe(1)
    expect(blkUpdate.filters.some((f) => f.col === 'location_id' && f.val === 'loc-a')).toBe(true)
  })

  it('(c2) manager editing OWN-location template — days_of_week removal deletes future stale-day blocks (scoped)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    // Compute the weekday code of our future block via the route's exact
    // formula so the removal is deterministic across run dates.
    const futureCode = WEEKDAY_CODES[(new Date(FUTURE + 'T00:00:00Z').getUTCDay() + 6) % 7]
    const keepCode = WEEKDAY_CODES.find((c) => c !== futureCode)

    const tmpls = templates()
    // tmpl-a starts covering both the future block's weekday and a keeper.
    tmpls.find((t) => t.id === 'tmpl-a').days_of_week = [futureCode, keepCode]

    const db = useDb({
      shift_templates: tmpls,
      shift_blocks: [
        { id: 'blk-a-stale', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, start_time: '09:00', end_time: '10:00', max_coaches: 10 },
      ],
    })

    // Remove futureCode → the future block on that weekday is deleted.
    const res = await PUT(req({ days_of_week: [keepCode] }), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.propagation.futureBlocksDeleted).toBe(1)

    // The delete was scoped to the location.
    const del = db._writes.find((w) => w.table === 'shift_blocks' && w.op === 'delete')
    expect(del).toBeTruthy()
    expect(del.filters.some((f) => f.col === 'location_id' && f.val === 'loc-a')).toBe(true)
    // The stale block is gone from the fixture.
    expect(db._fixtures.shift_blocks.some((b) => b.id === 'blk-a-stale')).toBe(false)
  })

  it('(e) master can edit a template at any location', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const db = useDb({ shift_templates: templates(), shift_blocks: [] })
    const res = await PUT(req({ name: 'Renamed by master' }), { params: { id: 'tmpl-b' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.name).toBe('Renamed by master')
    // The update still carried the loc-b scope.
    const tmplUpdate = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'update')
    expect(tmplUpdate.filters.some((f) => f.col === 'location_id' && f.val === 'loc-b')).toBe(true)
  })
})

// ─── DELETE — cross-tenant deactivate ────────────────────────────────
describe('DELETE /api/schedule/templates/[id] — location scoping', () => {
  it('(b) manager at loc-a deleting a loc-b template → 404, still active', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates() })
    const res = await DELETE(req({}), { params: { id: 'tmpl-b' } })
    expect(res.status).toBe(404)
    // No deactivation write happened.
    expect(db._writes).toHaveLength(0)
    expect(db._fixtures.shift_templates.find((t) => t.id === 'tmpl-b').active).toBe(true)
  })

  it('(d) missing id → 404, no write', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates() })
    const res = await DELETE(req({}), { params: { id: 'nope' } })
    expect(res.status).toBe(404)
    expect(db._writes).toHaveLength(0)
  })

  it('manager deleting OWN-location template → deactivates, scoped to location', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates() })
    const res = await DELETE(req({}), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.active).toBe(false)
    const upd = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'update')
    expect(upd.filters.some((f) => f.col === 'location_id' && f.val === 'loc-a')).toBe(true)
  })

  it('(e) master can deactivate a template at any location', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    useDb({ shift_templates: templates() })
    const res = await DELETE(req({}), { params: { id: 'tmpl-b' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.active).toBe(false)
  })
})
