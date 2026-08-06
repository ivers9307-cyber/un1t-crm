// Test double for the service-role client, shared by the ticket route tests.
//
// It honours eq / in / is / not / or / order / limit rather than no-opping
// them, because the property under test IS a filter: "a coach granted studio@
// must not see accounts@ tickets" is only proven if the route's own
// .in('mailbox_id', …) actually excludes rows. A permissive fake would pass
// those tests with the gate deleted.
//
// Writes are recorded AND applied to the in-memory rows, so a test can assert
// both "the route wrote this" and "the row now looks like this".

function splitTopLevel(expr) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

// Minimal PostgREST `or=` evaluator — enough for `col.in.(a,b)`, `col.is.null`
// and `col.eq.v`, which is all this surface generates.
function orMatches(row, expr) {
  return splitTopLevel(expr).some(part => {
    const m = part.trim().match(/^([a-z_]+)\.(in|is|eq)\.(.*)$/)
    if (!m) return false
    const [, col, op, rawVal] = m
    const value = row[col] ?? null
    if (op === 'is') return rawVal === 'null' ? value === null : String(value) === rawVal
    if (op === 'eq') return String(value) === rawVal
    const list = rawVal.replace(/^\(/, '').replace(/\)$/, '')
      .split(',').map(v => v.trim().replace(/^"|"$/g, ''))
    return list.includes(value)
  })
}

function matches(row, f) {
  const [kind, col, a, b] = f
  const value = row[col] ?? null
  switch (kind) {
    case 'eq': return value === a
    case 'in': return Array.isArray(a) && a.includes(value)
    case 'is': return a === null ? value === null : value === a
    case 'not': return a === 'is' && b === null ? value !== null : true
    case 'or': return orMatches(row, col)
    default: return true
  }
}

const TABLE_KEYS = {
  email_mailboxes: 'mailboxes',
  email_mailbox_access: 'grants',
  email_tickets: 'tickets',
  email_inbox_messages: 'messages',
  email_sends: 'sends',
  contacts: 'contacts',
}

export function makeDb(state = {}) {
  const s = {
    mailboxes: [], grants: [], tickets: [], messages: [], sends: [], contacts: [],
    ...state,
  }
  const db = { inserts: [], updates: [], _state: s }
  let seq = 0

  function rowsFor(b) {
    const key = TABLE_KEYS[b._table]
    let rows = (key ? s[key] : []).filter(r => b._filters.every(f => matches(r, f)))
    if (b._order) {
      const { column, ascending } = b._order
      rows = [...rows].sort((x, y) => {
        const a = x[column] ?? ''
        const c = y[column] ?? ''
        if (a === c) return 0
        return (a < c ? -1 : 1) * (ascending ? 1 : -1)
      })
    }
    if (typeof b._limit === 'number') rows = rows.slice(0, b._limit)
    return rows
  }

  function settle(b, shape) {
    const key = TABLE_KEYS[b._table]
    if (b._op === 'insert') {
      db.inserts.push({ table: b._table, payload: b._payload })
      const row = { id: `new-${b._table}-${++seq}`, created_at: `2026-08-06T12:00:0${seq}Z`, ...b._payload }
      if (key) s[key].push(row)
      return { data: row, error: null }
    }
    if (b._op === 'update') {
      db.updates.push({ table: b._table, payload: b._payload, filters: b._filters })
      const hit = (key ? s[key] : []).filter(r => b._filters.every(f => matches(r, f)))
      for (const r of hit) Object.assign(r, b._payload)
      return { data: hit[0] ?? null, error: null }
    }
    const rows = rowsFor(b)
    return shape === 'list' ? { data: rows, error: null } : { data: rows[0] ?? null, error: null }
  }

  db.from = (table) => {
    const b = { _table: table, _op: 'select', _payload: null, _filters: [], _order: null, _limit: null }
    const filter = (kind) => (...args) => { b._filters.push([kind, ...args]); return b }
    b.select = () => b
    b.insert = (p) => { b._op = 'insert'; b._payload = p; return b }
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.eq = filter('eq')
    b.in = filter('in')
    b.is = filter('is')
    b.not = filter('not')
    b.or = filter('or')
    b.ilike = filter('ilike')
    b.order = (column, opts = {}) => { b._order = { column, ascending: opts.ascending !== false }; return b }
    b.limit = (n) => { b._limit = n; return b }
    b.single = () => Promise.resolve(settle(b, 'single'))
    b.maybeSingle = () => Promise.resolve(settle(b, 'single'))
    // supabase-js builders are thenables, not Promises — mirror that exactly.
    b.then = (res, rej) => Promise.resolve(settle(b, 'list')).then(res, rej)
    return b
  }
  db.rpc = () => Promise.resolve({ data: null, error: null })
  return db
}

export const insertsInto = (db, table) => db.inserts.filter(i => i.table === table)
export const updatesTo = (db, table) => db.updates.filter(u => u.table === table)
