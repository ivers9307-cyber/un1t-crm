// CLEANUP-1 — an in-memory service-role client for the two retention crons'
// route tests (purge-glofox-webhook-events, sweep-car-document-orphans).
//
// It HONOURS every filter the routes use (eq / in / lt / gte / is / or /
// order / range / limit) instead of no-opping them, because the property
// under test IS the filter: "a row 89 days old is never deleted" is only
// proven if the route's own .lt() actually excludes it. Deletes are applied
// to the in-memory rows AND recorded, and the 1,000-row PostgREST cap is
// enforced on every read, so a route that forgets to page is caught.
//
// Failure injection, per table and operation: `errors: { <table>: { select:
// {message}, delete: {message} } }`; storage: `storageErrors: { list:
// {message} | (prefix) => error|null, remove: {message} }`. A failing call
// resolves `{ data: null, error }`, as supabase-js does.

const ROW_CAP = 1000

function cmp(a, b) {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return a < b ? -1 : 1
}

// PostgREST `or=`: only the shapes the routes generate — `col.is.null`,
// `col.lt.<v>`, `col.gte.<v>`. Anything else matches nothing, so an
// unexpected filter shows up as a failing test rather than a permissive one.
function orMatches(row, expr) {
  return expr.split(',').some((part) => {
    const m = part.trim().match(/^([a-z_]+)\.(is|lt|gte)\.(.*)$/)
    if (!m) return false
    const [, col, op, val] = m
    const v = row[col] ?? null
    if (op === 'is') return val === 'null' ? v === null : false
    if (v === null) return false
    if (op === 'lt') return v < val
    return v >= val
  })
}

function project(row, cols) {
  if (!cols || cols.trim() === '*') return { ...row }
  const out = {}
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) out[c] = row[c] ?? null
  return out
}

class Query {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.op = 'select'
    this.cols = '*'
    this.filters = []
    this.orders = []
    this.rangeFrom = null
    this.rangeTo = null
    this.limitN = null
    this.returning = null
  }
  select(cols = '*') {
    if (this.op === 'delete') this.returning = cols
    else this.cols = cols
    return this
  }
  delete() { this.op = 'delete'; return this }
  eq(col, v) { this.filters.push({ desc: `eq:${col}`, fn: (r) => (r[col] ?? null) === v }); return this }
  in(col, vs) { this.filters.push({ desc: `in:${col}:${vs.length}`, n: vs.length, col, fn: (r) => vs.includes(r[col]) }); return this }
  lt(col, v) { this.filters.push({ desc: `lt:${col}`, fn: (r) => r[col] !== null && r[col] !== undefined && r[col] < v }); return this }
  gte(col, v) { this.filters.push({ desc: `gte:${col}`, fn: (r) => r[col] !== null && r[col] !== undefined && r[col] >= v }); return this }
  is(col, v) { this.filters.push({ desc: `is:${col}`, fn: (r) => (r[col] ?? null) === v }); return this }
  or(expr) { this.filters.push({ desc: `or:${expr}`, fn: (r) => orMatches(r, expr) }); return this }
  order(col, { ascending = true } = {}) { this.orders.push({ col, ascending }); return this }
  range(a, b) { this.rangeFrom = a; this.rangeTo = b; return this }
  limit(n) { this.limitN = n; return this }

  run() {
    const db = this.db
    db.calls.push({ table: this.table, op: this.op, filters: this.filters.map((f) => f.desc), orders: this.orders.map((o) => o.col), range: this.rangeFrom === null ? null : [this.rangeFrom, this.rangeTo], inSizes: this.filters.filter((f) => f.n !== undefined).map((f) => f.n) })
    const err = db.errors?.[this.table]?.[this.op]
    if (err) {
      const e = typeof err === 'function' ? err(this) : err
      if (e) return { data: null, error: e }
    }
    const rows = db.tables[this.table] || (db.tables[this.table] = [])
    const matching = rows.filter((r) => this.filters.every((f) => f.fn(r)))
    if (this.op === 'delete') {
      const gone = new Set(matching)
      db.tables[this.table] = rows.filter((r) => !gone.has(r))
      for (const r of matching) db.deleted.push({ table: this.table, id: r.id })
      for (const cascade of db.cascades.filter((c) => c.parent === this.table)) {
        const ids = new Set(matching.map((r) => r.id))
        const child = db.tables[cascade.child] || []
        const dead = child.filter((r) => ids.has(r[cascade.fk]))
        db.tables[cascade.child] = child.filter((r) => !ids.has(r[cascade.fk]))
        for (const r of dead) db.deleted.push({ table: cascade.child, id: r.id, cascade: true })
      }
      return { data: this.returning ? matching.map((r) => project(r, this.returning)) : null, error: null }
    }
    let out = [...matching]
    if (this.orders.length) {
      out.sort((a, b) => {
        for (const o of this.orders) {
          const c = cmp(a[o.col], b[o.col])
          if (c !== 0) return o.ascending ? c : -c
        }
        return 0
      })
    }
    if (this.rangeFrom !== null) out = out.slice(this.rangeFrom, this.rangeTo + 1)
    if (this.limitN !== null) out = out.slice(0, this.limitN)
    out = out.slice(0, ROW_CAP)
    return { data: out.map((r) => project(r, this.cols)), error: null }
  }
  then(resolve, reject) {
    try { return Promise.resolve(this.run()).then(resolve, reject) } catch (e) { return Promise.reject(e).then(resolve, reject) }
  }
}

/**
 * Storage objects are `{ name: 'a/b/c.pdf', created_at, metadata? }`. list()
 * answers one folder level the way Supabase Storage does: direct files carry
 * an id and timestamps; sub-folders come back as `{ name, id: null }`.
 */
function makeBucket(db, bucketId) {
  return {
    async list(prefix = '', { limit = 100, offset = 0 } = {}) {
      db.storageCalls.push({ op: 'list', bucket: bucketId, prefix, limit, offset })
      const e = typeof db.storageErrors.list === 'function' ? db.storageErrors.list(prefix) : db.storageErrors.list
      if (e) return { data: null, error: e }
      const objects = db.buckets[bucketId] || []
      const base = prefix ? `${prefix.replace(/\/$/, '')}/` : ''
      const entries = new Map()
      for (const o of objects) {
        if (!o.name.startsWith(base)) continue
        const rest = o.name.slice(base.length)
        const slash = rest.indexOf('/')
        if (slash === -1) {
          entries.set(rest, { name: rest, id: `obj-${o.name}`, created_at: o.created_at ?? null, updated_at: o.created_at ?? null, metadata: o.metadata ?? { size: 10 } })
        } else {
          const folder = rest.slice(0, slash)
          if (!entries.has(folder)) entries.set(folder, { name: folder, id: null, created_at: null, updated_at: null, metadata: null })
        }
      }
      const sorted = [...entries.values()].sort((a, b) => cmp(a.name, b.name))
      return { data: sorted.slice(offset, offset + limit), error: null }
    },
    async remove(paths) {
      db.storageCalls.push({ op: 'remove', bucket: bucketId, paths: [...paths] })
      if (db.storageErrors.remove) return { data: null, error: db.storageErrors.remove }
      const objects = db.buckets[bucketId] || []
      const want = new Set(paths)
      const gone = objects.filter((o) => want.has(o.name))
      db.buckets[bucketId] = objects.filter((o) => !want.has(o.name))
      for (const o of gone) db.removed.push(o.name)
      return { data: gone.map((o) => ({ name: o.name })), error: null }
    },
  }
}

export function makeCleanupDb({ tables = {}, errors = {}, cascades = [], buckets = {}, storageErrors = {} } = {}) {
  const db = {
    tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
    errors,
    cascades,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.map((o) => ({ ...o }))])),
    storageErrors,
    calls: [],
    deleted: [],
    storageCalls: [],
    removed: [],
    from(table) { return new Query(db, table) },
    storage: { from: (bucketId) => makeBucket(db, bucketId) },
  }
  return db
}
