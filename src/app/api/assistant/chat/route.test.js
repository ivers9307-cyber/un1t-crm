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
//   - move_deal moved a deal by id with no ownership check
//   - create_activity attached to a client-supplied contact_id with no
//     ownership check and stamped no location_id
// These tests pin the scoped behaviour: every tenant-data tool is
// confined to context.locationId (the server-trusted active location),
// and the existing TOOL_PERMISSIONS role gate still holds.
//
// Approach: executeTool calls createServerClient() internally, so we mock
// @/lib/supabase to return a tiny in-memory Supabase-shaped client that
// ACTUALLY applies the eq / in / or(ilike) filters it is given against a
// two-location fixture. A forgotten `.eq('location_id', …)` would then
// return loc-b's rows and fail the assertion — a real leak guard, not a
// spy check. @/lib/auth is mocked only to keep its next/headers import
// out of the node test env (executeTool never calls it).

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
  const writes = [] // every insert/update, for write-scoping assertions

  function builder(table) {
    const state = { table, op: 'select', payload: null, filters: [] }

    function rowsAfterFilters() {
      let rows = (fixtures[table] || []).slice()
      for (const f of state.filters) {
        if (f.type === 'eq') rows = rows.filter(r => r[f.col] === f.val)
        else if (f.type === 'in') rows = rows.filter(r => f.val.includes(r[f.col]))
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
      if (state.op === 'insert') {
        const payloads = Array.isArray(state.payload) ? state.payload : [state.payload]
        const inserted = payloads.map((p, i) => ({ id: `${table}-new-${i}`, ...p }))
        writes.push({ table, op: 'insert', payload: state.payload })
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
      eq(col, val) { state.filters.push({ type: 'eq', col, val }); return chain },
      in(col, val) { state.filters.push({ type: 'in', col, val }); return chain },
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
// the gate for all five tools under test.
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

// ── move_deal ────────────────────────────────────────────────────────
describe('executeTool move_deal — cross-tenant ownership check', () => {
  const pipeline_stages = [{ id: 'stage-member', slug: 'member' }]
  const deals = [
    { id: 'd-a', title: 'Alice deal', location_id: 'loc-a', stage_id: 'stage-old' },
    { id: 'd-b', title: 'Bob deal', location_id: 'loc-b', stage_id: 'stage-old' }, // other tenant
  ]

  it('moves a deal that belongs to the caller’s location', async () => {
    const db = useDb({ pipeline_stages, deals })
    const res = await executeTool('move_deal', { deal_id: 'd-a', stage_slug: 'member' }, MANAGER)
    expect(res.success).toBe(true)
    expect(res.deal.id).toBe('d-a')
    expect(res.moved_to).toBe('member')
    expect(db._writes.some(w => w.table === 'deals' && w.op === 'update')).toBe(true)
  })

  it('refuses to move another tenant’s deal and issues no update', async () => {
    const db = useDb({ pipeline_stages, deals })
    const res = await executeTool('move_deal', { deal_id: 'd-b', stage_slug: 'member' }, MANAGER)
    expect(res.error).toMatch(/not found/i)
    expect(db._writes.some(w => w.table === 'deals' && w.op === 'update')).toBe(false)
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
