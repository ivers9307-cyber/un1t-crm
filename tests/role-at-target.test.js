// ROLESWEEP.1 — no /api route both gates on the ACTIVE studio and acts on
// another one. A floor, not a proof (the check:select-columns posture).
//
// A route fails when its source (comments stripped) holds BOTH
//   • an active-studio gate: ROLES.includes(user.role), user.role === 'owner',
//     switch (user.role), hasPermission(user, …); and
//   • a sign it acts on a location that can be another one:
//     assertLocationAccess(Or404)(user, <anything but user.activeLocation>),
//     getUserLocationIds(user), user.locations.
// (scripts/lib/active-role-gates.mjs holds both token sets.) Judge the role at
// the target instead: hasRoleAtLocation / hasPermissionForLocation /
// guardMasterOrOwner, with hasRoleAtAnyLocation as a coarse pre-check.
//
// Routes under src/app/api/locations/[id]/ are held to the stricter
// role-at-path.test.js (no active gate at all) and skipped here.
//
// Two lists, both exact (an entry that no longer matches, or a file that no
// longer exists, FAILS — the lists can only shrink by deletion):
//   • REVIEWED (below): matches that were read and are right as they stand.
//     Each carries its reason.
//   • tests/role-at-target.pending-*.json: routes KNOWN to have the bug, each
//     file owned by the ROLESWEEP PR that fixes it. That PR deletes its file.
//     Never add a route to a pending file to get a new one past this test.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { activeRoleGates, otherLocationUses } from '../scripts/lib/active-role-gates.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const API = path.join(ROOT, 'src/app/api')

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.js') out.push(full)
  }
  return out
}

const rel = (file) => path.relative(API, file).split(path.sep).join('/')

// Read, and right as they stand. `reason` says why the active studio is the
// right one to judge (or why the location use is not a different studio).
export const REVIEWED = {
  'agent/membership-requests/route.js':
    'The MANAGER_ROLES gate (:54) guards only the no-param branch, which reads user.activeLocation.id (:57). getUserLocationIds belongs to the ?conversation_id branch above it, which has no role gate (a membership-scoped read).',
  'dashboard/business/route.js':
    'Reads only user.activeLocation.id (:67); the assertLocationAccess at :71 is on that same active id held in a variable, so the "another location" sign is a false positive.',
  'settings/scoring/route.js':
    'PUT gates MANAGER_ROLES and writes user.activeLocation.id (:90); the assertLocationAccess at :93 is on that same active id held in a variable (GET is ungated).',
}

function pendingLists() {
  const dir = path.join(ROOT, 'tests')
  return fs.readdirSync(dir)
    .filter((f) => /^role-at-target\.pending-[a-z0-9]+\.json$/.test(f))
    .map((f) => ({ file: f, routes: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).routes }))
}

function offenders() {
  return routeFiles(API)
    .filter((f) => !rel(f).startsWith('locations/[id]/'))
    .filter((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return activeRoleGates(src).length > 0 && otherLocationUses(src).length > 0
    })
    .map(rel)
    .sort()
}

describe('the scan', () => {
  it('sees a gate plus another-location use, and not either alone', () => {
    const both = "if (!MANAGER_ROLES.includes(user.role)) {}\nconst g = assertLocationAccessOr404(user, row.location_id)"
    expect(activeRoleGates(both)).toEqual(['.includes(user.role)'])
    expect(otherLocationUses(both)).toEqual(['assertLocationAccessOr404(user, r'])
    expect(otherLocationUses('assertLocationAccess(user, user.activeLocation.id)')).toEqual([])
    expect(otherLocationUses('assertLocationAccess(user, user.activeLocation?.id)')).toEqual([])
    expect(otherLocationUses('const ids = getUserLocationIds(user)')).toEqual(['getUserLocationIds(user)'])
    expect(activeRoleGates("if (!hasPermission(user, 'orders')) {}")).toEqual(['hasPermission(user,'])
    expect(activeRoleGates("if (!hasPermissionForLocation(user, id, 'orders')) {}")).toEqual([])
    expect(activeRoleGates("if (!hasRoleAtLocation(user, id, MANAGER_ROLES)) {}")).toEqual([])
    expect(activeRoleGates("if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {}")).toEqual([])
    expect(activeRoleGates("if (!hasPermissionAtAnyLocation(user, 'email')) {}")).toEqual([])
  })
})

describe('/api routes judge the role at the location they act on', () => {
  const found = offenders()
  const pending = pendingLists()
  const pendingRoutes = pending.flatMap((p) => p.routes.map((r) => ({ route: r, list: p.file })))

  it('finds the route tree (a wrong root finds nothing)', () => {
    expect(routeFiles(API).length).toBeGreaterThan(500)
  })

  it('no route outside the two lists gates on the active studio while acting on another', () => {
    const known = new Set([...Object.keys(REVIEWED), ...pendingRoutes.map((p) => p.route)])
    expect(found.filter((r) => !known.has(r))).toEqual([])
  })

  it('every REVIEWED entry still matches and has a reason (else delete it)', () => {
    for (const [route, reason] of Object.entries(REVIEWED)) {
      expect(typeof reason === 'string' && reason.length > 20, `${route}: give a reason`).toBe(true)
    }
    expect(Object.keys(REVIEWED).filter((r) => !found.includes(r))).toEqual([])
  })

  it('every pending route still matches (a fixed route leaves its pending file)', () => {
    expect(pendingRoutes.filter((p) => !found.includes(p.route)).map((p) => `${p.list}: ${p.route}`)).toEqual([])
  })

  it('no route is in two lists', () => {
    const all = [...Object.keys(REVIEWED), ...pendingRoutes.map((p) => p.route)]
    expect(all.filter((r, i) => all.indexOf(r) !== i)).toEqual([])
  })
})
