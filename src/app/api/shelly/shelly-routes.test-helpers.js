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
// SHELLYGROUPS.5 — groups, one per studio by default.
export const GRP_A = '90000000-0000-4000-8000-00000000000a'
export const GRP_B = '90000000-0000-4000-8000-00000000000b'
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

// A shelly_groups row as the table holds it (mig 776), created_by included so
// an allowlist assertion is about the route's select list.
export const groupRow = (over = {}) => ({
  id: GRP_A,
  location_id: LOC_A,
  name: 'Gym floor',
  icon: 'bulb',
  sort_order: 0,
  enabled: false,
  schedule_mode: 'none',
  fixed_windows: [],
  class_rule: {},
  override: null,
  last_applied: null,
  created_by: OWNER_ID,
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
    // `alias:col->a->b` (a JSON path, as the safety-timer switch reads it):
    // the alias is the key, and the path is walked into the jsonb column.
    const aliased = !embed && col.match(/^([A-Za-z_]+):(.+)$/)
    if (aliased) {
      const [base, ...path] = aliased[2].split('->').map((x) => x.trim())
      let v = row[base]
      for (const k of path) v = v && typeof v === 'object' ? v[k] : undefined
      out[aliased[1]] = v === undefined ? null : v
      continue
    }
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
    insertError: cfg.insertError || {},
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

  // PostgREST ilike: % and _ are wildcards, a backslash escapes the next
  // character, and the match is case-insensitive. Modelled for real (not as
  // lower(a) === lower(b)) so an unescaped `_` in a name is caught here.
  const ilikeRx = (pat) => {
    let src = ''
    const str = String(pat)
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]
      if (ch === '\\' && i + 1 < str.length) { src += str[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue }
      if (ch === '%') { src += '.*'; continue }
      if (ch === '_') { src += '.'; continue }
      src += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
    return new RegExp(`^${src}$`, 'is')
  }

  const matches = (row, st) =>
    Object.entries(st.filters).every(([k, v]) => row[k] === v) &&
    Object.entries(st.neqs).every(([k, v]) => row[k] !== v) &&
    Object.entries(st.iss).every(([k, v]) => (v === null ? row[k] == null : row[k] === v)) &&
    Object.entries(st.ilikes).every(([k, v]) => row[k] != null && ilikeRx(v).test(String(row[k]))) &&
    Object.entries(st.lt).every(([k, v]) => rangeValue(row[k], v) < v) &&
    Object.entries(st.ins).every(([k, v]) => (v || []).includes(row[k])) &&
    Object.entries(st.gte).every(([k, v]) => rangeValue(row[k], v) >= v) &&
    Object.entries(st.lte).every(([k, v]) => rangeValue(row[k], v) <= v)

  function hits(st) {
    let out = tableRows(st.table).filter((r) => matches(r, st))
    // ORDER BY a, b: a decides, b breaks its ties (not "the last .order() wins").
    if (st.orders.length) {
      out = [...out].sort((a, b) => {
        for (const [col, opts] of st.orders) {
          const dir = opts?.ascending === false ? -1 : 1
          if (a[col] > b[col]) return dir
          if (a[col] < b[col]) return -dir
        }
        return 0
      })
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

  let seq = 0
  function insertRows(st) {
    const err = errorFor(conf.insertError, st)
    if (err) return { rows: null, error: err }
    const list = Array.isArray(st.payload) ? st.payload : [st.payload]
    const made = list.map((p) => ({ id: `ins-${st.table}-${++seq}`, ...p }))
    tableRows(st.table).push(...made)
    return { rows: made, error: null }
  }

  function terminalRow(st, { strict }) {
    if (st.op === 'insert') {
      const { rows, error } = insertRows(st)
      if (error) return { data: null, error }
      return { data: project(rows[0], st.cols), error: null }
    }
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
    if (st.op === 'insert') {
      const { rows, error } = insertRows(st)
      if (error) return { data: null, error }
      return { data: rows.map((r) => project(r, st.cols)), error: null }
    }
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
        filters: {}, ins: {}, gte: {}, lte: {}, lt: {}, neqs: {}, iss: {}, ilikes: {}, orders: [], limit: null, payload: null,
      }
      const b = {
        select: (cols, opts) => {
          st.cols = cols
          if (opts) st.selectOpts = opts
          if (st.op === 'select' && !calls.selects.includes(st)) calls.selects.push(st)
          return b
        },
        eq: (col, val) => { st.filters[col] = val; return b },
        in: (col, vals) => { st.ins[col] = vals; return b },
        gte: (col, val) => { st.gte[col] = val; return b },
        lte: (col, val) => { st.lte[col] = val; return b },
        lt: (col, val) => { st.lt[col] = val; return b },
        neq: (col, val) => { st.neqs[col] = val; return b },
        is: (col, val) => { st.iss[col] = val; return b },
        ilike: (col, val) => { st.ilikes[col] = val; return b },
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
export const insertsTo = (db, table) => db.calls.inserts.filter((i) => i.table === table)

/** A Request for a route that takes no body. */
export const req = (url = 'http://localhost/api/shelly/x', init = {}) => new Request(url, { method: 'POST', ...init })

export const jsonReq = (body, url = 'http://localhost/api/shelly/x', method = 'POST') =>
  new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Next 15+ hands route handlers a params PROMISE — withAuth awaits it. */
export const ctxFor = (id) => ({ params: Promise.resolve({ id }) })
