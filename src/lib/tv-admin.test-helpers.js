// MEMBERWRITESWEEP.1f — test doubles for the TV admin session routes
// (/api/admin/tv-displays*, /api/admin/tv-templates*). Not a test file itself
// (vitest only collects *.test.*); imported by src/lib/tv-admin.test.js and
// the five route tests.
//
// A chainable supabase stand-in that RECORDS every query (table, op, columns,
// payload, filters, options, terminal) and answers each one through
// `respond(call)`, so a test can assert exactly what a route wrote and how it
// narrowed it (the studio filter on an UPDATE/DELETE is part of the contract).
// Callers are built with the role-sweep `person()` so the REAL permission
// resolver (web key, mobile toggle, role defaults) decides, not a mock.

import { person, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'

export { LOC_A, LOC_B }
export const TV_ID = 'e0000000-0000-4000-8000-0000000000e1'
export const TV_ID_2 = 'e0000000-0000-4000-8000-0000000000e2'
export const TEMPLATE_ID = 'f1000000-0000-4000-8000-0000000000f1'

const owner = (permissions) => ({ role: 'owner', ...(permissions ? { permissions } : {}) })

/** An owner at A (tv_displays on, web and mobile, by role default). */
export const OWNER_A = person({ [LOC_A]: owner() }, LOC_A)
/** Plain staff at A: no tv_displays on the web or the phone (role defaults). */
export const STAFF_A = person({ [LOC_A]: { role: 'staff' } }, LOC_A)
/** The web key alone at A. */
export const WEB_ONLY_A = person({ [LOC_A]: owner({ tv_displays: true, mobile: { tv_displays: false } }) }, LOC_A)
/** The mobile toggle alone at A. */
export const MOBILE_ONLY_A = person({ [LOC_A]: owner({ tv_displays: false, mobile: { tv_displays: true } }) }, LOC_A)
/** Neither key at A (an owner with both switched off). */
export const NEITHER_A = person({ [LOC_A]: owner({ tv_displays: false, mobile: { tv_displays: false } }) }, LOC_A)
/** An owner at A with tv_displays everywhere, but nothing at B. */
export const TV_AT_A_ONLY = person({ [LOC_A]: owner(), [LOC_B]: owner({ tv_displays: false, mobile: { tv_displays: false } }) }, LOC_A)

export function makeFakeDb(respond = () => ({ data: null, error: null })) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, op: 'select', columns: null, payload: null, options: null, filters: [], order: null, terminal: null }
      const resolve = () => {
        calls.push(call)
        return Promise.resolve(respond(call) ?? { data: null, error: null })
      }
      const b = {
        select(cols) { call.columns = cols ?? '*'; return b },
        insert(p) { call.op = 'insert'; call.payload = p; return b },
        update(p) { call.op = 'update'; call.payload = p; return b },
        upsert(p, o) { call.op = 'upsert'; call.payload = p; call.options = o ?? null; return b },
        delete() { call.op = 'delete'; return b },
        eq(c, v) { call.filters.push(['eq', c, v]); return b },
        in(c, v) { call.filters.push(['in', c, v]); return b },
        order(c, o) { call.order = [c, o]; return b },
        single() { call.terminal = 'single'; return resolve() },
        maybeSingle() { call.terminal = 'maybeSingle'; return resolve() },
        then(res, rej) { return resolve().then(res, rej) },
      }
      return b
    },
  }
}

export const writesOf = (db) => db.calls.filter((c) => c.op !== 'select')
export const readsOf = (db, table) => db.calls.filter((c) => c.op === 'select' && (!table || c.table === table))

export function jsonRequest(url, method, body) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export const paramsOf = (id) => ({ params: Promise.resolve({ id }) })

export const display = (over = {}) => ({
  id: TV_ID, label: 'Lobby TV', token: 'tok-1', active: true, rotation: 0, location_id: LOC_A,
  created_at: '2026-09-01T09:00:00.000Z', ...over,
})
export const template = (over = {}) => ({
  id: TEMPLATE_ID, name: 'Welcome board', base_image_path: `${LOC_A}/templates/1c000000-0000-4000-8000-000000000003.png`,
  zones: [{ id: 'z1', label: 'Text' }], location_id: LOC_A, ...over,
})
