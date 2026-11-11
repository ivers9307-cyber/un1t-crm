// ASSISTREG.2 — this file now covers only the tools still LOCAL to the chat
// route: navigate_user and generate_report. The other nine run the registry
// bodies in src/lib/agent-tools/ through src/lib/assistant/tool-bridge.js, so
// their guards moved to where the code is:
//
//   the door (studio is the session's, the model cannot name one, a refusal
//   reads as { error }, the gates)   → src/lib/assistant/tool-bridge.test.js
//   the bodies (scoping, capped lists, a failed read is never an empty
//   answer, self-only allowance)     → src/lib/agent-tools/*.test.js
//
// Nothing was dropped: the per-tool properties this file was the only home for
// were appended to roster-tools.test.js and contact-tools.test.js first. The
// guards below are the SAME security regression tests described next, for the
// two tools that did not move.
//
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
    // ROSTER-FIX.5 — `range` is real here: fetchScheduledShiftRows pages, so a
    // mock that ignored .range() would loop forever on a full page.
    const state = { table, op: 'select', payload: null, opts: null, filters: [], range: null }

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
      const all = rowsAfterFilters()
      const rows = state.range ? all.slice(state.range[0], state.range[1] + 1) : all
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
      range(from, to) { state.range = [from, to]; return chain },
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

  // STAFFCOST.1 — pay rates and staff cost are owner/manager/master only.
  it('refuses a head coach, and reads no pay data', async () => {
    useDb({ profile_locations, profiles, shift_assignments })
    const res = await executeTool('generate_report', { report_type: 'staff_cost', period_start: '2026-07-01', period_end: '2026-07-07' }, { ...MANAGER, role: 'head_coach' })
    expect(res.error).toMatch(/owners and managers/i)
    expect(res.staff).toBeUndefined()
    expect(JSON.stringify(res)).not.toContain('20')
  })

  it('still lets a head coach run staff_hours', async () => {
    useDb({ profile_locations, profiles, shift_assignments })
    const res = await executeTool('generate_report', { report_type: 'staff_hours', period_start: '2026-07-01', period_end: '2026-07-07' }, { ...MANAGER, role: 'head_coach' })
    expect(res.error).toBeUndefined()
    expect(res.report).toBe('Staff Hours Worked')
  })

})

// ── generate_report hours honour adjustments (AGENTROSTER.1) ─────────
// The assistant computed hours straight off the TEMPLATE's times, so a
// manager-set partial shift billed at its template length and the assistant
// disagreed with /schedule's Reporting tab and the calendar (229h vs 257h for
// 1-16 Sep at Stillorgan). Hours now resolve override → the BLOCK's own time
// → the template, via shiftHours() — the same resolution src/lib/payroll.js
// and src/lib/report-generator.js use.
describe('executeTool generate_report — effective hours, not template hours', () => {
  const profile_locations = [{ profile_id: 'p-a1', location_id: 'loc-a' }]
  const profiles = [
    { id: 'p-a1', full_name: 'Anna Coach', employment_type: 'contractor', hourly_rate: 10, annual_salary: null, contracted_hours_per_week: null, active: true },
  ]
  // One 8h template slot. The block was moved to 6h, and the coach's own
  // override shortened it again to 4h. Only the 4h is real.
  const adjusted = [{
    profile_id: 'p-a1', status: 'scheduled',
    start_time_override: '10:00:00', end_time_override: '14:00:00',
    profiles: { full_name: 'Anna Coach' },
    shift_blocks: {
      location_id: 'loc-a', block_date: '2026-07-02',
      start_time: '09:00:00', end_time: '15:00:00',
      shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '17:00:00' },
    },
  }]

  it('staff_hours reports the coach\'s overridden window, not the template\'s', async () => {
    useDb({ profile_locations, profiles, shift_assignments: adjusted })
    const res = await executeTool('generate_report', { report_type: 'staff_hours', period_start: '2026-07-01', period_end: '2026-07-07' }, MANAGER)
    expect(res.staff).toEqual([{ name: 'Anna Coach', hours: 4 }])
    expect(res.total_hours).toBe(4)
  })

  it("falls back to the BLOCK's times when there is no override", async () => {
    const noOverride = [{ ...adjusted[0], start_time_override: null, end_time_override: null }]
    useDb({ profile_locations, profiles, shift_assignments: noOverride })
    const res = await executeTool('generate_report', { report_type: 'staff_hours', period_start: '2026-07-01', period_end: '2026-07-07' }, MANAGER)
    // 09:00-15:00 on the block, NOT 09:00-17:00 on the template.
    expect(res.staff).toEqual([{ name: 'Anna Coach', hours: 6 }])
  })

  it('staff_cost moves with the same hours, so one reply cannot disagree with itself', async () => {
    useDb({ profile_locations, profiles, shift_assignments: adjusted })
    const res = await executeTool('generate_report', { report_type: 'staff_cost', period_start: '2026-07-01', period_end: '2026-07-07' }, MANAGER)
    expect(res.staff).toEqual([{ name: 'Anna Coach', hours: 4, cost: '€40.00', hourly_rate: '€10.00' }])
    expect(res.total_cost).toBe('€40.00')
  })
})

// ── null-locationId guards ───────────────────────────────────────────
// ── RANGEVALID.1 — the model supplies these dates ────────────────────
// A bad date used to reach the database: a reversed period came back as a
// report of 0 hours ("nobody worked"), and get_time_off / get_holiday_allowance
// discarded their read errors, answering "nobody is off" / the 20-day default.
// Each is now a tool error the model can act on, returned before any read.
describe('executeTool — model-supplied dates are checked before any read (RANGEVALID.1)', () => {
  // Records every table the tool touches, so "nothing was read" is observable.
  function watched(fixtures = {}) {
    // makeDb + mockReturnValue (not useDb): react-hooks/rules-of-hooks reads
    // any use* call inside a named non-hook function as a hook call.
    const db = makeDb(fixtures)
    vi.mocked(createServerClient).mockReturnValue(db)
    const tables = []
    const from = db.from
    db.from = (t) => { tables.push(t); return from(t) }
    return { db, tables }
  }
  // One table answers { data: null, error } to any read; the rest are fixtures.
  function failingOn(table, fixtures = {}) {
    const ok = makeDb(fixtures)
    const res = { data: null, error: { message: 'connection reset' } }
    const db = {
      from: (t) => {
        if (t !== table) return ok.from(t)
        const chain = {}
        for (const op of ['select', 'eq', 'in', 'gte', 'lte', 'or', 'order', 'limit', 'range']) chain[op] = () => chain
        chain.single = () => Promise.resolve(res)
        chain.maybeSingle = () => Promise.resolve(res)
        chain.then = (f, r) => Promise.resolve(res).then(f, r)
        return chain
      },
    }
    vi.mocked(createServerClient).mockReturnValue(db)
    return db
  }

  it('generate_report: a bad period is the Reporting tab\'s refusal, and nothing is read', async () => {
    for (const report_type of ['staff_hours', 'staff_cost']) {
      for (const [period_start, period_end, error] of [
        ['2026-02-30', '2026-03-06', 'period_start and period_end must be real dates, YYYY-MM-DD'],
        [undefined, '2026-07-07', 'period_start and period_end must be real dates, YYYY-MM-DD'],
        ['last week', '2026-07-07', 'period_start and period_end must be real dates, YYYY-MM-DD'],
        ['2026-07-07', '2026-07-01', 'period_end must be on or after period_start'],
        ['2026-01-01', '2027-01-02', 'A report can cover at most 366 days'],
      ]) {
        const { tables } = watched({})
        const res = await executeTool('generate_report', { report_type, period_start, period_end }, MANAGER)
        expect(res, `${report_type} ${period_start}..${period_end}`).toEqual({ error })
        expect(tables).toEqual([])
      }
    }
  })

})
