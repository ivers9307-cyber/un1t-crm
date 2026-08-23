// SHELLY-UI.5 — the fake Supabase the five device-detail suites share.
//
// IT FILTERS ON THE RECORDED CALLS, and that is the entire point. The row
// store is ESTATE-WIDE — LOC_A's device and LOC_B's device sit in the same
// array — so a handler that drops `.eq('location_id', …)` reads (or writes)
// the other studio's row and the test fails, rather than passing against a
// conveniently single-tenant fixture. Every one of these routes is an IDOR if
// that filter goes missing, so the fixture has to be able to catch it.
//
// It also projects like PostgREST (`splitCols`/`project`), so an assertion
// that a column never reaches a response is about the route's select list and
// not about the fixture being thin.
//
// Deliberately NOT a module the routes can import: `.test-helpers.js` is
// outside vitest's `*.test.js` include glob and outside anything Next builds.



export const LOC_A = 'a0000000-0000-0000-0000-000000000001'
export const LOC_B = 'b0000000-0000-0000-0000-000000000002'
export const ORG_1 = '11111111-1111-4111-8111-111111111111'
export const ORG_2 = '22222222-2222-4222-8222-222222222222'

// UUID-SHAPED ON PURPOSE. ShellyOverride.set_by is uuidLike, and the toggle
// route parses the override it is about to write — a 'u-owner' style id would
// make every toggle test exercise the refusal path instead of the happy one.
export const OWNER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
export const MANAGER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'
export const STAFF_ID = 'cccccccc-1111-4111-8111-cccccccccccc'

export const DEV_A = 'd0000000-0000-4000-8000-00000000000a'
export const DEV_B = 'd0000000-0000-4000-8000-00000000000b'
export const BAD_ID = 'not-a-uuid'

export const HOST = 'shelly-68-eu.shelly.cloud'
export const STORED_KEY = 'STOREDKEY_abcdef0123456789'
export const SHELLY_ID = 'aabbcc112233'

export const locA = { id: LOC_A, organization_id: ORG_1, features: {}, name: 'UN1T Stillorgan', timezone: 'Europe/Dublin' }
// Same location id, different zone: the timezone tests differ from the scoping
// tests in exactly one field, so nothing else can explain their results.
export const locNY = { ...locA, name: 'UN1T Manhattan', timezone: 'America/New_York' }

export const userFor = (role, id, activeLocation = locA) => ({
  id,
  role,
  profileRole: role,
  rolesByLocation: { [activeLocation.id]: role },
  activeLocation,
})

export const OWNER_A = userFor('owner', OWNER_ID)
export const MANAGER_A = userFor('manager', MANAGER_ID)
export const STAFF_A = userFor('staff', STAFF_ID)
export const OWNER_NY = userFor('owner', OWNER_ID, locNY)

export const connectionRow = (over = {}) => ({
  id: 'conn-1',
  location_id: LOC_A,
  host: HOST,
  auth_key: STORED_KEY,
  auth_key_fingerprint: 'f'.repeat(64),
  key_hint: '6789',
  status: 'connected',
  last_ok_at: '2026-08-22T10:00:00.000Z',
  last_error: null,
  last_error_at: null,
  created_at: '2026-08-20T09:00:00.000Z',
  updated_at: '2026-08-22T10:00:00.000Z',
  ...over,
})

// A row as the TABLE holds it — `adopted_by` included, so an allowlist
// assertion is about the route's select list.
export const deviceRow = (over = {}) => ({
  id: DEV_A,
  location_id: LOC_A,
  device_id: SHELLY_ID,
  channel: 0,
  name: 'Sauna plug',
  model: 'SNPL-00112EU',
  gen: 2,
  zone: null,
  enabled: true,
  schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '21:00' }],
  class_rule: {},
  override: null,
  last_applied: null,
  last_state: null,
  last_seen_at: '2026-08-23T11:59:00.000Z',
  adopted_by: OWNER_ID,
  created_at: '2026-08-20T09:00:00.000Z',
  updated_at: '2026-08-20T09:00:00.000Z',
  ...over,
})

// The full seven-field shape mig 562 requires of every last_state writer.
export const fullState = (over = {}) => ({
  online: true,
  output: false,
  apower: 12.5,
  aenergy_wh: 900,
  temperature_c: 31.5,
  source: 'timer',
  at: '2026-08-23T11:59:00.000Z',
  ...over,
})

export const energyRow = (over = {}) => ({
  device_id: DEV_A,
  location_id: LOC_A,
  day: '2026-08-23',
  wh_start: 0,
  wh_last: 1500,
  wh_total: 1500,
  samples: 1440,
  resets: 0,
  first_sample_at: '2026-08-23T00:00:00.000Z',
  last_sample_at: '2026-08-23T23:59:00.000Z',
  ...over,
})

// ——— PostgREST-shaped projection ————————————————————————————————————
function splitCols(cols) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of String(cols)) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

export function project(row, cols) {
  if (!cols || cols === '*') return { ...row }
  const out = {}
  for (const col of splitCols(cols)) {
    const embed = col.match(/^([A-Za-z_]+)(?:!\w+)?\(/)
    const key = embed ? embed[1] : col
    out[key] = row[key] === undefined ? null : row[key]
  }
  return out
}

/**
 * @param cfg {{
 *   rows?: Record<string, object[]>,      // table -> rows (estate-wide)
 *   selectError?: Record<string, object>, // table -> the error a read yields
 *   updateError?: Record<string, object>,
 *   deleteError?: Record<string, object>,
 * }}
 *
 * Each error entry is either an error object or a FUNCTION of the recorded
 * call state — the second form is what lets a suite fail the toggle's second
 * write (the stamp) while letting its first (the override) through, which is
 * the exact split the "a lost stamp is not a lost switch" rule turns on.
 */
export function makeDb(cfg = {}) {
  const conf = {
    rows: { shelly_devices: [deviceRow()], shelly_connections: [connectionRow()], shelly_energy_daily: [], ...(cfg.rows || {}) },
    selectError: cfg.selectError || {},
    updateError: cfg.updateError || {},
    deleteError: cfg.deleteError || {},
  }
  const calls = { selects: [], updates: [], deletes: [], inserts: [] }

  const tableRows = (t) => (conf.rows[t] ||= [])

  // An entry may be an error object or a function of the call state.
  const errorFor = (bag, st) => {
    const raw = bag[st.table]
    return (typeof raw === 'function' ? raw(st) : raw) || null
  }

  // Postgres compares a `date` column AS A DATE, not as text: a row whose
  // value arrives timestamp-shaped ('2026-08-23T00:00:00') is still inside a
  // `day <= '2026-08-23'` range, where a naive string compare would put it
  // outside. Modelled here on purpose — the route's own day-key normalisation
  // only matters in a world where such a row can come BACK from the query, so
  // a fake that filtered it out would make that test vacuous.
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
  const rangeValue = (rowVal, filterVal) =>
    typeof filterVal === 'string' && DATE_ONLY.test(filterVal) && typeof rowVal === 'string' && rowVal.length > 10
      ? rowVal.slice(0, 10)
      : rowVal

  const matches = (row, st) =>
    Object.entries(st.filters).every(([k, v]) => row[k] === v) &&
    Object.entries(st.ins).every(([k, v]) => (v || []).includes(row[k])) &&
    Object.entries(st.gte).every(([k, v]) => rangeValue(row[k], v) >= v) &&
    Object.entries(st.lte).every(([k, v]) => rangeValue(row[k], v) <= v)

  function hits(st) {
    let out = tableRows(st.table).filter((r) => matches(r, st))
    for (const [col, opts] of st.orders) {
      const dir = opts?.ascending === false ? -1 : 1
      out = [...out].sort((a, b) => (a[col] > b[col] ? dir : a[col] < b[col] ? -dir : 0))
    }
    if (st.limit != null) out = out.slice(0, st.limit)
    return out
  }

  function readList(st) {
    const err = errorFor(conf.selectError, st)
    if (err) return { data: null, count: null, error: err }
    const list = hits(st)
    if (st.selectOpts?.head) return { data: null, count: list.length, error: null }
    return { data: list.map((r) => project(r, st.cols)), count: list.length, error: null }
  }

  function writeRows(st) {
    const err = errorFor(conf.updateError, st)
    if (err) return { rows: null, error: err }
    const touched = hits(st)
    for (const r of touched) Object.assign(r, st.payload)
    return { rows: touched, error: null }
  }

  function deleteRows(st) {
    const err = errorFor(conf.deleteError, st)
    if (err) return { removed: 0, error: err }
    const list = tableRows(st.table)
    const kept = list.filter((r) => !matches(r, st))
    conf.rows[st.table] = kept
    return { removed: list.length - kept.length, error: null }
  }

  function terminalRow(st, { strict }) {
    if (st.op === 'update') {
      const { rows, error } = writeRows(st)
      if (error) return { data: null, error }
      if (!rows.length) {
        return strict ? { data: null, error: { code: 'PGRST116', message: 'no rows returned' } } : { data: null, error: null }
      }
      return { data: project(rows[0], st.cols), error: null }
    }
    if (st.op === 'delete') {
      const { error } = deleteRows(st)
      return { data: null, error: error || null }
    }
    const err = errorFor(conf.selectError, st)
    if (err) return { data: null, error: err }
    const list = hits(st)
    if (!list.length) {
      return strict ? { data: null, error: { code: 'PGRST116', message: 'no rows returned' } } : { data: null, error: null }
    }
    return { data: project(list[0], st.cols), error: null }
  }

  function terminalList(st) {
    if (st.op === 'update') {
      const { rows, error } = writeRows(st)
      if (error) return { data: null, count: null, error }
      return { data: rows.map((r) => project(r, st.cols)), count: rows.length, error: null }
    }
    if (st.op === 'delete') {
      const { removed, error } = deleteRows(st)
      return { data: null, count: error ? null : removed, error: error || null }
    }
    return readList(st)
  }

  return {
    conf,
    calls,
    rowsIn: (table) => tableRows(table),
    from(table) {
      const st = {
        table, op: 'select', cols: null, selectOpts: null,
        filters: {}, ins: {}, gte: {}, lte: {}, orders: [], limit: null, payload: null,
      }
      const b = {
        select: (cols, opts) => {
          st.cols = cols
          if (opts) st.selectOpts = opts
          if (st.op === 'select') calls.selects.push(st)
          return b
        },
        eq: (col, val) => { st.filters[col] = val; return b },
        in: (col, vals) => { st.ins[col] = vals; return b },
        gte: (col, val) => { st.gte[col] = val; return b },
        lte: (col, val) => { st.lte[col] = val; return b },
        order: (col, opts) => { st.orders.push([col, opts]); return b },
        limit: (n) => { st.limit = n; return b },
        update: (payload) => { st.op = 'update'; st.payload = payload; calls.updates.push(st); return b },
        delete: () => { st.op = 'delete'; calls.deletes.push(st); return b },
        insert: (payload) => { st.op = 'insert'; st.payload = payload; calls.inserts.push(st); return b },
        maybeSingle: () => Promise.resolve(terminalRow(st, { strict: false })),
        single: () => Promise.resolve(terminalRow(st, { strict: true })),
        then: (ok, err) => Promise.resolve(terminalList(st)).then(ok, err),
      }
      return b
    },
  }
}

/** Recorded writes to one table, in order. */
export const updatesTo = (db, table) => db.calls.updates.filter((u) => u.table === table)
export const deletesFrom = (db, table) => db.calls.deletes.filter((d) => d.table === table)
export const selectsFrom = (db, table) => db.calls.selects.filter((s) => s.table === table)

/** A Request for a route that takes no body. */
export const req = (url = 'http://localhost/api/shelly/x', init = {}) => new Request(url, { method: 'POST', ...init })

export const jsonReq = (body, url = 'http://localhost/api/shelly/x', method = 'POST') =>
  new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Next 15+ hands route handlers a params PROMISE — withAuth awaits it. */
export const ctxFor = (id) => ({ params: Promise.resolve({ id }) })
