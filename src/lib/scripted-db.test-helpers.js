// src/lib/scripted-db.test-helpers.js
//
// REPLACE.1 — a scripted supabase fake for the DB halves of the replace and
// offer modules. Each db.from(table) takes the NEXT scripted answer for that
// table, in call order, and records the chain it was asked for, so a test
// asserts both the write and the guards that were on it. Not a query engine:
// filters are recorded, never applied. An answer may be a function of the
// recorded chain. A table with no answer left THROWS, so an unexpected query
// is a red test, not a silent null.
import { vi } from 'vitest'

const CHAIN = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'in', 'or', 'not',
  'gte', 'gt', 'lte', 'lt', 'like', 'order', 'limit', 'range']

export function scriptedDb(script = {}) {
  const queues = Object.fromEntries(Object.entries(script).map(([t, answers]) => [t, [...answers]]))
  const calls = []
  return {
    calls,
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from(table) {
      const queue = queues[table]
      if (!queue || queue.length === 0) throw new Error(`scriptedDb: no answer left for ${table}`)
      const answer = queue.shift()
      const chain = []
      calls.push({ table, chain })
      const settle = () => Promise.resolve(typeof answer === 'function' ? answer(chain) : answer)
      const b = {}
      for (const m of CHAIN) b[m] = (...args) => { chain.push([m, ...args]); return b }
      b.single = () => { chain.push(['single']); return settle() }
      b.maybeSingle = () => { chain.push(['maybeSingle']); return settle() }
      b.then = (resolve, reject) => settle().then(resolve, reject)
      return b
    },
  }
}

/** Recorded chains for one table, in call order. */
export const chainsFor = (db, table) => db.calls.filter((c) => c.table === table).map((c) => c.chain)

/** The arguments of the first `method` call in a chain (undefined when absent). */
export const argsOf = (chain, method) => chain.find(([m]) => m === method)?.slice(1)

/** Every argument list of `method` in a chain. */
export const allArgsOf = (chain, method) => chain.filter(([m]) => m === method).map((c) => c.slice(1))
