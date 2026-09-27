// TRAINERSROLE.1 — a floor, not a proof (the check:select-columns posture).
//
// Every route under src/app/api/locations/[id]/ acts on the location in its
// PATH. `user.role` is the caller's role at their ACTIVE studio
// (resolveActiveLocationRole in src/lib/auth.js), so a role check written on
// it judges the wrong studio: the SCHEDROLES.1 / LOCFIX-ROLEGATE.1 class, last
// seen here in glofox-trainers, glofox-memberships, unifi-users and
// unifi-doors. This fails if a route in this folder checks `user.role` (or
// `user?.role`) against a role list or a non-master role, either operand
// order, switches on it, or calls hasPermission(user, …) (which resolves
// against the ACTIVE location too). Judge the role at the path's id instead:
// hasRoleAtLocation(user, id, ROLES), guardMasterOrOwner(user, id),
// hasPermissionForLocation(user, id, key), or user.rolesByLocation[id].
//
// ALLOWED: `user.role === 'master'` / `!== 'master'`. resolveActiveLocationRole
// answers 'master' only for a profiles.role master and rolesByLocation never
// holds 'master', so that comparison does not depend on the active studio.
// Prefer `user.isMaster` in new code.
//
// BLIND SPOTS, a reviewer's job: the role copied into a variable first
// (`const r = user.role; ROLES.includes(r)`), a destructured
// (`const { role } = user`) or renamed user (`me.role`), a role read inside a
// helper, a client component's gate, and every route OUTSIDE this folder
// (about 40 still check `user.role` against a list; see the TRAINERSROLE.1
// plan, follow-up F1). And stripComments (scripts/lib/strip-comments.mjs) has
// no regex-literal awareness: a `//` inside a regex literal strips the rest of
// that line as a comment. Its header calls that the safe direction, and it is
// for check:route-guards (a REQUIRED token lost fails loudly), but here the
// tokens are FORBIDDEN, so a gate on the same line after such a regex is a
// SILENT PASS. Pinned by the last self-test below.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../../scripts/lib/strip-comments.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.js') out.push(full)
  }
  return out
}

// `user.role` or `user?.role`, and not `user.rolesByLocation` (the \b).
const USER_ROLE = String.raw`\buser\??\.role\b`
const NON_MASTER = String.raw`['"](?:owner|manager|head_coach|reception|staff)['"]`
const EQ = String.raw`\s*[!=]==?\s*`
const PATTERNS = [
  new RegExp(String.raw`\.(?:includes|has)\(\s*${USER_ROLE}\s*\)`, 'g'), // ROLES.includes(user.role)
  new RegExp(`${USER_ROLE}${EQ}${NON_MASTER}`, 'g'), //                     user.role === 'owner'
  new RegExp(`${NON_MASTER}${EQ}${USER_ROLE}`, 'g'), //                     'owner' === user.role
  new RegExp(String.raw`\bswitch\s*\(\s*${USER_ROLE}\s*\)`, 'g'), //     switch (user.role) { case 'owner': }
  // hasPermission() resolves against the ACTIVE location's role, assignment
  // and features, so it is the same bug one call away. hasPermissionForLocation
  // (user, id, key) is the per-location form; the \( right after the name keeps
  // it out.
  /\bhasPermission\(\s*user\s*,/g,
]

function activeRoleGates(source) {
  const code = stripComments(source)
  return PATTERNS.flatMap((re) => [...code.matchAll(re)].map((m) => m[0]))
}

describe('/api/locations/[id] routes judge the role at the path location', () => {
  it('catches the shape TRAINERSROLE.1 removed, and not a comment or a master check', () => {
    expect(activeRoleGates('if (!ALLOWED_ROLES.has(user.role)) {')).toEqual(['.has(user.role)'])
    expect(activeRoleGates('if (!MANAGER_ROLES.includes(user.role)) {')).toEqual(['.includes(user.role)'])
    expect(activeRoleGates("if (user.role === 'owner') {")).toEqual(["user.role === 'owner'"])
    expect(activeRoleGates('// the old ALLOWED_ROLES.has(user.role) check')).toEqual([])
    expect(activeRoleGates("const isMaster = user.role === 'master'")).toEqual([])
  })

  // Review 1: the shapes the first cut missed. `user?.role` is the common one
  // (18 route.js files under src/app/api contain it, 27 Sep 2026).
  it('catches optional chaining, the reversed operand order, switch, and hasPermission(user, …)', () => {
    expect(activeRoleGates("if (user?.role === 'owner') {")).toEqual(["user?.role === 'owner'"])
    expect(activeRoleGates('if (!ADMIN_ROLES.includes(user?.role)) {')).toEqual(['.includes(user?.role)'])
    expect(activeRoleGates("if ('owner' === user.role) {")).toEqual(["'owner' === user.role"])
    expect(activeRoleGates("if ('manager' !== user?.role) {")).toEqual(["'manager' !== user?.role"])
    expect(activeRoleGates("switch (user.role) { case 'owner': break }")).toEqual(['switch (user.role)'])
    expect(activeRoleGates("switch (user?.role) {")).toEqual(['switch (user?.role)'])
    expect(activeRoleGates("if (!hasPermission(user, 'settings')) {")).toEqual(['hasPermission(user,'])
    // Not these: the per-location resolvers, a master check either way round,
    // and rolesByLocation (a different property).
    expect(activeRoleGates("hasPermissionForLocation(user, id, 'settings')")).toEqual([])
    expect(activeRoleGates("if ('master' === user?.role) {")).toEqual([])
    expect(activeRoleGates("switch (user.rolesByLocation[id]) {")).toEqual([])
    expect(activeRoleGates("ADMIN_ROLES.includes(user.rolesByLocation[id])")).toEqual([])
  })

  // KNOWN BLIND SPOT, pinned so it stays visible: stripComments has no
  // regex-literal awareness, so a `//` inside a regex literal strips the rest
  // of that line, and a gate on the same line vanishes. For this guard
  // (forbidden tokens) that is a SILENT PASS, the opposite of the
  // check:route-guards direction its header describes. If stripComments learns
  // regex literals, flip this expectation.
  it('misses a gate on the same line after a regex literal containing //', () => {
    expect(activeRoleGates("const re = /https?:\\/\\//; if (ADMIN_ROLES.includes(user.role)) {")).toEqual([])
  })

  it('no route in this folder checks user.role against a role', () => {
    const files = routeFiles(HERE)
    expect(files.length).toBeGreaterThan(30) // 41 on 27 Sep 2026; a wrong HERE finds 0
    const offenders = files.flatMap((file) =>
      activeRoleGates(fs.readFileSync(file, 'utf8')).map((hit) => `${path.relative(HERE, file)}: ${hit}`))
    expect(offenders).toEqual([])
  })
})
