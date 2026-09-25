// QUALS.1 — a chainable supabase mock for the qualification data-layer tests.
// Every query is logged ({ table, op, select, returning, filters, payload,
// options, range, single }) and answered by `respond(query)`, which returns
// { data, error }. Builders are thenables, like supabase's.

export function mockDb(respond = () => ({ data: [], error: null })) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, op: 'select', select: null, returning: null, filters: [], payload: null, options: null, range: null, single: null }
      log.push(q)
      const chain = {
        select(cols) { if (q.op === 'select') q.select = cols; else q.returning = cols; return chain },
        insert(payload) { q.op = 'insert'; q.payload = payload; return chain },
        update(payload) { q.op = 'update'; q.payload = payload; return chain },
        upsert(payload, options) { q.op = 'upsert'; q.payload = payload; q.options = options; return chain },
        delete() { q.op = 'delete'; return chain },
        eq(col, val) { q.filters.push(['eq', col, val]); return chain },
        neq(col, val) { q.filters.push(['neq', col, val]); return chain },
        in(col, val) { q.filters.push(['in', col, val]); return chain },
        is(col, val) { q.filters.push(['is', col, val]); return chain },
        not(col, opr, val) { q.filters.push(['not', col, opr, val]); return chain },
        lte(col, val) { q.filters.push(['lte', col, val]); return chain },
        order() { return chain },
        limit() { return chain },
        range(from, to) { q.range = [from, to]; return chain },
        maybeSingle() { q.single = 'maybe'; return chain },
        single() { q.single = 'single'; return chain },
        then(resolve, reject) { return Promise.resolve().then(() => respond(q)).then(resolve, reject) },
      }
      return chain
    },
  }
}

/** respond() from a map keyed 'table.op' or 'table'; a function value is called with the query. */
export function byTable(map) {
  return (q) => {
    const hit = map[`${q.table}.${q.op}`] ?? map[q.table]
    if (typeof hit === 'function') return hit(q)
    return hit ?? { data: q.single ? null : [], error: null }
  }
}

export const filter = (q, op, col) => q.filters.find((f) => f[0] === op && f[1] === col)?.[2]
