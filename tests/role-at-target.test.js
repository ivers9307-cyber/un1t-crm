// ROLESWEEP.1 — no /api route both gates on the ACTIVE studio and acts on
// another one. A floor, not a proof (the check:select-columns posture).
//
// A route fails when its source (comments stripped) holds BOTH
//   • an active-studio gate: ROLES.includes(user.role), user.role === 'owner',
//     switch (user.role), hasPermission(user, …), hasMobilePermission(user, …);
//     and
//   • a sign it acts on a location that can be another one:
//     assertLocationAccess(Or404)(user, <anything but user.activeLocation>),
//     getUserLocationIds(user), user.locations.
// (scripts/lib/active-role-gates.mjs holds both token sets.) Judge the role at
// the target instead: hasRoleAtLocation / hasPermissionForLocation /
// guardMasterOrOwner, with hasRoleAtAnyLocation as a coarse pre-check.
//
// BLIND SPOT: the scan judges whole FILES, not handlers. A file with several
// handlers passes if any one of them decides at the target, so per-handler
// coverage is the tables in tests/role-sweep/*, not this guard. (The rest of
// the blind spots are listed in scripts/lib/active-role-gates.mjs.)
//
// Routes under src/app/api/locations/[id]/ are held to the stricter
// role-at-path.test.js (no active gate at all) and skipped here.
//
// A second rule, the PRE-CHECK-ONLY shape (preCheckOnly in the same module):
// a route that calls hasRoleAtAnyLocation( / hasPermissionAtAnyLocation( and
// acts on another location must also decide at the target in the same file
// (hasRoleAtLocation( / hasPermissionForLocation( / guardMasterOrOwner(, a
// local helper that calls one included). "Holds it somewhere" is not the
// decision. A route whose decision lives in a helper module is listed in
// PRECHECK_REVIEWED with the helper named; that list is exact too.
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
import { activeRoleGates, otherLocationUses, anyLocationPreChecks, targetJudgements, preCheckOnly, apiKeyOrManagerCalls, apiKeyOrManagerUnjudged } from '../scripts/lib/active-role-gates.mjs'

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
    'The MANAGER_ROLES gate guards only the no-param branch, which reads user.activeLocation.id. getUserLocationIds belongs to the ?conversation_id branch above it, which has no role gate (a membership-scoped read).',
  'events/route.js':
    'ROLESWEEP.1b: `races` is judged at the listed or created location (hasPermissionForLocation on ?location_id / body.location_id), and the POST payee gate judges ADMIN_ROLES at body.location_id. The one active gate left is the HOST-EDIT.1 hosted-events branch of GET: ADMIN_ROLES.includes(user.role), with `races` at user.activeLocation, adds the hosted events of the ACTIVE organisation (user.activeOrganization / user.activeLocation.organization_id). Those events sit on a per-host anchor location no staff belongs to, so the active studio is the only judgement available.',
  'events/[id]/route.js':
    'ROLESWEEP.1b: on the member path, `races` (GET, PUT), the payee change (PUT) and the DELETE floor (MANAGER_ROLES + `races`) are judged at the location of the event row. The active gate left is hostEventOrgAccess, the HOST-EDIT.1 host path: it admits an org admin (ADMIN_ROLES at the active studio) to an event hosted by the active organisation. Those events sit on a per-host anchor location no staff belongs to, so the active studio is the only judgement available; on that path `races` stays judged at user.activeLocation and the payee change is not re-judged (hostEventOrgAccess already required ADMIN_ROLES).',
  'dashboard/business/route.js':
    'Reads only user.activeLocation.id; its assertLocationAccess is on that same active id held in a variable, so the "another location" sign is a false positive.',
  'settings/scoring/route.js':
    'PUT gates MANAGER_ROLES and writes user.activeLocation.id; its assertLocationAccess is on that same active id held in a variable (GET is ungated).',
}

// Pre-check-only matches whose decision at the target lives in a helper
// module the scan cannot follow. `reason` names the helper and the call.
export const PRECHECK_REVIEWED = {
  'qualifications/route.js':
    'Decided in src/lib/qualifications-server.js. GET hands the membership-checked ?location_id to loadQualificationsPage, which judges hasRoleAtLocation(user, locationId, QUAL_MANAGER_ROLES) for the manager view (anyone else gets their own records). POST decides in createQualificationRecord via findManagingStudio: hasRoleAtLocation at a studio the PERSON belongs to, 404 if none. The hasRoleAtAnyLocation is only its early refusal.',
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
    expect(activeRoleGates("if (!hasMobilePermission(user, 'churn_radar')) {}")).toEqual(['hasMobilePermission(user,'])
    expect(activeRoleGates("if (!hasPermission(user, 'email') && !hasMobilePermission(user, 'email')) {}"))
      .toEqual(['hasPermission(user,', 'hasMobilePermission(user,'])
    expect(activeRoleGates("if (!hasPermissionForLocation(user, id, 'orders')) {}")).toEqual([])
    expect(activeRoleGates("if (!hasRoleAtLocation(user, id, MANAGER_ROLES)) {}")).toEqual([])
    expect(activeRoleGates("if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {}")).toEqual([])
    expect(activeRoleGates("if (!hasPermissionAtAnyLocation(user, 'email')) {}")).toEqual([])
  })
})

describe('the pre-check-only scan', () => {
  const PRE = "if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) return no()\n"
  const ROW = "const g = assertLocationAccessOr404(user, seq.location_id)\nif (g) return g\n"
  const AT = "if (!hasRoleAtLocation(user, seq.location_id, MANAGER_ROLES)) return no()\n"

  it('flags a pre-check plus another-location use with no decision at the target', () => {
    expect(anyLocationPreChecks(PRE)).toEqual(['hasRoleAtAnyLocation('])
    expect(anyLocationPreChecks("hasPermissionAtAnyLocation(user, 'email')")).toEqual(['hasPermissionAtAnyLocation('])
    expect(preCheckOnly(PRE + ROW)).toBe(true)
    expect(preCheckOnly("if (!hasPermissionAtAnyLocation(user, 'sms')) return no()\nconst ids = getUserLocationIds(user)")).toBe(true)
  })

  it('passes once the target is judged, in the route or in a local helper', () => {
    expect(preCheckOnly(PRE + ROW + AT)).toBe(false)
    expect(preCheckOnly(PRE + ROW + "if (!hasPermissionForLocation(user, seq.location_id, 'email')) return no()")).toBe(false)
    expect(preCheckOnly(PRE + ROW + "const denied = guardMasterOrOwner(user, seq.location_id)")).toBe(false)
    const localHelper = "async function loadOwned(db, user, id) {\n  " + AT + "}\n"
    expect(preCheckOnly(localHelper + PRE + ROW)).toBe(false)
  })

  it('ignores a pre-check with no other-location use, a decision named only in an import or a comment', () => {
    expect(preCheckOnly(PRE)).toBe(false)
    expect(preCheckOnly("import { hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'\n" + PRE + ROW)).toBe(true)
    expect(preCheckOnly(PRE + ROW + "// judged by hasRoleAtLocation(user, loc, ROLES) below\n")).toBe(true)
    expect(targetJudgements("hasRoleAtLocationish(user)")).toEqual([])
  })

  // ROLESWEEP.1c — the mobile twins (src/lib/permissions.js).
  it('knows the mobile pre-check and the mobile decision at the target', () => {
    const MPRE = "if (!hasMobilePermissionAtAnyLocation(user, 'email')) return no()\n"
    expect(anyLocationPreChecks(MPRE)).toEqual(['hasMobilePermissionAtAnyLocation('])
    expect(preCheckOnly(MPRE + ROW)).toBe(true)
    expect(targetJudgements("hasMobilePermissionForLocation(user, seq.location_id, 'email')")).toEqual(['hasMobilePermissionForLocation('])
    expect(preCheckOnly(MPRE + ROW + "if (!hasMobilePermissionForLocation(user, seq.location_id, 'email')) return no()")).toBe(false)
    expect(activeRoleGates("hasMobilePermissionForLocation(user, id, 'email') || hasMobilePermissionAtAnyLocation(user, 'email')")).toEqual([])
  })
})

// ROLESWEEP.2 — requireApiKeyOrManager's cookie branch is a coarse pre-check.
describe('the requireApiKeyOrManager scan', () => {
  const CALL = "const auth = await requireApiKeyOrManager(request)\nif (!auth.ok) return auth.response\n"
  const AT = "if (auth.user && !hasRoleAtLocation(auth.user, row.location_id, MANAGER_ROLES)) return no()\n"

  it('flags a caller with no decision at the target', () => {
    expect(apiKeyOrManagerCalls(CALL)).toEqual(['requireApiKeyOrManager('])
    expect(apiKeyOrManagerUnjudged(CALL)).toBe(true)
    expect(apiKeyOrManagerUnjudged(CALL + "const g = assertLocationAccess(auth.user, body.location_id)")).toBe(true)
  })

  it('passes once the target is judged in the file (route or local helper)', () => {
    expect(apiKeyOrManagerUnjudged(CALL + AT)).toBe(false)
    expect(apiKeyOrManagerUnjudged(CALL + "if (!hasPermissionForLocation(auth.user, loc, 'contacts')) return no()")).toBe(false)
    expect(apiKeyOrManagerUnjudged("async function access(db, user, id) {\n  " + AT + "}\n" + CALL)).toBe(false)
  })

  it('ignores the name in an import or a comment, and a file that never calls it', () => {
    expect(apiKeyOrManagerCalls("import { requireApiKeyOrManager } from '@/lib/api-auth'")).toEqual([])
    expect(apiKeyOrManagerUnjudged("// requireApiKeyOrManager(request) gates it\n")).toBe(false)
    expect(apiKeyOrManagerUnjudged(CALL + "// judged by hasRoleAtLocation(auth.user, loc, ROLES)\n")).toBe(true)
    expect(apiKeyOrManagerUnjudged(AT)).toBe(false)
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

  it('no route stops at the any-location pre-check while acting on another location', () => {
    const preOnly = routeFiles(API).filter((f) => preCheckOnly(fs.readFileSync(f, 'utf8'))).map(rel).sort()
    expect(preOnly.filter((r) => !(r in PRECHECK_REVIEWED))).toEqual([])
    for (const [route, reason] of Object.entries(PRECHECK_REVIEWED)) {
      expect(typeof reason === 'string' && reason.length > 20, `${route}: give a reason`).toBe(true)
    }
    expect(Object.keys(PRECHECK_REVIEWED).filter((r) => !preOnly.includes(r))).toEqual([])
  })

  // ROLESWEEP.2 — no allowlist: a caller that acts only on the active studio
  // judges hasRoleAtLocation(auth.user, auth.user.activeLocation.id, …).
  it('every requireApiKeyOrManager caller decides at the target in the same file', () => {
    const read = (f) => fs.readFileSync(f, 'utf8')
    const callers = routeFiles(API).filter((f) => apiKeyOrManagerCalls(read(f)).length > 0).map(rel)
    expect(callers).toEqual(expect.arrayContaining([
      'bookings/event-types/[id]/route.js', 'contacts/[id]/route.js', 'contacts/route.js', 'stages/route.js',
    ]))
    expect(routeFiles(API).filter((f) => apiKeyOrManagerUnjudged(read(f))).map(rel).sort()).toEqual([])
  })

  it('no route is in two lists', () => {
    const all = [...Object.keys(REVIEWED), ...pendingRoutes.map((p) => p.route)]
    expect(all.filter((r, i) => all.indexOf(r) !== i)).toEqual([])
  })
})
