// MEMBERWRITESWEEP.1e — test doubles for the campaign session routes
// (/api/communications/campaigns*). Not a test file itself (vitest only
// collects *.test.*), imported by the four route tests.
//
// A chainable supabase stand-in that RECORDS every query (table, op, columns,
// payload, filters, terminal) and answers each one through `respond(call)`,
// so a test can assert exactly what the route wrote and how it narrowed it
// (the status guard on an UPDATE/DELETE is part of the contract).

import { NextResponse } from 'next/server'

export const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
export const LOC_B = 'b0000000-0000-4000-8000-00000000000b'
export const CAMPAIGN_ID = 'c0000000-0000-4000-8000-000000000001'

/** A signed-in user with access to `locations`, and `email` at `emailAt`. */
export function userWith({ id = '10000000-0000-4000-8000-000000000001', locations = [LOC_A], emailAt = [LOC_A] } = {}) {
  return { id, locations: locations.map((l) => ({ id: l })), emailAt }
}

/** The real assertLocationAccess / Or404 shapes (src/lib/auth.js), without its imports. */
export function authMockImpl() {
  const check = (status, error) => (user, locationId) => {
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    if (!locationId) return null
    if (!(user.locations || []).some((l) => l.id === locationId)) {
      return NextResponse.json({ success: false, error }, { status })
    }
    return null
  }
  return {
    assertLocationAccess: check(403, 'Forbidden — location not in your assignments'),
    assertLocationAccessOr404: check(404, 'Not found'),
  }
}

/** hasPermissionForLocation, driven by userWith({ emailAt }). */
export const hasPermissionForLocationImpl = (user, locationId, key) =>
  key === 'email' && (user?.emailAt || []).includes(locationId)

export function makeFakeDb(respond = () => ({ data: null, error: null })) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, op: 'select', columns: null, payload: null, filters: [], terminal: null }
      const resolve = () => {
        calls.push(call)
        return Promise.resolve(respond(call) ?? { data: null, error: null })
      }
      const b = {
        select(cols) { call.columns = cols ?? '*'; return b },
        insert(p) { call.op = 'insert'; call.payload = p; return b },
        update(p) { call.op = 'update'; call.payload = p; return b },
        delete() { call.op = 'delete'; return b },
        eq(c, v) { call.filters.push(['eq', c, v]); return b },
        in(c, v) { call.filters.push(['in', c, v]); return b },
        single() { call.terminal = 'single'; return resolve() },
        maybeSingle() { call.terminal = 'maybeSingle'; return resolve() },
        then(res, rej) { return resolve().then(res, rej) },
      }
      return b
    },
  }
}

/** Answer the loader's by-id read with `row`, and every write with `write(call)`. */
export function campaignDb(row, write = () => ({ data: [{ id: CAMPAIGN_ID }], error: null })) {
  return makeFakeDb((call) => {
    if (call.op === 'select') return { data: row, error: null }
    return write(call)
  })
}

export const writesOf = (db) => db.calls.filter((c) => c.op !== 'select')

export function jsonRequest(url, method, body) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export const paramsOf = (id = CAMPAIGN_ID) => ({ params: Promise.resolve({ id }) })
