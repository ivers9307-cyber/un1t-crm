// INBOXASSIGN.1 — a small in-memory stand-in for the service-role client,
// for the assignment lib and its three routes. It APPLIES eq / in / is
// filters to the rows it holds (a mock that answers any query with fixed rows
// would pass a route that forgot its studio filter), records every call, and
// can be told to fail one table+operation or to make an update match nothing.
// Test-only (the *.test-helpers name keeps it out of the source scans).

export function memoryDb(tables = {}, { fail = {}, zeroRowUpdate = [] } = {}) {
  const calls = []
  const state = Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map(r => ({ ...r }))]))

  function from(table) {
    let op = 'select'
    let payload = null
    let returnRows = false
    let single = null
    const filters = []
    const filterLog = []
    const builder = {
      select() { if (op === 'update') returnRows = true; return builder },
      update(p) { op = 'update'; payload = p; return builder },
      eq(c, v) { filters.push(r => r[c] === v); filterLog.push(['eq', c, v]); return builder },
      in(c, vs) { filters.push(r => vs.includes(r[c])); filterLog.push(['in', c, vs]); return builder },
      is(c, v) { filters.push(r => (r[c] ?? null) === v); filterLog.push(['is', c, v]); return builder },
      limit() { return builder },
      order() { return builder },
      maybeSingle() { single = 'maybe'; return builder },
      single() { single = 'one'; return builder },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }
    function run() {
      calls.push({ table, op, payload, filters: filterLog })
      const err = fail[`${table}:${op}`]
      if (err) return { data: null, error: err }
      const rows = (state[table] || []).filter(r => filters.every(f => f(r)))
      if (op === 'update') {
        if (zeroRowUpdate.includes(table)) return { data: [], error: null }
        for (const r of rows) Object.assign(r, payload)
        return { data: returnRows ? rows.map(r => ({ ...r })) : null, error: null }
      }
      if (single === 'maybe') return { data: rows[0] ? { ...rows[0] } : null, error: null }
      if (single === 'one') {
        return rows.length === 1
          ? { data: { ...rows[0] }, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'not exactly one row' } }
      }
      return { data: rows.map(r => ({ ...r })), error: null }
    }
    return builder
  }

  return { from, calls, state }
}

// ── Synthetic world (public repo: no real names) ─────────────────────────
export const LOC_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
export const LOC_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
export const MAILBOX_A = 'cccccccc-0000-4000-8000-00000000000c'

export const ME = '10000000-0000-4000-8000-000000000001'      // manager at A (the caller)
export const ALEX = '10000000-0000-4000-8000-000000000002'    // head coach at A: WhatsApp yes, email no
export const BLAIR = '10000000-0000-4000-8000-000000000003'   // head coach at A, WhatsApp switched off for them
export const PAT = '10000000-0000-4000-8000-000000000004'     // staff at A, phone WhatsApp switched on
export const CASEY = '10000000-0000-4000-8000-000000000005'   // manager at B only
export const DREW = '10000000-0000-4000-8000-000000000006'    // deleted (tombstone) manager at A
export const EVAN = '10000000-0000-4000-8000-000000000007'    // deactivated manager at A
export const MORGAN = '10000000-0000-4000-8000-000000000008'  // head coach at A with email + a mailbox grant
export const OWNER = '10000000-0000-4000-8000-000000000009'   // owner at A

export function staffWorld(extra = {}) {
  return {
    profiles: [
      { id: ME, full_name: 'Test Manager', role: 'manager', employment_type: null, active: true, deleted_at: null, annual_salary: 99999 },
      { id: ALEX, full_name: 'Alex Example', role: 'head_coach', employment_type: null, active: true, deleted_at: null },
      { id: BLAIR, full_name: 'Blair Example', role: 'head_coach', employment_type: null, active: true, deleted_at: null },
      { id: PAT, full_name: 'Pat Example', role: 'staff', employment_type: null, active: true, deleted_at: null },
      { id: CASEY, full_name: 'Casey Example', role: 'manager', employment_type: null, active: true, deleted_at: null },
      { id: DREW, full_name: 'Drew Example', role: 'staff', employment_type: null, active: false, deleted_at: '2026-10-01T00:00:00Z' },
      { id: EVAN, full_name: 'Evan Example', role: 'manager', employment_type: null, active: false, deleted_at: null },
      { id: MORGAN, full_name: 'Morgan Example', role: 'head_coach', employment_type: null, active: true, deleted_at: null },
      { id: OWNER, full_name: 'Olive Owner', role: 'owner', employment_type: null, active: true, deleted_at: null },
    ],
    profile_locations: [
      { profile_id: ME, location_id: LOC_A, role: 'manager', permissions: {} },
      { profile_id: ALEX, location_id: LOC_A, role: 'head_coach', permissions: {} },
      { profile_id: BLAIR, location_id: LOC_A, role: 'head_coach', permissions: { whatsapp: false, mobile: { whatsapp: false } } },
      { profile_id: PAT, location_id: LOC_A, role: 'staff', permissions: { mobile: { whatsapp: true } } },
      { profile_id: CASEY, location_id: LOC_B, role: 'manager', permissions: {} },
      { profile_id: DREW, location_id: LOC_A, role: 'manager', permissions: {} },
      { profile_id: EVAN, location_id: LOC_A, role: 'manager', permissions: {} },
      { profile_id: MORGAN, location_id: LOC_A, role: 'head_coach', permissions: { email_inbox: true } },
      { profile_id: OWNER, location_id: LOC_A, role: 'owner', permissions: {} },
    ],
    location_role_permissions: [],
    locations: [
      { id: LOC_A, features: {} },
      { id: LOC_B, features: {} },
    ],
    email_mailbox_access: [
      { mailbox_id: MAILBOX_A, profile_id: MORGAN },
    ],
    ...extra,
  }
}
