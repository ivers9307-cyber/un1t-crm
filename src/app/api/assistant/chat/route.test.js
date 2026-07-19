// Route-level SECURITY tests for executeTool() in the assistant chat
// route.
//
// The assistant runs every CRM tool through createServerClient() — the
// service-role client, which BYPASSES RLS. Application-layer location
// scoping is therefore the only thing standing between the assistant and
// a cross-tenant data leak.
//
// SECURITY REGRESSION GUARD. Before this fix several tools issued
// service-role queries with no location scoping:
//   - search_contacts matched contacts across every location/tenant
//     (e.g. both UN1T and CCF Autos)
//   - create_contact inserted a NULL-location orphan/global row
//   - list_staff listed staff across every tenant
//   - move_deal moved a deal by id with no ownership check (the tool
//     itself was later removed in FUNNEL.1 — stages are classifier-
//     derived, so its tests went with it)
//   - create_activity attached to a client-supplied contact_id with no
//     ownership check and stamped no location_id
// These tests pin the scoped behaviour: every tenant-data tool is
// confined to context.locationId (the server-trusted active location),
// and the existing TOOL_PERMISSIONS role gate still holds.
//
// SAAS-1 closed the residual gaps and pinned them here too:
//   - create_shift validated neither shift_template_id nor profile_id
//     against the location — any tenant's template/staff could be
//     rostered (and their names leaked via the friendly-name lookups)
//   - get_holiday_allowance let a manager read ANY tenant's allowance
//     by profile_id
//   - generate_report staff_cost read EVERY tenant's salary rows
//   - list_shift_templates / get_shifts_for_week / create_shift /
//     generate_report had no null-locationId guard
//
// Approach: executeTool calls createServerClient() internally, so we mock
// @/lib/supabase to return a tiny in-memory Supabase-shaped client that
// ACTUALLY applies the eq / in / gte / lte / or(ilike) filters it is
// given against a two-location fixture (eq/in/gte/lte resolve dotted
// embedded-resource columns like `shift_blocks.location_id`). A forgotten
// `.eq('location_id', …)` would then return loc-b's rows and fail the
// assertion — a real leak guard, not a spy check. @/lib/auth is mocked
// only to keep its next/headers import out of the node test env
// (executeTool never calls it).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

import { executeTool } from './route.js'
import { createServerClient } from '@/lib/supabase'

// ─── In-memory Supabase-shaped mock ──────────────────────────────────
// Chainable builder that records its op + filters + payload and, on
// await / .single() / .maybeSingle(), resolves against the fixture rows
// for its table — applying eq / in / or(ilike) the way PostgREST would.

function ilikeToRegExp(pattern) {
  // %x% → "contains x" (case-insensitive). Escape regex specials first,
  // then turn the SQL wildcards (% _) into their regex equivalents.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')
}

function makeDb(fixtures = {}) {
  const writes = [] // every insert/update/upsert, for write-scoping assertions

  // PostgREST column refs may traverse an embedded resource
  // ("shift_blocks.location_id") — resolve dots through nested objects.
  const colVal = (row, col) => col.split('.').reduce((o, k) => (o == null ? o : o[k]), row)

  function builder(table) {
    const state = { table, op: 'select', payload: null, opts: null, filters: [] }

    function rowsAfterFilters() {
      let rows = (fixtures[table] || []).slice()
      for (const f of state.filters) {
        if (f.type === 'eq') rows = rows.filter(r => colVal(r, f.col) === f.val)
        else if (f.type === 'in') rows = rows.filter(r => f.val.includes(colVal(r, f.col)))
        else if (f.type === 'gte') rows = rows.filter(r => colVal(r, f.col) >= f.val)
        else if (f.type === 'lte') rows = rows.filter(r => colVal(r, f.col) <= f.val)
        else if (f.type === 'or') {
          const clauses = f.val.split(',').map(c => {
            const [col, , ...rest] = c.split('.') // "name.ilike.%q%"
            return { col, rx: ilikeToRegExp(rest.join('.')) }
          })
          rows = rows.filter(r => clauses.some(cl => r[cl.col] != null && cl.rx.test(String(r[cl.col]))))
        }
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
        const affected = rowsAfterFilters().map(r => ({ ...r, ...state.payload }))
        writes.push({ table, op: 'update', payload: state.payload, filters: state.filters, affected: affected.length })
        return {
          data: single ? (affected[0] ?? null) : affected,
          error: single && affected.length === 0 ? { message: 'no rows' } : null,
        }
      }
      const rows = rowsAfterFilters()
      return { data: single ? (rows[0] ?? null) : rows, error: null }
    }

    const chain = {
      select() { return chain },
      insert(payload) { state.op = 'insert'; state.payload = payload; return chain },
      update(payload) { state.op = 'update'; state.payload = payload; return chain },
      upsert(payload, opts) { state.op = 'upsert'; state.payload = payload; state.opts = opts; return chain },
      eq(col, val) { state.filters.push({ type: 'eq', col, val }); return chain },
      in(col, val) { state.filters.push({ type: 'in', col, val }); return chain },
      gte(col, val) { state.filters.push({ type: 'gte', col, val }); return chain },
      lte(col, val) { state.filters.push({ type: 'lte', col, val }); return chain },
      or(arg) { state.filters.push({ type: 'or', val: arg }); return chain },
      limit() { return chain },
      order() { return chain },
      single() { return Promise.resolve(settle(true)) },
      maybeSingle() { return Promise.resolve(settle(true)) },
      then(onF, onR) { return Promise.resolve(settle(false)).then(onF, onR) },
    }
    return chain
  }

  return { from: (table) => builder(table), _writes: writes }
}

// Manager at loc-a. Manager ∈ ADMIN_ROLES and MANAGER_ROLES, so it clears
// the gate for all tools under test.
const MANAGER = { locationId: 'loc-a', role: 'manager', userId: 'u-1' }

function useDb(fixtures) {
  const db = makeDb(fixtures)
  vi.mocked(createServerClient).mockReturnValue(db)
  return db
}

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
})

// ── search_contacts ──────────────────────────────────────────────────
describe('executeTool search_contacts — location scoping', () => {
  const contacts = [
    { id: 'c-a1', name: 'Alice Anderson', email: 'alice@a.com', location_id: 'loc-a' },
    { id: 'c-a2', name: 'Bob Adams', email: 'bob@a.com', location_id: 'loc-a' },
    { id: 'c-b1', name: 'Alice Baxter', email: 'alice@b.com', location_id: 'loc-b' }, // other tenant
  ]

  it('returns only contacts in the caller’s active location, never another tenant’s', async () => {
    useDb({ contacts })
    const res = await executeTool('search_contacts', { query: 'alice' }, MANAGER)
    expect(res.contacts.map(c => c.id)).toEqual(['c-a1'])
    expect(res.count).toBe(1)
    // The loc-b "Alice" must not leak through.
    expect(res.contacts.some(c => c.location_id === 'loc-b')).toBe(false)
  })

  it('returns an empty result (never an unscoped read) when there is no active location', async () => {
    useDb({ contacts })
    const res = await executeTool('search_contacts', { query: 'alice' }, { ...MANAGER, locationId: null })
    expect(res).toEqual({ contacts: [], count: 0 })
  })
})

// ── create_contact ───────────────────────────────────────────────────
describe('executeTool create_contact — location stamping', () => {
  it('stamps the caller’s active location on the inserted row', async () => {
    const db = useDb({ contacts: [] })
    const res = await executeTool('create_contact', { name: 'New Lead', email: 'new@x.com' }, MANAGER)
    expect(res.success).toBe(true)
    const insert = db._writes.find(w => w.table === 'contacts' && w.op === 'insert')
    expect(insert.payload.location_id).toBe('loc-a')
  })

  it('cannot be tricked into writing another location_id from tool input', async () => {
    // The tool schema has no location_id field, but prove a smuggled one
    // is ignored — the row is always stamped with context.locationId.
    const db = useDb({ contacts: [] })
    await executeTool('create_contact', { name: 'X', email: 'x@x.com', location_id: 'loc-b' }, MANAGER)
    const insert = db._writes.find(w => w.table === 'contacts' && w.op === 'insert')
    expect(insert.payload.location_id).toBe('loc-a')
  })

  it('refuses to create an orphan row when there is no active location', async () => {
    const db = useDb({ contacts: [] })
    const res = await executeTool('create_contact', { name: 'New', email: 'n@x.com' }, { ...MANAGER, locationId: null })
    expect(res.error).toMatch(/active location/i)
    expect(db._writes.some(w => w.table === 'contacts' && w.op === 'insert')).toBe(false)
  })
})

// ── list_staff ───────────────────────────────────────────────────────
describe('executeTool list_staff — location scoping via profile_locations', () => {
  const profile_locations = [
    { profile_id: 'p-a1', location_id: 'loc-a' },
    { profile_id: 'p-a2', location_id: 'loc-a' },
    { profile_id: 'p-b1', location_id: 'loc-b' }, // other tenant
  ]
  const profiles = [
    { id: 'p-a1', full_name: 'Anna Coach', email: 'anna@a.com', role: 'head_coach', active: true },
    { id: 'p-a2', full_name: 'Andy Manager', email: 'andy@a.com', role: 'manager', active: false }, // inactive
    { id: 'p-b1', full_name: 'Ben Other', email: 'ben@b.com', role: 'owner', active: true },
  ]

  it('lists only active staff sharing the caller’s location, not other tenants', async () => {
    useDb({ profile_locations, profiles })
    const res = await executeTool('list_staff', {}, MANAGER)
    expect(res.staff.map(s => s.id)).toEqual(['p-a1'])
    // No cross-tenant staff, and inactive staff stay filtered out.
    expect(res.staff.some(s => s.id === 'p-b1')).toBe(false)
    expect(res.staff.some(s => s.id === 'p-a2')).toBe(false)
  })

  it('returns no staff when there is no active location', async () => {
    useDb({ profile_locations, profiles })
    const res = await executeTool('list_staff', {}, { ...MANAGER, locationId: null })
    expect(res).toEqual({ staff: [] })
  })
})

// ── create_activity ──────────────────────────────────────────────────
describe('executeTool create_activity — contact ownership + location stamping', () => {
  const contacts = [
    { id: 'c-a1', name: 'Alice', email: 'a@a.com', location_id: 'loc-a' },
    { id: 'c-b1', name: 'Bob', email: 'b@b.com', location_id: 'loc-b' }, // other tenant
  ]

  it('creates an activity for an in-location contact and stamps the location', async () => {
    const db = useDb({ contacts, activities: [] })
    const res = await executeTool('create_activity', { subject: 'Call Alice', type: 'call', contact_id: 'c-a1' }, MANAGER)
    expect(res.success).toBe(true)
    const insert = db._writes.find(w => w.table === 'activities' && w.op === 'insert')
    expect(insert.payload.location_id).toBe('loc-a')
    expect(insert.payload.contact_id).toBe('c-a1')
  })

  it('refuses to attach an activity to another tenant’s contact and issues no insert', async () => {
    const db = useDb({ contacts, activities: [] })
    const res = await executeTool('create_activity', { subject: 'Call Bob', type: 'call', contact_id: 'c-b1' }, MANAGER)
    expect(res.error).toMatch(/not found/i)
    expect(db._writes.some(w => w.table === 'activities' && w.op === 'insert')).toBe(false)
  })

  it('creates an unlinked activity (no contact_id) stamped with the active location', async () => {
    const db = useDb({ contacts, activities: [] })
    const res = await executeTool('create_activity', { subject: 'General task', type: 'task' }, MANAGER)
    expect(res.success).toBe(true)
    const insert = db._writes.find(w => w.table === 'activities' && w.op === 'insert')
    expect(insert.payload.location_id).toBe('loc-a')
    expect(insert.payload.contact_id).toBeNull()
  })
})

// ── create_shift ─────────────────────────────────────────────────────
describe('executeTool create_shift — template + profile location validation', () => {
  const shift_templates = [
    { id: 't-a1', name: 'Morning', start_time: '09:00:00', end_time: '17:00:00', max_coaches: 10, location_id: 'loc-a' },
    { id: 't-b1', name: 'Other AM', start_time: '06:00:00', end_time: '12:00:00', max_coaches: 10, location_id: 'loc-b' }, // other tenant
  ]
  const profile_locations = [
    { profile_id: 'p-a1', location_id: 'loc-a' },
    { profile_id: 'p-b1', location_id: 'loc-b' }, // other tenant
  ]
  const profiles = [
    { id: 'p-a1', full_name: 'Anna Coach', active: true },
    { id: 'p-b1', full_name: 'Ben Other', active: true },
  ]

  it('creates a shift when template and profile both belong to the active location', async () => {
    const db = useDb({ shift_templates, profile_locations, profiles })
    const res = await executeTool('create_shift', { profile_id: 'p-a1', shift_template_id: 't-a1', shift_date: '2026-07-06' }, MANAGER)
    expect(res.success).toBe(true)
    expect(res.shift).toEqual({ date: '2026-07-06', staff: 'Anna Coach', template: 'Morning' })
    const block = db._writes.find(w => w.table === 'shift_blocks' && w.op === 'insert')
    expect(block.payload.location_id).toBe('loc-a')
    const assign = db._writes.find(w => w.table === 'shift_assignments' && w.op === 'upsert')
    expect(assign.payload.profile_id).toBe('p-a1')
  })

  it('rejects a cross-tenant shift_template_id and writes nothing', async () => {
    const db = useDb({ shift_templates, profile_locations, profiles })
    const res = await executeTool('create_shift', { profile_id: 'p-a1', shift_template_id: 't-b1', shift_date: '2026-07-06' }, MANAGER)
    expect(res.error).toMatch(/not found/i)
    expect(db._writes).toHaveLength(0)
  })

  it('rejects a profile_id not linked to the active location and writes nothing', async () => {
    const db = useDb({ shift_templates, profile_locations, profiles })
    const res = await executeTool('create_shift', { profile_id: 'p-b1', shift_template_id: 't-a1', shift_date: '2026-07-06' }, MANAGER)
    expect(res.error).toMatch(/not linked/i)
    expect(db._writes).toHaveLength(0)
  })

  it('refuses to create a shift when there is no active location', async () => {
    const db = useDb({ shift_templates, profile_locations, profiles })
    const res = await executeTool('create_shift', { profile_id: 'p-a1', shift_template_id: 't-a1', shift_date: '2026-07-06' }, { ...MANAGER, locationId: null })
    expect(res.error).toMatch(/active location/i)
    expect(db._writes).toHaveLength(0)
  })
})

// ── get_holiday_allowance ────────────────────────────────────────────
describe('executeTool get_holiday_allowance — target must share the location', () => {
  const profile_locations = [
    { profile_id: 'p-a1', location_id: 'loc-a' },
    { profile_id: 'p-b1', location_id: 'loc-b' }, // other tenant
  ]
  const staff_allowances = [
    { profile_id: 'p-a1', year: 2026, total_days: 25, used_days: 5, carried_over: 2 },
    { profile_id: 'p-b1', year: 2026, total_days: 30, used_days: 1, carried_over: 0 }, // other tenant
    { profile_id: 'u-1', year: 2026, total_days: 22, used_days: 3, carried_over: 1 }, // the caller themself
  ]

  it('lets a manager read a same-location staff member’s allowance', async () => {
    useDb({ profile_locations, staff_allowances })
    const res = await executeTool('get_holiday_allowance', { profile_id: 'p-a1', year: 2026 }, MANAGER)
    // toMatchObject: the mock doesn't project select columns, so the row
    // carries its fixture keys alongside the computed remaining.
    expect(res).toMatchObject({ total_days: 25, used_days: 5, carried_over: 2, remaining: 22, year: 2026 })
  })

  it('refuses a manager another tenant’s profile_id — the allowance never leaks', async () => {
    useDb({ profile_locations, staff_allowances })
    const res = await executeTool('get_holiday_allowance', { profile_id: 'p-b1', year: 2026 }, MANAGER)
    expect(res.error).toMatch(/not found/i)
    expect(res.total_days).toBeUndefined()
  })

  it('still serves a self-read when there is no active location', async () => {
    useDb({ profile_locations, staff_allowances })
    const res = await executeTool('get_holiday_allowance', { year: 2026 }, { ...MANAGER, locationId: null })
    expect(res).toMatchObject({ total_days: 22, used_days: 3, carried_over: 1, remaining: 20, year: 2026 })
  })

  it('refuses a manager a non-self read when there is no active location', async () => {
    useDb({ profile_locations, staff_allowances })
    const res = await executeTool('get_holiday_allowance', { profile_id: 'p-a1', year: 2026 }, { ...MANAGER, locationId: null })
    expect(res.error).toMatch(/active location/i)
  })

  it('serves a staff self-read', async () => {
    useDb({ profile_locations, staff_allowances: [...staff_allowances, { profile_id: 'u-9', year: 2026, total_days: 20, used_days: 4, carried_over: 0 }] })
    const res = await executeTool('get_holiday_allowance', { year: 2026 }, { locationId: 'loc-a', role: 'staff', userId: 'u-9' })
    expect(res.remaining).toBe(16)
  })

  it('still refuses staff another user’s allowance (self-only rule unchanged)', async () => {
    useDb({ profile_locations, staff_allowances })
    const res = await executeTool('get_holiday_allowance', { profile_id: 'p-a1', year: 2026 }, { locationId: 'loc-a', role: 'staff', userId: 'u-9' })
    expect(res.error).toMatch(/own holiday allowance/i)
  })
})

// ── generate_report staff_cost ───────────────────────────────────────
describe('executeTool generate_report staff_cost — profiles read is location-scoped', () => {
  const profile_locations = [
    { profile_id: 'p-a1', location_id: 'loc-a' },
    { profile_id: 'p-b1', location_id: 'loc-b' }, // other tenant
  ]
  const profiles = [
    { id: 'p-a1', full_name: 'Anna Coach', employment_type: 'contractor', hourly_rate: 20, annual_salary: null, contracted_hours_per_week: null, active: true },
    { id: 'p-b1', full_name: 'Ben Other', employment_type: 'contractor', hourly_rate: 88, annual_salary: null, contracted_hours_per_week: null, active: true }, // other tenant's rate
  ]
  // Both assignments sit inside loc-a for the period — the second
  // references the OTHER tenant's profile (the poisoned row an
  // unvalidated create_shift could produce). With the profiles read
  // scoped, its rate never enters the computation; an unscoped read
  // would surface Ben at €88 and fail the assertions.
  const shift_assignments = [
    { profile_id: 'p-a1', status: 'scheduled', start_time_override: null, end_time_override: null,
      profiles: { full_name: 'Anna Coach' },
      shift_blocks: { location_id: 'loc-a', block_date: '2026-07-02', shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '17:00:00' } } },
    { profile_id: 'p-b1', status: 'scheduled', start_time_override: null, end_time_override: null,
      profiles: { full_name: 'Ben Other' },
      shift_blocks: { location_id: 'loc-a', block_date: '2026-07-02', shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '17:00:00' } } },
  ]

  it('costs only staff linked to the active location — a foreign profile’s rate never appears', async () => {
    useDb({ profile_locations, profiles, shift_assignments })
    const res = await executeTool('generate_report', { report_type: 'staff_cost', period_start: '2026-07-01', period_end: '2026-07-07' }, MANAGER)
    expect(res.staff.map(s => s.name)).toEqual(['Anna Coach'])
    expect(res.total_cost).toBe('€160.00')
    expect(JSON.stringify(res)).not.toContain('88')
    expect(JSON.stringify(res)).not.toContain('Ben')
  })

  it('errors instead of reading anything when there is no active location', async () => {
    useDb({ profile_locations, profiles, shift_assignments })
    const res = await executeTool('generate_report', { report_type: 'staff_cost', period_start: '2026-07-01', period_end: '2026-07-07' }, { ...MANAGER, locationId: null })
    expect(res.error).toMatch(/active location/i)
  })
})

// ── null-locationId guards ───────────────────────────────────────────
describe('executeTool — safe empties when there is no active location', () => {
  it('list_shift_templates returns no templates (never an unscoped read)', async () => {
    useDb({ shift_templates: [{ id: 't-b1', name: 'Other', location_id: 'loc-b', active: true }] })
    const res = await executeTool('list_shift_templates', {}, { ...MANAGER, locationId: null })
    expect(res).toEqual({ templates: [] })
  })

  it('get_shifts_for_week returns no shifts (never an unscoped read)', async () => {
    useDb({ shift_assignments: [{ profile_id: 'p-b1', profiles: { full_name: 'Ben Other' }, shift_blocks: { location_id: 'loc-b', block_date: '2026-07-02', shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '17:00:00' } } }] })
    const res = await executeTool('get_shifts_for_week', { start_date: '2026-07-01' }, { ...MANAGER, locationId: null })
    expect(res).toEqual({ shifts: [] })
  })
})

// ── TOOL_PERMISSIONS role gate still holds ───────────────────────────
describe('executeTool — TOOL_PERMISSIONS gate is unchanged', () => {
  it('denies a staff role the manager-gated search_contacts (no query issued)', async () => {
    const db = useDb({ contacts: [{ id: 'c-a1', name: 'Alice', email: 'a@a.com', location_id: 'loc-a' }] })
    const res = await executeTool('search_contacts', { query: 'alice' }, { locationId: 'loc-a', role: 'staff', userId: 'u' })
    expect(res.error).toMatch(/permission denied/i)
    expect(db._writes).toHaveLength(0)
  })

  it('denies a head_coach the admin-gated create_contact (no row written)', async () => {
    const db = useDb({ contacts: [] })
    const res = await executeTool('create_contact', { name: 'X', email: 'x@x.com' }, { locationId: 'loc-a', role: 'head_coach', userId: 'u' })
    expect(res.error).toMatch(/permission denied/i)
    expect(db._writes.some(w => w.table === 'contacts' && w.op === 'insert')).toBe(false)
  })
})
