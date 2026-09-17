// LEAVE.2 — a recording PostgREST fake for the time-off routes and libs.
//
// `fakeDb(resolve)` returns a client whose every chain records its calls and,
// when awaited (or at .single/.maybeSingle), asks
//   resolve({ table, action, payload, calls, eq, terminal })
// for `{ data, error, count }`. `action` is select|insert|update|delete,
// `eq` is the column→value map of .eq() filters, `calls` every [op, ...args].
// Every query is also pushed to `db.queries` so a test can assert on what the
// code asked for, not only on what it did with the answer.

const FILTERS = ['eq', 'neq', 'in', 'or', 'lt', 'lte', 'gt', 'gte', 'is', 'order', 'limit', 'range', 'not', 'match', 'filter']

export function fakeDb(resolve) {
  const queries = []
  const db = {
    queries,
    from(table) {
      const q = { table, action: 'select', payload: null, calls: [], eq: {}, columns: null }
      queries.push(q)
      const settle = (terminal) => Promise.resolve(resolve({ ...q, terminal }) || { data: null, error: null })
      const chain = {}
      for (const op of FILTERS) {
        chain[op] = (...args) => {
          q.calls.push([op, ...args])
          if (op === 'eq') q.eq[args[0]] = args[1]
          return chain
        }
      }
      chain.select = (cols) => { if (q.columns == null) q.columns = cols ?? '*'; return chain }
      chain.insert = (rows) => { q.action = 'insert'; q.payload = rows; return chain }
      chain.update = (patch) => { q.action = 'update'; q.payload = patch; return chain }
      chain.upsert = (row) => { q.action = 'upsert'; q.payload = row; return chain }
      chain.delete = () => { q.action = 'delete'; return chain }
      chain.single = () => settle('single')
      chain.maybeSingle = () => settle('maybeSingle')
      chain.then = (res, rej) => settle('then').then(res, rej)
      return chain
    },
  }
  return db
}

/** Queries against one table and action. */
export function queriesOf(db, table, action = 'select') {
  return db.queries.filter((q) => q.table === table && q.action === action)
}
