// SECFIX.1 — test-only callers and a recording fake DB for routes that must
// judge OWNER at the location they act on, never at the caller's ACTIVE
// studio (`user.role`).
//
// The callers mirror getCurrentUser()'s shape: `role` is the ACTIVE studio's
// role, `rolesByLocation` the per-location truth, `profileRole` the
// estate-level role that carries the master bypass. All ids are synthetic.

export const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
export const LOC_B = 'b0000000-0000-4000-8000-00000000000b'

// A non-master caller: `roles` is { [locationId]: role }, `active` the active studio.
export const person = (roles, active) => ({
  id: 'u0000000-0000-4000-8000-000000000001',
  isMaster: false,
  profileRole: 'staff',
  role: roles[active],
  activeLocation: { id: active },
  // Each location carries the caller's role there, as getCurrentUser's do, so
  // a permission resolved at a location (hasPermissionForLocation) takes the
  // role's code default (GATES-3: the WhatsApp template routes ask `whatsapp`).
  locations: Object.keys(roles).map((id) => ({ id, role: roles[id] })),
  rolesByLocation: { ...roles },
})

// Masters' `user.locations` holds every active location; they have no
// per-location role rows.
export const MASTER = {
  id: 'u0000000-0000-4000-8000-00000000000m',
  isMaster: true,
  profileRole: 'master',
  role: 'master',
  activeLocation: { id: LOC_A },
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: {},
}

// The four rows every owner-at-location route is pinned by, acting on LOC_B
// with LOC_A active: [label, caller, outcome] where outcome is 'pass',
// 'forbidden' (the route's role refusal) or 'hidden' (its membership refusal).
export const ownerAtTargetCases = () => [
  ['owner at the target while a studio where they are staff is active: allowed', person({ [LOC_A]: 'staff', [LOC_B]: 'owner' }, LOC_A), 'pass'],
  ['staff at the target while a studio where they are owner is active: refused', person({ [LOC_A]: 'owner', [LOC_B]: 'staff' }, LOC_A), 'forbidden'],
  ['manager at the target, owner at the active studio: refused', person({ [LOC_A]: 'owner', [LOC_B]: 'manager' }, LOC_A), 'forbidden'],
  ['an owner who does not belong to the target: refused', person({ [LOC_A]: 'owner' }, LOC_A), 'hidden'],
  ['owner at the target, which is active: allowed', person({ [LOC_B]: 'owner' }, LOC_B), 'pass'],
  ['a master: allowed', MASTER, 'pass'],
]

// A chainable fake Supabase client that records every call. `results` maps a
// table to what its terminal read resolves to: `{ single, list }` where
// `single` answers maybeSingle()/single() and `list` answers an awaited chain.
export function recordingDb(results = {}) {
  const calls = []
  const from = (table) => {
    const res = results[table] || {}
    const chain = {}
    for (const m of ['select', 'eq', 'in', 'update', 'delete', 'insert', 'upsert', 'order', 'limit']) {
      chain[m] = (...args) => { calls.push([table, m, ...args]); return chain }
    }
    chain.maybeSingle = () => { calls.push([table, 'maybeSingle']); return Promise.resolve({ data: res.single ?? null, error: null }) }
    chain.single = chain.maybeSingle
    chain.then = (ok, bad) => Promise.resolve({ data: res.list ?? null, error: null, count: 0 }).then(ok, bad)
    return chain
  }
  return { db: { from }, calls }
}
