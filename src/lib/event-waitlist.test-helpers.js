// A small supabase-js stand-in for the waitlist tests: every builder method is
// chainable and recorded; the answer comes from `respond(q)` where q is
// { table, action: 'select'|'insert'|'update'|'delete', payload, ops }. Awaiting the
// builder, .single() and .maybeSingle() all resolve to respond(q).
export function fakeDb(respond) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, action: 'select', payload: null, ops: [] }
      queries.push(q)
      const b = {}
      for (const name of ['select', 'eq', 'in', 'is', 'order', 'range', 'limit', 'gte', 'lt', 'neq']) {
        b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      }
      b.insert = (payload) => { q.action = 'insert'; q.payload = payload; return b }
      b.update = (payload) => { q.action = 'update'; q.payload = payload; return b }
      b.delete = () => { q.action = 'delete'; return b }
      const answer = () => Promise.resolve(respond(q) || { data: null, error: null })
      b.single = answer
      b.maybeSingle = answer
      b.then = (res, rej) => answer().then(res, rej)
      return b
    },
  }
}

/** The value of the first `.eq(col, v)` on a query, or undefined. */
export const eqOf = (q, col) => q.ops.find((o) => o[0] === 'eq' && o[1] === col)?.[2]
