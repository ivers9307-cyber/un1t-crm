// ROLESWEEP.1 — a gate probe for route handlers (TEST-ONLY; not collected:
// vitest collects *.test.js only).
//
// The question every ROLESWEEP test asks is narrow: did the route's ACCESS
// GATE let this caller through, or refuse them? Not "did the route then do
// its work right" — that is each route's own test. So the probe answers the
// gate's own reads (the row whose location_id the gate judges) from a script,
// and the FIRST database or network call after those is the tripwire: it
// records the query it was asked for, marks the probe `passed`, and throws
// PastGate. A refused caller never reaches it. Nothing after the gate runs,
// so no email, push, Glofox or Stripe call can escape a test.
//
//   const probe = gateProbe([{ data: { id: 'row-1', location_id: LOC_B }, error: null }])
//   createServerClient.mockReturnValue(probe.db)
//   const res = await callRoute()          // PastGate is caught for you
//   probe.passed                           // true = through the gate
//   probe.tripped                          // { kind, table, chain } of the tripwire
//
// `gateReads` are answered in call order, one per db.from(...) (or
// db.rpc(...)) call. An answer may be a function of the recorded chain.
// Filters are recorded, never applied (not a query engine).

import { vi } from 'vitest'

export class PastGate extends Error {
  constructor(where) { super(`PastGate: ${where}`); this.name = 'PastGate' }
}

export function gateProbe(gateReads = []) {
  const queue = [...gateReads]
  const probe = { passed: false, tripped: null, reads: [], db: null }

  function trip(kind, table, chain) {
    if (!probe.passed) {
      probe.passed = true
      probe.tripped = { kind, table, chain }
    }
    throw new PastGate(`${kind} ${table ?? ''}`.trim())
  }

  // A builder that records every method call. Scripted: settles to the
  // scripted answer. Tripwire: records, then throws when awaited or ended
  // (so a list route's .in('location_id', ids) is visible in `tripped`).
  function builder(table, answer, isTrip) {
    const chain = []
    const settle = () => {
      if (isTrip) trip('from', table, chain)
      return Promise.resolve(typeof answer === 'function' ? answer(chain) : answer)
    }
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => { try { return settle().then(res, rej) } catch (e) { return Promise.reject(e).then(res, rej) } }
        if (prop === 'single' || prop === 'maybeSingle' || prop === 'csv' || prop === 'throwOnError') {
          return () => { chain.push([prop]); try { return settle() } catch (e) { return Promise.reject(e) } }
        }
        return (...args) => { chain.push([prop, ...args]); return b }
      },
    })
    return b
  }

  function next(kind, table, extra) {
    if (queue.length === 0) return null
    const answer = queue.shift()
    probe.reads.push({ kind, table, ...extra })
    return answer
  }

  probe.db = {
    from(table) {
      const answer = queue.length ? next('from', table) : undefined
      return answer === undefined ? builder(table, null, true) : builder(table, answer, false)
    },
    rpc(fn, args) {
      if (queue.length) {
        const answer = next('rpc', fn, { args })
        return Promise.resolve(typeof answer === 'function' ? answer(args) : answer)
      }
      trip('rpc', fn, [['args', args]])
    },
    storage: new Proxy({}, { get: () => () => trip('storage', null, []) }),
    auth: new Proxy({}, { get: () => new Proxy({}, { get: () => () => trip('auth', null, []) }) }),
    channel: () => trip('channel', null, []),
  }
  return probe
}

/**
 * Run a route handler under a probe: stubs global fetch as a tripwire
 * (network = past the gate), swallows PastGate whether it escapes as a
 * throw or the route caught it and answered 500, and returns
 * { res, status, body }. `body` is null when the handler threw PastGate.
 */
export async function runProbed(probe, handler) {
  const realFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (url) => {
    if (!probe.passed) { probe.passed = true; probe.tripped = { kind: 'fetch', table: String(url), chain: [] } }
    throw new PastGate(`fetch ${url}`)
  })
  try {
    const res = await handler()
    let body = null
    try { body = await res.clone().json() } catch { body = null }
    return { res, status: res.status, body }
  } catch (e) {
    if (e instanceof PastGate || e?.name === 'PastGate') return { res: null, status: null, body: null }
    throw e
  } finally {
    globalThis.fetch = realFetch
  }
}

/**
 * One `it.each` over a case table (roleCases / permissionCases from
 * ./role-sweep-callers.js) for one route handler.
 *
 * The test file must vi.mock '@/lib/supabase' (createServerClient: vi.fn())
 * and '@/lib/auth' (real module, getCurrentUser: vi.fn()), and pass those
 * two mocks in `T` with vitest's describe/it/expect.
 *
 * spec:
 *   call(target)        → Promise<Response>: invoke the handler for a row or
 *                         body/query location at `target`
 *   gateReads(target)   → the scripted answers for the reads the gate needs
 *                         (default: none — the location comes from the request)
 *   forbidden           → { status, body } the route's role/permission refusal
 *   hidden              → { status, body } the route's non-member refusal
 *   cases               → [label, caller, target, 'pass'|'forbidden'|'hidden'][]
 *
 * 'pass' means the gate let the caller through: either the route reached a
 * database/network call after the gate reads (probe.passed, the tripwire),
 * or it answered with a status that no gate uses (a later 400, say). Any
 * 401/403/404 without the tripwire is a refusal, whatever its body, so a
 * refusal by a DIFFERENT gate than the one the spec names cannot count as a
 * pass. A refusal must match status AND body exactly, and must not have
 * touched anything past the gate reads.
 */
// Statuses a gate answers with. Without the tripwire, any of these is a refusal.
const REFUSAL_STATUSES = new Set([401, 403, 404])

export function describeGate(title, spec, { getCurrentUser, createServerClient, describe, it, expect }) {
  describe(title, () => {
    it.each(spec.cases)('%s', async (_label, caller, target, outcome) => {
      getCurrentUser.mockResolvedValue(caller)
      const probe = gateProbe(spec.gateReads ? spec.gateReads(target) : [])
      createServerClient.mockReturnValue(probe.db)
      const { status, body } = await runProbed(probe, () => spec.call(target))
      if (outcome === 'pass') {
        const through = probe.passed || (status !== null && !REFUSAL_STATUSES.has(status))
        expect(through, `refused at a gate: ${status} ${JSON.stringify(body)}`).toBe(true)
        return
      }
      expect(probe.passed, `got past the gate (${probe.tripped?.kind} ${probe.tripped?.table})`).toBe(false)
      expect({ status, body }).toEqual(spec[outcome])
    })
  })
}
