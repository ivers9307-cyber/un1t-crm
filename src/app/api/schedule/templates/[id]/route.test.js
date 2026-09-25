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
import { WEEKDAY_CODES, getMonday, addDays, formatDate } from '@/lib/roster'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({
  getCurrentUser: vi.fn(),
  // SCHEDROLES.1 — REAL: the role at the template's studio is under test.
  hasRoleAtLocation: (await importOriginal()).hasRoleAtLocation,
  hasRoleAtAnyLocation: (await importOriginal()).hasRoleAtAnyLocation,
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
      // `count` so a head:true count select answers something real.
      return { data: single ? (rows[0] ?? null) : rows, count: rows.length, error: null }
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
      range() { return chain },
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
const MANAGER_A = { role: 'manager', profileRole: 'manager', locations: [{ id: 'loc-a' }], rolesByLocation: { 'loc-a': 'manager' } }
// Master sees every active location — getCurrentUser populates
// user.locations with all of them, so assertLocationAccessOr404 is a
// no-op for master. Mirror that here.
const MASTER = { role: 'master', profileRole: 'master', locations: [{ id: 'loc-a' }, { id: 'loc-b' }], rolesByLocation: {} }
// SCHEDROLES.1 — manager at loc-a, plain staff at loc-b. `role` is the
// ACTIVE studio's, which the route used to read.
const MIXED = (active) => ({
  role: active === 'loc-a' ? 'manager' : 'staff', profileRole: 'staff',
  activeLocation: { id: active },
  locations: [{ id: 'loc-a' }, { id: 'loc-b' }],
  rolesByLocation: { 'loc-a': 'manager', 'loc-b': 'staff' },
})

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
    { id: 'tmpl-a', location_id: 'loc-a', name: 'A morning', start_time: '09:00', end_time: '10:00', days_of_week: ['mon', 'tue'], max_coaches: 10, min_coaches: 1, active: true },
    { id: 'tmpl-b', location_id: 'loc-b', name: 'B morning', start_time: '09:00', end_time: '10:00', days_of_week: ['mon', 'tue'], max_coaches: 10, min_coaches: 1, active: true },
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

// ─── SCHEDROLES.1 — role at the TEMPLATE's studio ────────────────────
describe('PUT / DELETE /api/schedule/templates/[id] — role at the template\'s studio (SCHEDROLES.1)', () => {
  it('refuses a template at the studio where the caller is staff (403), writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MIXED('loc-a'))
    const db = useDb({ shift_templates: templates(), shift_blocks: [] })
    expect((await PUT(req({ name: 'HIJACK' }), { params: { id: 'tmpl-b' } })).status).toBe(403)
    expect((await DELETE(req({}), { params: { id: 'tmpl-b' } })).status).toBe(403)
    expect(db._writes).toHaveLength(0)
    expect(db._fixtures.shift_templates.find((t) => t.id === 'tmpl-b').active).toBe(true)
  })

  it('allows a template at the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(MIXED('loc-a'))
    useDb({ shift_templates: templates(), shift_blocks: [] })
    expect((await PUT(req({ name: 'Renamed' }), { params: { id: 'tmpl-a' } })).status).toBe(200)
    expect((await DELETE(req({}), { params: { id: 'tmpl-a' } })).status).toBe(200)
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(MIXED('loc-b'))
    useDb({ shift_templates: templates(), shift_blocks: [] })
    expect((await PUT(req({ name: 'Renamed' }), { params: { id: 'tmpl-a' } })).status).toBe(200)
    expect((await DELETE(req({}), { params: { id: 'tmpl-a' } })).status).toBe(200)
  })
})

// ─── ROSTER-FIX.4 — template edits vs an already-published roster ────
//
// A template edit is a bulk edit of everybody's published shifts. It
// propagated silently: coaches were never told their start time moved, and
// removing a weekday DELETED published blocks (assignments cascading with
// them), so a coach turned up for a shift that no longer existed.

const PUBLISHED = { status: 'published' }
const DRAFT = { status: 'draft' }

function futureCode() {
  return WEEKDAY_CODES[(new Date(FUTURE + 'T00:00:00Z').getUTCDay() + 6) % 7]
}

describe('PUT /api/schedule/templates/[id] — published-roster safety', () => {
  it('change-logs time_changed per LIVE coach on a published block', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [
        {
          id: 'blk-pub', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-pub', rosters: PUBLISHED,
          shift_assignments: [
            { profile_id: 'coach-1', status: 'scheduled' },
            { profile_id: 'coach-2', status: 'cancelled' },
          ],
        },
      ],
      roster_change_log: [],
    })

    const res = await PUT(req({ start_time: '08:30' }), { params: { id: 'tmpl-a' } })
    expect(res.status ?? 200).toBe(200)

    const logs = db._writes.filter((w) => w.table === 'roster_change_log' && w.op === 'insert')
    expect(logs).toHaveLength(1)
    expect(logs[0].payload).toMatchObject({
      location_id: 'loc-a', block_id: 'blk-pub', block_date: FUTURE,
      coach_id: 'coach-1', action: 'time_changed',
    })
  })

  it('does NOT change-log a block on a draft roster (nobody has been told about it yet)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [
        {
          id: 'blk-draft', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-draft', rosters: DRAFT,
          shift_assignments: [{ profile_id: 'coach-1', status: 'scheduled' }],
        },
      ],
      roster_change_log: [],
    })

    await PUT(req({ start_time: '08:30' }), { params: { id: 'tmpl-a' } })
    expect(db._writes.filter((w) => w.table === 'roster_change_log')).toHaveLength(0)
  })

  it('REFUSES to remove a weekday whose published future blocks still have live coaches', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const code = futureCode()
    const keep = WEEKDAY_CODES.find((c) => c !== code)
    const tmpls = templates()
    tmpls.find((t) => t.id === 'tmpl-a').days_of_week = [code, keep]

    const db = useDb({
      shift_templates: tmpls,
      shift_blocks: [
        {
          id: 'blk-pub', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-pub', rosters: PUBLISHED,
          shift_assignments: [{ profile_id: 'coach-1', status: 'scheduled' }],
        },
      ],
    })

    const res = await PUT(req({ days_of_week: [keep] }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('blocks_have_assignments')
    expect(body.dates).toEqual([FUTURE])
    // Nothing was written at all — not even the template rename half of it.
    expect(db._writes).toHaveLength(0)
    expect(db._fixtures.shift_blocks).toHaveLength(1)
  })

  it('still removes the weekday when the published blocks have only CANCELLED assignments', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const code = futureCode()
    const keep = WEEKDAY_CODES.find((c) => c !== code)
    const tmpls = templates()
    tmpls.find((t) => t.id === 'tmpl-a').days_of_week = [code, keep]

    useDb({
      shift_templates: tmpls,
      shift_blocks: [
        {
          id: 'blk-pub', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-pub', rosters: PUBLISHED,
          shift_assignments: [{ profile_id: 'coach-1', status: 'cancelled' }],
        },
      ],
    })

    const res = await PUT(req({ days_of_week: [keep] }), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.propagation.futureBlocksDeleted).toBe(1)
  })

  // ROSTER-FIX.4 — the refusal covers DRAFT blocks too. A staffed draft block
  // is the MORE destructive case: deactivating a template already leaves it
  // alone, so weekday removal was the one path still cascading live
  // assignments away, silently, with no change-log row and no notice.
  it('REFUSES to remove a weekday when a DRAFT block still has a live coach', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const code = futureCode()
    const keep = WEEKDAY_CODES.find((c) => c !== code)
    const tmpls = templates()
    tmpls.find((t) => t.id === 'tmpl-a').days_of_week = [code, keep]

    const db = useDb({
      shift_templates: tmpls,
      shift_blocks: [
        {
          id: 'blk-draft', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-draft', rosters: DRAFT,
          shift_assignments: [{ profile_id: 'coach-1', status: 'scheduled' }],
        },
      ],
    })

    const res = await PUT(req({ days_of_week: [keep] }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('blocks_have_assignments')
    expect(body.dates).toEqual([FUTURE])
    // The message can no longer claim the shifts are published — this one
    // is not, and the operator is told what is actually true of it.
    expect(body.message).not.toMatch(/published/)
    expect(db._writes).toHaveLength(0)
    expect(db._fixtures.shift_blocks).toHaveLength(1)
  })

  it('still removes the weekday when a block with NO roster at all is empty', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const code = futureCode()
    const keep = WEEKDAY_CODES.find((c) => c !== code)
    const tmpls = templates()
    tmpls.find((t) => t.id === 'tmpl-a').days_of_week = [code, keep]

    useDb({
      shift_templates: tmpls,
      shift_blocks: [
        {
          id: 'blk-loose', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10, shift_assignments: [],
        },
      ],
    })

    const res = await PUT(req({ days_of_week: [keep] }), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.propagation.futureBlocksDeleted).toBe(1)
  })

  it('active:false skips regeneration and deletes only the empty UNPUBLISHED future blocks', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [
        {
          id: 'blk-empty', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10, shift_assignments: [],
        },
        {
          id: 'blk-staffed', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-pub', rosters: PUBLISHED,
          shift_assignments: [{ profile_id: 'coach-1', status: 'scheduled' }],
        },
        {
          id: 'blk-past', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST,
          start_time: '09:00', end_time: '10:00', max_coaches: 10, shift_assignments: [],
        },
      ],
    })

    const res = await PUT(req({ active: false }), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    // No regeneration — a deactivated template must not re-materialise the
    // blocks we just removed.
    expect(db._writes.some((w) => w.table === 'shift_blocks' && w.op === 'upsert')).toBe(false)
    expect(body.generated).toEqual({ inserted: 0, skipped: 0 })
    // The empty future block is gone; the staffed one and the past one stay.
    const ids = db._fixtures.shift_blocks.map((b) => b.id)
    expect(ids).toContain('blk-staffed')
    expect(ids).toContain('blk-past')
    expect(ids).not.toContain('blk-empty')
    expect(body.propagation.deactivatedBlocksDeleted).toBe(1)
    expect(body.propagation.publishedEmptiesKept).toBe(0)
  })

  // ROSTER-FIX.4 — an EMPTY block on a published roster survives deactivate.
  // It is part of a week staff have already been shown, and this path writes
  // no roster_change_log row, so deleting it removed a published slot with
  // nothing recording that it had ever existed — and an unstaffed published
  // shift is precisely the one the manager still has to fill.
  it('active:false KEEPS an empty block that is on a published roster, and says so', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [
        {
          id: 'blk-pub-empty', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-pub', rosters: PUBLISHED, shift_assignments: [],
        },
        {
          id: 'blk-draft-empty', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-draft', rosters: DRAFT, shift_assignments: [],
        },
      ],
    })

    const res = await PUT(req({ active: false }), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    const ids = db._fixtures.shift_blocks.map((b) => b.id)
    expect(ids).toContain('blk-pub-empty')
    expect(ids).not.toContain('blk-draft-empty')
    expect(body.propagation.deactivatedBlocksDeleted).toBe(1)
    expect(body.propagation.publishedEmptiesKept).toBe(1)
    // The delete that DID run never named the published block.
    const del = db._writes.find((w) => w.table === 'shift_blocks' && w.op === 'delete')
    const inFilter = del.filters.find((f) => f.type === 'in')
    expect(inFilter.val).toEqual(['blk-draft-empty'])
  })

  it('active:false with nothing but published empties deletes nothing at all', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [
        {
          id: 'blk-pub-empty', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
          start_time: '09:00', end_time: '10:00', max_coaches: 10,
          roster_id: 'r-pub', rosters: PUBLISHED, shift_assignments: [],
        },
      ],
    })

    const res = await PUT(req({ active: false }), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.propagation.deactivatedBlocksDeleted).toBe(0)
    expect(body.propagation.publishedEmptiesKept).toBe(1)
    expect(db._writes.some((w) => w.table === 'shift_blocks' && w.op === 'delete')).toBe(false)
  })
})

// SLOTREMOVAL.1 — PUT regenerates the next 8 weeks through
// generateBlocksForTemplate, which now reads shift_block_removals. A slot a
// manager deleted must not come back because someone saved its template.
describe('PUT /api/schedule/templates/[id] — deleted slots stay deleted', () => {
  it('regeneration skips a (template, date) with a removal row and generates the rest', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const monday = getMonday(new Date())
    const removedDate = formatDate(addDays(monday, 7)) // next week's Monday
    const keptDate = formatDate(addDays(monday, 14))
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [],
      rosters: [],
      shift_block_removals: [
        { id: 'rm-1', location_id: 'loc-a', template_id: 'tmpl-a', block_date: removedDate },
        // Another template's removal on the same date must not suppress this one's.
        { id: 'rm-2', location_id: 'loc-a', template_id: 'tmpl-other', block_date: keptDate },
      ],
    })

    const res = await PUT(req({ name: 'Renamed' }), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.warning).toBeUndefined()

    const upsert = db._writes.find((w) => w.table === 'shift_blocks' && w.op === 'upsert')
    const dates = upsert.payload.map((r) => r.block_date)
    expect(dates).not.toContain(removedDate)
    expect(dates).toContain(keptDate)
    expect(body.generated.removed).toBe(1)
  })
})


// ─────────────────────────────────────────────────────────────────────
// SHIFTTPL.1 / SHIFTMIN-CLAMP.1
// ─────────────────────────────────────────────────────────────────────

// A DELETE carries the hard flag on the query string, so these need a url.
function delReq(url = 'https://crm.test/api/schedule/templates/tmpl-a') {
  return { url, json: () => Promise.resolve({}) }
}

// THE FINDING: the web Deactivate button calls DELETE, which only flipped
// `active:false`. PUT's `active:false` path ALSO clears the future blocks
// nobody is on — so the same operator action produced two different
// calendars depending on which surface was used.
describe('DELETE /api/schedule/templates/[id] — deactivate clears empty future slots', () => {
  it('deletes the empty, unpublished future blocks, exactly as PUT active:false does', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      rosters: [],
      shift_blocks: [
        { id: 'blk-empty', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, roster_id: null, shift_assignments: [] },
        { id: 'blk-past', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST, roster_id: null, shift_assignments: [] },
      ],
    })

    const res = await DELETE(delReq(), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.propagation.deactivatedBlocksDeleted).toBe(1)
    // The past block is the record of what ran; it is never touched.
    expect(db._fixtures.shift_blocks.map((b) => b.id)).toEqual(['blk-past'])
  })

  it('leaves a staffed future block alone: deactivating must not cancel a shift', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      rosters: [],
      shift_blocks: [
        { id: 'blk-staffed', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, roster_id: null, shift_assignments: [{ profile_id: 'p1', status: 'scheduled' }] },
      ],
    })

    const res = await DELETE(delReq(), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.propagation.deactivatedBlocksDeleted).toBe(0)
    expect(db._fixtures.shift_blocks).toHaveLength(1)
  })

  it('keeps an empty PUBLISHED block and reports it, so the calendar not emptying is explained', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    useDb({
      shift_templates: templates(),
      rosters: [{ id: 'r-1', status: 'published' }],
      shift_blocks: [
        { id: 'blk-pub', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, roster_id: 'r-1', rosters: { status: 'published' }, shift_assignments: [] },
      ],
    })

    const res = await DELETE(delReq(), { params: { id: 'tmpl-a' } })
    const body = await res.json()
    expect(body.propagation.deactivatedBlocksDeleted).toBe(0)
    expect(body.propagation.publishedEmptiesKept).toBe(1)
  })
})

describe('DELETE /api/schedule/templates/[id]?hard=true', () => {
  const HARD = 'https://crm.test/api/schedule/templates/tmpl-a?hard=true'

  it('removes a template that has no blocks and no assignments ever', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), shift_blocks: [], shift_assignments: [] })

    const res = await DELETE(delReq(HARD), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(200)
    expect((await res.json()).deleted).toBe(true)
    expect(db._fixtures.shift_templates.map((t) => t.id)).toEqual(['tmpl-b'])
    // Scoped to the verified location, not by bare id.
    const del = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'delete')
    expect(del.filters).toContainEqual({ type: 'eq', col: 'location_id', val: 'loc-a' })
  })

  it('refuses when the template has shifts, naming the coaches on them, and keeps the row', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      shift_blocks: [{ id: 'blk-1', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST }],
      shift_assignments: [{ id: 'a-1', block_id: 'blk-1', profile_id: 'p1', status: 'completed' }],
    })

    const res = await DELETE(delReq(HARD), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('template_in_use')
    expect(body.blocks).toBe(1)
    expect(body.assignments).toBe(1)
    expect(body.message).toMatch(/Deactivate it instead/)
    expect(db._fixtures.shift_templates).toHaveLength(2)
    expect(db._writes.some((w) => w.op === 'delete')).toBe(false)
  })

  // A CANCELLED assignment is retained on purpose (mig 067) — it is still
  // history, so "no assignments ever" has to count it.
  it('counts a cancelled assignment as history', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    useDb({
      shift_templates: templates(),
      shift_blocks: [{ id: 'blk-1', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST }],
      shift_assignments: [{ id: 'a-1', block_id: 'blk-1', profile_id: 'p1', status: 'cancelled' }],
    })
    const body = await (await DELETE(delReq(HARD), { params: { id: 'tmpl-a' } })).json()
    expect(body.assignments).toBe(1)
  })

  it('still refuses a cross-tenant hard delete with a 404', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), shift_blocks: [], shift_assignments: [] })
    const res = await DELETE(delReq('https://crm.test/x?hard=true'), { params: { id: 'tmpl-b' } })
    expect(res.status).toBe(404)
    expect(db._fixtures.shift_templates).toHaveLength(2)
  })

  it('an unreadable url means DEACTIVATE, never delete', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [] })
    const res = await DELETE({ json: async () => ({}) }, { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(200)
    expect(db._fixtures.shift_templates).toHaveLength(2)
    const write = db._writes.find((w) => w.table === 'shift_templates')
    expect(write.op).toBe('update')
    expect(write.payload).toEqual({ active: false })
  })
})

// THE FINDING: saving a template's minimum pushed the one number onto every
// future block in a single UPDATE. `shift_blocks_min_coaches_check` (mig 177)
// forbids min > max per row, so a single block whose max had been cut below
// the new minimum failed the statement for ALL of them — the template saved,
// the propagation landed on nothing, and the route returned a warning the
// operator could do nothing with.
describe('PUT /api/schedule/templates/[id] — the minimum is clamped per block', () => {
  it('writes LEAST(min, block.max) rather than one number for every block', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      rosters: [],
      shift_blocks: [
        { id: 'blk-roomy', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, min_coaches: 1, max_coaches: 10, shift_assignments: [] },
        { id: 'blk-tight', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, min_coaches: 1, max_coaches: 2, shift_assignments: [] },
        { id: 'blk-past', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST, min_coaches: 1, max_coaches: 2, shift_assignments: [] },
      ],
    })

    const res = await PUT(req({ min_coaches: 3 }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBeUndefined()

    const blockWrites = db._writes.filter((w) => w.table === 'shift_blocks' && w.op === 'update')
    const byMin = Object.fromEntries(blockWrites.map((w) => [w.payload.min_coaches, w.filters.find((f) => f.type === 'in')?.val]))
    expect(byMin[3]).toEqual(['blk-roomy'])
    // Clamped to its own ceiling instead of failing the whole statement.
    expect(byMin[2]).toEqual(['blk-tight'])
    // Past blocks keep their snapshotted minimum (mig 177's rule).
    expect(blockWrites.flatMap((w) => w.filters.find((f) => f.type === 'in')?.val || [])).not.toContain('blk-past')
  })

  it('lowering the maximum drags a block sitting above it down in the SAME statement', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      rosters: [],
      shift_blocks: [
        { id: 'blk-1', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, min_coaches: 3, max_coaches: 10, shift_assignments: [] },
      ],
    })

    await PUT(req({ max_coaches: 2 }), { params: { id: 'tmpl-a' } })
    const write = db._writes.find((w) => w.table === 'shift_blocks' && w.op === 'update')
    // Both values in one patch, or the CHECK sees min 3 against max 2.
    expect(write.payload).toEqual({ max_coaches: 2, min_coaches: 2 })
  })

  it('writes nothing when the clamped values already match', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(),
      rosters: [],
      shift_blocks: [
        { id: 'blk-1', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, min_coaches: 2, max_coaches: 2, shift_assignments: [] },
      ],
    })

    await PUT(req({ min_coaches: 5 }), { params: { id: 'tmpl-a' } })
    expect(db._writes.filter((w) => w.table === 'shift_blocks' && w.op === 'update')).toHaveLength(0)
  })
})

describe('PUT /api/schedule/templates/[id] — a reorder is just a reorder', () => {
  it('skips the 8-week generator for a display_order-only edit', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [], shift_block_removals: [] })

    const res = await PUT(req({ display_order: 2 }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(200)
    expect(db._writes.some((w) => w.table === 'shift_blocks' && w.op === 'upsert')).toBe(false)
  })

  it('still regenerates when anything structural rides along', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [], shift_block_removals: [] })

    await PUT(req({ display_order: 2, days_of_week: ['mon', 'tue', 'wed'] }), { params: { id: 'tmpl-a' } })
    expect(db._writes.some((w) => w.table === 'shift_blocks' && w.op === 'upsert')).toBe(true)
  })
})

// SHIFTTYPE.1 — kind on an edit.
describe('PUT /api/schedule/templates/[id] — kind (SHIFTTYPE.1)', () => {
  it('class -> admin writes kind and minimum 0 together, and takes FUTURE blocks to minimum 0', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates().map((t) => ({ ...t, kind: 'class', min_coaches: 2 })),
      rosters: [],
      shift_blocks: [
        { id: 'blk-future', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, min_coaches: 2, max_coaches: 10, shift_assignments: [] },
        { id: 'blk-past', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST, min_coaches: 2, max_coaches: 10, shift_assignments: [] },
      ],
    })
    const res = await PUT(req({ kind: 'admin' }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(200)
    const tplWrite = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'update')
    expect(tplWrite.payload).toEqual({ kind: 'admin', min_coaches: 0 })
    const blockWrites = db._writes.filter((w) => w.table === 'shift_blocks' && w.op === 'update')
    expect(blockWrites).toHaveLength(1)
    expect(blockWrites[0].payload).toEqual({ min_coaches: 0 })
    expect(blockWrites[0].filters.find((f) => f.type === 'in').val).toEqual(['blk-future'])
  })

  it('refuses a minimum on an admin template with 400 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates().map((t) => ({ ...t, kind: 'admin', min_coaches: 0 })), rosters: [], shift_blocks: [] })
    const res = await PUT(req({ min_coaches: 2 }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('admin_has_no_minimum')
    expect(db._writes).toEqual([])
  })

  it('renaming an admin template leaves its kind and minimum alone', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates().map((t) => ({ ...t, kind: 'admin', min_coaches: 0 })), rosters: [], shift_blocks: [] })
    expect((await PUT(req({ name: 'Stock take' }), { params: { id: 'tmpl-a' } })).status).toBe(200)
    const tplWrite = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'update')
    expect(tplWrite.payload).toEqual({ name: 'Stock take' })
  })

  it('refuses a kind it does not know, before any write', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [] })
    expect((await PUT(req({ kind: 'desk' }), { params: { id: 'tmpl-a' } })).status).toBe(400)
    expect(db._writes).toEqual([])
  })
})

// BLOCKEDIT.1 review 5 — a template time edit must not undo a one-off shift
// edit (PUT /api/schedule/blocks/[id]). Only future blocks whose times still
// equal the template's OLD times are rewritten; an edited block keeps its
// own hours, and is neither rewritten nor change-logged.
describe('PUT /api/schedule/templates/[id] — one-off block edits survive (BLOCKEDIT.1 review 5)', () => {
  const blocks = () => [
    {
      id: 'blk-template', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE,
      start_time: '09:00', end_time: '10:00', max_coaches: 10,
      roster_id: 'r-pub', rosters: PUBLISHED,
      shift_assignments: [{ profile_id: 'coach-1', status: 'scheduled' }],
    },
    {
      id: 'blk-edited', location_id: 'loc-a', template_id: 'tmpl-a', block_date: '2099-12-30',
      start_time: '09:30', end_time: '10:00', max_coaches: 10,
      roster_id: 'r-pub', rosters: PUBLISHED,
      shift_assignments: [{ profile_id: 'coach-2', status: 'scheduled' }],
    },
  ]

  it('rewrites only the block still at the template times, and reports the one it kept', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), shift_blocks: blocks(), roster_change_log: [] })
    const body = await (await PUT(req({ start_time: '08:30' }), { params: { id: 'tmpl-a' } })).json()
    const upd = db._writes.find((w) => w.table === 'shift_blocks' && w.op === 'update')
    expect(upd.affected).toBe(1)
    expect(upd.filters).toEqual(expect.arrayContaining([
      { type: 'eq', col: 'start_time', val: '09:00' }, { type: 'eq', col: 'end_time', val: '10:00' },
    ]))
    expect(body.propagation.futureBlocksUpdated).toBe(1)
    expect(body.propagation.futureBlocksKeptEdited).toBe(1)
  })

  it('change-logs only the coach whose block really moved', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), shift_blocks: blocks(), roster_change_log: [] })
    await PUT(req({ end_time: '10:30' }), { params: { id: 'tmpl-a' } })
    const logs = db._writes.filter((w) => w.table === 'roster_change_log' && w.op === 'insert')
    expect(logs.map((l) => l.payload.coach_id)).toEqual(['coach-1'])
  })
})

// BLOCKEDIT.1 second review 2 — the same rule for staffing, PER FIELD: a
// template minimum/maximum edit reaches only future blocks still at the
// template's OLD value. (A block whose own value was edited to coincide with
// the template's old value is indistinguishable from an unedited one, and is
// treated as unedited.)
describe('PUT /api/schedule/templates/[id] — one-off staffing edits survive (BLOCKEDIT.1 second review 2)', () => {
  const blk = (id, over) => ({ id, location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, start_time: '09:00', end_time: '10:00', min_coaches: 1, max_coaches: 10, shift_assignments: [], ...over })
  const touched = (db) => db._writes.filter((w) => w.table === 'shift_blocks' && w.op === 'update')
    .flatMap((w) => w.filters.find((f) => f.type === 'in')?.val || [])

  it('a minimum edit leaves a block whose minimum was edited on its own', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [blk('blk-follows'), blk('blk-edited', { min_coaches: 3 })] })
    const body = await (await PUT(req({ min_coaches: 2 }), { params: { id: 'tmpl-a' } })).json()
    expect(touched(db)).toEqual(['blk-follows'])
    expect(body.propagation.futureBlocksKeptEdited).toBe(1)
  })

  it('a maximum edit leaves a block whose maximum was edited on its own', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [blk('blk-follows'), blk('blk-edited', { max_coaches: 4 })] })
    const body = await (await PUT(req({ max_coaches: 8 }), { params: { id: 'tmpl-a' } })).json()
    expect(touched(db)).toEqual(['blk-follows'])
    expect(body.propagation.futureBlocksKeptEdited).toBe(1)
  })

  it('switching to admin still zeroes EVERY future minimum (an admin shift has none)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates().map((t) => ({ ...t, kind: 'class', min_coaches: 2 })),
      rosters: [], shift_blocks: [blk('blk-follows', { min_coaches: 2 }), blk('blk-edited', { min_coaches: 3 })],
    })
    await PUT(req({ kind: 'admin' }), { params: { id: 'tmpl-a' } })
    expect(touched(db).sort()).toEqual(['blk-edited', 'blk-follows'])
  })

  it('re-saving the SAME times reports nothing kept (nothing was going to change)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [blk('blk-edited', { start_time: '09:30' })] })
    const body = await (await PUT(req({ start_time: '09:00', end_time: '10:00' }), { params: { id: 'tmpl-a' } })).json()
    expect(body.propagation.futureBlocksKeptEdited).toBe(0)
  })
})

// BLOCKEDIT.1 third check 2 — the min/max writes are guarded on the values the
// block was READ with, so a manager editing that block between the read and
// the write is not overwritten.
describe('PUT /api/schedule/templates/[id] — staffing writes guarded on the values read (third check 2)', () => {
  it('a block whose minimum changed after the read is not written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates(), rosters: [],
      shift_blocks: [{ id: 'blk-follows', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, start_time: '09:00', end_time: '10:00', min_coaches: 1, max_coaches: 10, shift_assignments: [] }],
    })
    const realFrom = db.from
    db.from = (t) => {
      const chain = realFrom(t)
      if (t === 'shift_blocks') {
        const update = chain.update
        // Another manager saves this block's minimum between our read and our write.
        chain.update = (patch) => { db._fixtures.shift_blocks[0].min_coaches = 3; return update(patch) }
      }
      return chain
    }
    const body = await (await PUT(req({ min_coaches: 2 }), { params: { id: 'tmpl-a' } })).json()
    const write = db._writes.find((w) => w.table === 'shift_blocks' && w.op === 'update')
    expect(write.filters).toEqual(expect.arrayContaining([
      { type: 'eq', col: 'min_coaches', val: 1 }, { type: 'eq', col: 'max_coaches', val: 10 },
    ]))
    expect(write.affected).toBe(0)
    expect(body.propagation.futureBlocksUpdated).toBe(0)
  })
})
