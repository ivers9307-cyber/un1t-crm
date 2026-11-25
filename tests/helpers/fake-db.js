// FAKEDB.1 — one in-memory supabase client for tests, checked against the real
// schema (supabase/schema/snapshot.json).
//
// Hundreds of test files hand-roll a fake that accepts any table, column or
// function name. That is how a column that never existed passed every test for
// months. This one throws FakeDbSchemaError on a name the database does not
// have, in selects, embeds, filters, ordering, writes and rpc arguments, so the
// mistake fails the test that made it.
//
// It also keeps the behaviour that fakes usually paper over:
//   - a read returns at most 1,000 rows, whatever .limit() or .range() ask for;
//   - NULL never matches eq, neq or a comparison;
//   - .single() errors unless exactly one row matched;
//   - an insert without a NOT NULL, no-default column fails (23502);
//   - two possible relationships for an embed fail (PGRST201) without a hint;
//   - builders are thenables with no .catch, and a failed query RESOLVES.
//
//   const db = createFakeDb({
//     tables: { contacts: [{ id: 'c1', email: 'a@example.com' }] },
//     rpc: { my_fn: (args) => 42 },
//     errors: { contacts: { update: { message: 'boom' } } },
//   })
//
// `db.tables` is the live data; `db.calls` lists every query that ran, with
// its column filters as { column, op, value }.
// Seed rows are checked for column names but need not fill every column.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanSelectString, splitTopLevel } from '../../scripts/check-select-columns.mjs'
import { ilikeMatches } from '../../src/lib/like-escape.test-helpers.js'
import { parseArgs } from '../../scripts/lib/db-types.mjs'

const ROW_CAP = 1000
const snapshot = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../supabase/schema/snapshot.json'), 'utf8'))
const foreignKeys = snapshot.foreign_keys
  .filter(([t, , ref]) => !t.includes('.') && !ref.includes('.'))
  .map(([table, cols, ref, refCols]) => ({ table, column: cols[0], ref, refColumn: refCols[0], single: cols.length === 1 }))
  .filter((f) => f.single)
const functions = new Map()
for (const [name, args] of snapshot.functions) {
  if (!functions.has(name)) functions.set(name, [])
  functions.get(name).push(new Set(parseArgs(args).map(([a]) => a)))
}

export class FakeDbSchemaError extends Error {
  constructor(message) { super(`[fake-db] ${message}`); this.name = 'FakeDbSchemaError' }
}

const relation = (t) => {
  const r = snapshot.relations[t]
  if (!r) throw new FakeDbSchemaError(`relation '${t}' does not exist`)
  return r
}
const columnNames = (t) => new Set(relation(t).columns.map((c) => c[0]))
const rootColumn = (c) => String(c).split('->')[0].trim()
function assertColumn(table, column) {
  const root = rootColumn(column)
  if (!columnNames(table).has(root)) throw new FakeDbSchemaError(`column '${root}' does not exist on '${table}'`)
  return root
}

/** Find the foreign key an embed follows. */
function resolveEmbed(table, rel, hint) {
  const asColumn = foreignKeys.find((f) => f.table === table && f.column === rel)
  const target = snapshot.relations[rel] ? rel : asColumn?.ref
  if (!target) throw new FakeDbSchemaError(`no relation '${rel}' to embed from '${table}'`)
  let options = [
    ...foreignKeys.filter((f) => f.table === table && f.ref === target).map((f) => ({ ...f, many: false })),
    ...foreignKeys.filter((f) => f.table === target && f.ref === table).map((f) => ({ ...f, many: true })),
  ]
  if (!snapshot.relations[rel] && asColumn) options = options.filter((o) => !o.many && o.column === rel)
  if (hint) options = options.filter((o) => o.column === hint || `${o.table}_${o.column}_fkey` === hint)
  if (options.length === 0) throw new FakeDbSchemaError(`no relationship between '${table}' and '${rel}'${hint ? ` using '${hint}'` : ''}`)
  if (options.length > 1) throw new FakeDbSchemaError(`PGRST201: more than one relationship between '${table}' and '${rel}': add a hint`)
  return { target, ...options[0] }
}

/** Parse and validate a select string into a projection tree. */
export function parseSelection(select, table) {
  const items = []
  for (const raw of splitTopLevel(cleanSelectString(select || '*'))) {
    if (!raw) continue
    const spread = raw.startsWith('...')
    const item = spread ? raw.slice(3) : raw
    const paren = item.indexOf('(')
    if (paren > 0 && !/\.(count|sum|avg|min|max)\(\)/.test(item) && item !== 'count()') {
      const head = item.slice(0, paren)
      const colon = head.indexOf(':')
      const [rel, ...marks] = (colon >= 0 ? head.slice(colon + 1) : head).split('!')
      const inner = marks.includes('inner')
      const hint = marks.find((m) => m !== 'inner' && m !== 'left') || null
      const link = resolveEmbed(table, rel, hint)
      items.push({ embed: true, spread, alias: colon >= 0 ? head.slice(0, colon) : rel, rel, inner, link, children: parseSelection(item.slice(paren + 1, item.lastIndexOf(')')), link.target) })
    } else if (item === '*') {
      items.push({ star: true })
    } else if (item === 'count()' || item === 'count') {
      items.push({ count: true })
    } else {
      const noCast = item.split('::')[0]
      const colon = noCast.indexOf(':')
      const source = colon >= 0 ? noCast.slice(colon + 1) : noCast
      const name = source.replace(/\.(count|sum|avg|min|max)\(\)$/, '')
      const root = assertColumn(table, name)
      const path = name.split(/->>?/).slice(1).map((p) => p.trim().replace(/^'|'$/g, ''))
      items.push({ column: root, path, alias: colon >= 0 ? noCast.slice(0, colon) : (path.at(-1) || root) })
    }
  }
  return items
}

const isNil = (v) => v === null || v === undefined
function compare(a, b) {
  const [x, y] = [Number(a), Number(b)]
  if (typeof a !== 'boolean' && a !== '' && b !== '' && !Number.isNaN(x) && !Number.isNaN(y)) return x - y
  const [p, q] = [String(a), String(b)]
  if (/^\d{4}-\d{2}-\d{2}T/.test(p) && /^\d{4}-\d{2}-\d{2}/.test(q)) return Date.parse(p) - Date.parse(q)
  return p < q ? -1 : p > q ? 1 : 0
}
function readPath(row, col) {
  const parts = String(col).split(/->>?/).map((p) => p.trim().replace(/^'|'$/g, ''))
  let v = row[parts[0]]
  for (const p of parts.slice(1)) v = isNil(v) ? null : v[p]
  return v ?? null
}
const OPS = {
  eq: (v, x) => !isNil(v) && compare(v, x) === 0,
  neq: (v, x) => !isNil(v) && compare(v, x) !== 0,
  gt: (v, x) => !isNil(v) && compare(v, x) > 0,
  gte: (v, x) => !isNil(v) && compare(v, x) >= 0,
  lt: (v, x) => !isNil(v) && compare(v, x) < 0,
  lte: (v, x) => !isNil(v) && compare(v, x) <= 0,
  is: (v, x) => (x === null || x === 'null' ? isNil(v) : String(v) === String(x)),
  in: (v, x) => !isNil(v) && x.some((i) => compare(v, i) === 0),
  like: (v, x) => !isNil(v) && new RegExp(`^${String(x).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*').replaceAll('_', '.')}$`, 's').test(String(v)),
  ilike: (v, x) => !isNil(v) && ilikeMatches(x, String(v)),
  cs: (v, x) => !isNil(v) && (Array.isArray(x) ? x.every((i) => v.includes(i)) : Object.entries(x).every(([k, w]) => JSON.stringify(v[k]) === JSON.stringify(w))),
  cd: (v, x) => !isNil(v) && v.every((i) => x.includes(i)),
  ov: (v, x) => !isNil(v) && v.some((i) => x.includes(i)),
}
function parseOperand(op, raw) {
  if (op === 'in') return splitTopLevel(String(raw).replace(/^\(|\)$/g, '')).map((s) => s.replace(/^"|"$/g, ''))
  if (['cs', 'cd', 'ov'].includes(op) && typeof raw === 'string' && raw.startsWith('{')) return splitTopLevel(raw.slice(1, -1)).map((s) => s.replace(/^"|"$/g, '')).filter(Boolean)
  return raw === 'null' ? null : raw
}

/** A PostgREST or=(…) expression as a row predicate. */
export function parseOr(expr, table) {
  const parts = splitTopLevel(expr).map((part) => {
    const group = /^(not\.)?(and|or)\((.*)\)$/s.exec(part)
    if (group) {
      const inner = splitTopLevel(group[3]).join(',')
      const f = group[2] === 'or' ? parseOr(inner, table) : parseAnd(inner, table)
      return group[1] ? (r) => !f(r) : f
    }
    const m = /^([^.]+)\.(not\.)?([a-z]+)\.(.*)$/s.exec(part)
    if (!m || !OPS[m[3]]) throw new FakeDbSchemaError(`cannot read filter '${part}'`)
    assertColumn(table, m[1])
    const val = parseOperand(m[3], m[4])
    return (r) => { const hit = OPS[m[3]](readPath(r, m[1]), val); return m[2] ? !hit : hit }
  })
  return (r) => parts.some((f) => f(r))
}
function parseAnd(expr, table) {
  const parts = splitTopLevel(expr).map((p) => parseOr(p, table))
  return (r) => parts.every((f) => f(r))
}

class Builder {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.op = null
    this.filters = []
    this.embedFilters = []
    this.log = []
    this.orders = []
    this.selection = null
    this.mode = 'many'
    this.limitN = null
    this.offset = 0
    this.options = {}
    this.payload = null
    this.returning = false
    this.promise = null
  }

  select(columns = '*', options = {}) {
    this.selection = parseSelection(columns, this.table)
    if (this.op) this.returning = true
    else { this.op = 'select'; this.options = options }
    return this
  }

  checkRow(row) { for (const k of Object.keys(row)) assertColumn(this.table, k) }
  write(op, payload, options = {}) {
    this.op = op
    this.options = options
    this.payload = payload
    for (const r of Array.isArray(payload) ? payload : [payload]) this.checkRow(r)
    return this
  }

  insert(rows, options) { return this.write('insert', rows, options) }
  upsert(rows, options) { return this.write('upsert', rows, options) }
  update(row, options) { return this.write('update', row, options) }
  delete(options) { this.op = 'delete'; this.options = options || {}; return this }

  where(column, op, value) {
    this.log.push({ column, op, value })
    if (String(column).includes('.') && !String(column).includes('->')) {
      const [rel, col] = String(column).split('.')
      this.embedFilters.push({ rel, col, op, value })
      return this
    }
    assertColumn(this.table, column)
    this.filters.push((r) => OPS[op](readPath(r, column), value))
    return this
  }

  eq(c, v) { return this.where(c, 'eq', v) }
  neq(c, v) { return this.where(c, 'neq', v) }
  gt(c, v) { return this.where(c, 'gt', v) }
  gte(c, v) { return this.where(c, 'gte', v) }
  lt(c, v) { return this.where(c, 'lt', v) }
  lte(c, v) { return this.where(c, 'lte', v) }
  is(c, v) { return this.where(c, 'is', v) }
  in(c, v) { return this.where(c, 'in', v) }
  like(c, v) { return this.where(c, 'like', v) }
  ilike(c, v) { return this.where(c, 'ilike', v) }
  contains(c, v) { return this.where(c, 'cs', v) }
  containedBy(c, v) { return this.where(c, 'cd', v) }
  overlaps(c, v) { return this.where(c, 'ov', v) }
  match(obj) { for (const [c, v] of Object.entries(obj)) this.eq(c, v); return this }
  filter(c, op, v) {
    if (!OPS[op]) throw new FakeDbSchemaError(`unsupported filter operator '${op}'`)
    return this.where(c, op, parseOperand(op, v))
  }

  not(c, op, v) {
    assertColumn(this.table, c)
    const val = parseOperand(op, v)
    this.filters.push((r) => !OPS[op](readPath(r, c), val))
    return this
  }

  or(expr) { this.filters.push(parseOr(expr, this.table)); return this }
  order(column, { ascending = true, nullsFirst } = {}) {
    assertColumn(this.table, column)
    this.orders.push({ column, ascending, nullsFirst: nullsFirst ?? !ascending })
    return this
  }

  limit(n) { this.limitN = n; return this }
  range(from, to) { this.offset = from; this.limitN = to - from + 1; return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybe'; return this }
  returns() { return this }
  overrideTypes() { return this }
  abortSignal() { return this }

  matching() {
    const rows = this.db.tables[this.table] ||= []
    return rows.filter((r) => this.filters.every((f) => f(r)))
  }

  project(row, items = this.selection) {
    if (!items) return { ...row }
    let out = {}
    for (const it of items) {
      if (it.star) out = { ...out, ...row }
      else if (it.column) out[it.alias] = readPath(row, [it.column, ...it.path].join('->'))
      else if (it.embed) {
        const value = this.embedValue(row, it)
        if (it.spread && value && !Array.isArray(value)) out = { ...out, ...value }
        else out[it.alias] = value
      }
    }
    return out
  }

  embedRows(row, it) {
    const { link } = it
    const rows = this.db.tables[it.link.target] || []
    const hit = link.many
      ? rows.filter((r) => compareEq(r[link.column], row[link.refColumn]))
      : rows.filter((r) => compareEq(r[link.refColumn], row[link.column]))
    const fs = this.embedFilters.filter((f) => f.rel === it.alias || f.rel === it.rel)
    return hit.filter((r) => fs.every((f) => { assertColumn(link.target, f.col); return OPS[f.op](r[f.col], f.value) }))
  }

  embedValue(row, it) {
    const rows = this.embedRows(row, it).map((r) => this.project(r, it.children))
    return it.link.many ? rows : (rows[0] ?? null)
  }

  sorted(rows) {
    if (!this.orders.length) return rows
    return [...rows].sort((a, b) => {
      for (const o of this.orders) {
        const [x, y] = [readPath(a, o.column), readPath(b, o.column)]
        if (isNil(x) || isNil(y)) {
          if (isNil(x) && isNil(y)) continue
          return isNil(x) === o.nullsFirst ? -1 : 1
        }
        const c = compare(x, y)
        if (c) return o.ascending ? c : -c
      }
      return 0
    })
  }

  newRow(input) {
    const row = {}
    for (const [name, type, nullable, hasDefault] of relation(this.table).columns) {
      if (input[name] !== undefined) row[name] = input[name]
      else if (name === 'id' && hasDefault && type === 'uuid') row[name] = randomUUID()
      else if (hasDefault && type.startsWith('timestamp')) row[name] = new Date().toISOString()
      else if (!nullable && !hasDefault) return { missing: name }
      else row[name] = null
    }
    return { row }
  }

  shape(rows, count) {
    if (this.mode === 'single' || this.mode === 'maybe') {
      if (rows.length === 1) return { data: rows[0], error: null, count }
      if (rows.length === 0 && this.mode === 'maybe') return { data: null, error: null, count }
      return { data: null, error: { code: 'PGRST116', message: `JSON object requested, ${rows.length} rows returned` }, count }
    }
    return { data: rows, error: null, count }
  }

  run() {
    const { db, table, op } = this
    db.calls.push({ table, op, filters: this.log })
    // An injected error may be a function of the query ({ options, filters }) that
    // answers the error or nothing, to fail one query on a table and not its siblings.
    const raw = db.errors?.[table]?.[op]
    const injected = typeof raw === 'function' ? raw({ options: this.options, filters: this.log }) : raw
    if (injected) return { data: null, error: injected, count: null }
    const rows = (db.tables[table] ||= [])
    if (op === 'select') {
      const inners = (this.selection || []).filter((i) => i.embed)
      let found = this.sorted(this.matching())
      for (const it of inners) if (it.inner) found = found.filter((r) => this.embedRows(r, it).length > 0)
      const count = this.options.count ? found.length : null
      if (this.options.head) return { data: null, error: null, count }
      const take = Math.min(this.limitN ?? ROW_CAP, ROW_CAP)
      return this.shape(found.slice(this.offset, this.offset + take).map((r) => this.project(r)), count)
    }
    let changed = []
    if (op === 'insert' || op === 'upsert') {
      const conflict = String(this.options.onConflict || 'id').split(',').map((s) => s.trim())
      for (const input of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const existing = op === 'upsert' ? rows.find((r) => conflict.every((c) => compareEq(r[c], input[c]))) : null
        if (existing) {
          if (this.options.ignoreDuplicates) continue
          Object.assign(existing, input)
          changed.push(existing)
          continue
        }
        const { row, missing } = this.newRow(input)
        if (missing) return { data: null, count: null, error: { code: '23502', message: `null value in column "${missing}" of relation "${table}" violates not-null constraint` } }
        rows.push(row)
        changed.push(row)
      }
    } else if (op === 'update') {
      changed = this.matching()
      for (const r of changed) Object.assign(r, this.payload)
    } else if (op === 'delete') {
      changed = this.matching()
      db.tables[table] = rows.filter((r) => !changed.includes(r))
    } else {
      throw new FakeDbSchemaError(`query on '${table}' has no operation`)
    }
    if (!this.returning) return { data: null, error: null, count: this.options?.count ? changed.length : null }
    return this.shape(changed.map((r) => this.project(r)), null)
  }

  then(resolve, reject) {
    this.promise ||= new Promise((ok, fail) => { try { ok(this.run()) } catch (e) { fail(e) } })
    return this.promise.then(resolve, reject)
  }
}

function compareEq(a, b) { return !isNil(a) && !isNil(b) && compare(a, b) === 0 }

export function createFakeDb({ tables = {}, rpc = {}, errors = {} } = {}) {
  const data = {}
  for (const [t, rows] of Object.entries(tables)) {
    relation(t)
    for (const r of rows) for (const c of Object.keys(r)) assertColumn(t, c)
    data[t] = rows.map((r) => ({ ...r }))
  }
  const db = {
    tables: data,
    calls: [],
    errors,
    from(table) { relation(table); return new Builder(db, table) },
    async rpc(name, args = {}) {
      const overloads = functions.get(name)
      if (!overloads) throw new FakeDbSchemaError(`function '${name}' does not exist`)
      if (!overloads.some((names) => Object.keys(args).every((a) => names.has(a)))) throw new FakeDbSchemaError(`function '${name}' has no arguments named ${Object.keys(args).join(', ')}`)
      db.calls.push({ rpc: name, args })
      if (errors.rpc?.[name]) return { data: null, error: errors.rpc[name] }
      if (!rpc[name]) throw new FakeDbSchemaError(`no handler given for rpc '${name}'`)
      return { data: await rpc[name](args, db), error: null }
    },
  }
  return db
}
