// FEES.1/FEES.2 — a tiny in-memory PostgREST fake for the class-fees tests:
// eq / in / is / gte / lte / lt / or(and(...)) filters, upsert with
// ignoreDuplicates on (location_id, un1t_booking_id), head counts.
function cmp(op, a, b) {
  if (op === 'eq') return String(a) === String(b)
  if (op === 'lte') return a != null && String(a) <= String(b)
  if (op === 'lt') return a != null && String(a) < String(b)
  if (op === 'gt') return a != null && String(a) > String(b)
  if (op === 'gte') return a != null && String(a) >= String(b)
  return false
}
function parseOr(expr) {
  // and(a.eq.x,b.lte.y),and(...)
  return [...expr.matchAll(/and\(([^)]*)\)/g)].map((m) => m[1].split(',').map((part) => {
    const [col, op, ...rest] = part.split('.')
    return [op, col, rest.join('.')]
  }))
}
export function makeDb(tables) {
  const store = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  let seq = 0
  const db = {
    store,
    from(name) {
      store[name] ??= []
      const s = { op: 'select', filters: [], ors: null, payload: null, opts: null, head: false, single: false }
      const rows = () => store[name]
      const match = (r) => s.filters.every(([op, c, v]) => (op === 'in' ? v.includes(r[c]) : op === 'is' ? r[c] === v : cmp(op, r[c], v)))
        && (!s.ors || s.ors.some((group) => group.every(([op, c, v]) => cmp(op, r[c], v))))
      const run = () => {
        if (s.op === 'upsert' || s.op === 'insert') {
          const out = []
          for (const p of [].concat(s.payload)) {
            const keys = (s.opts?.onConflict || 'location_id,un1t_booking_id').split(',')
            const dupe = rows().find((r) => keys.every((k) => r[k] === p[k]))
            if (dupe && s.opts?.ignoreDuplicates) continue
            const row = { id: `id-${++seq}`, attempts: 0, ...p }
            rows().push(row)
            out.push({ ...row })
          }
          return { data: out, error: null }
        }
        if (s.op === 'delete') {
          const hit = rows().filter(match)
          store[name] = rows().filter((r) => !hit.includes(r))
          return { data: hit.map((r) => ({ ...r })), error: null }
        }
        if (s.op === 'update') {
          const hit = rows().filter(match)
          for (const r of hit) Object.assign(r, s.payload)
          return { data: hit.map((r) => ({ ...r })), error: null }
        }
        const hit = rows().filter(match).map((r) => ({ ...r }))
        if (s.head) return { data: null, count: hit.length, error: null }
        if (s.single) return { data: hit[0] ?? null, error: null }
        return { data: hit, error: null }
      }
      const api = {
        select(_c, o) { if (s.op === 'select' && o?.head) s.head = true; return api },
        insert(p) { s.op = 'insert'; s.payload = p; return api },
        upsert(p, o) { s.op = 'upsert'; s.payload = p; s.opts = o; return api },
        update(p) { s.op = 'update'; s.payload = p; return api },
        delete() { s.op = 'delete'; return api },
        eq(c, v) { s.filters.push(['eq', c, v]); return api },
        in(c, v) { s.filters.push(['in', c, v]); return api },
        is(c, v) { s.filters.push(['is', c, v]); return api },
        gte(c, v) { s.filters.push(['gte', c, v]); return api },
        lte(c, v) { s.filters.push(['lte', c, v]); return api },
        lt(c, v) { s.filters.push(['lt', c, v]); return api },
        gt(c, v) { s.filters.push(['gt', c, v]); return api },
        or(e) { s.ors = parseOr(e); return api },
        order() { return api },
        limit() { return api },
        range(from) { if (from > 0) { s.filters.push(['in', 'id', []]) } return api },
        maybeSingle() { s.single = true; return api },
        then(res, rej) { return Promise.resolve(run()).then(res, rej) },
      }
      return api
    },
  }
  return db
}

