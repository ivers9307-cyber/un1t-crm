// TRAINERSROLE.1 — a floor, not a proof (the check:select-columns posture).
//
// Every route under src/app/api/locations/[id]/ acts on the location in its
// PATH. `user.role` is the caller's role at their ACTIVE studio
// (resolveActiveLocationRole in src/lib/auth.js), so a role check written on
// it judges the wrong studio: the SCHEDROLES.1 / LOCFIX-ROLEGATE.1 class, last
// seen here in glofox-trainers, glofox-memberships, unifi-users and
// unifi-doors. This fails if a route in this folder checks `user.role` against
// a role list or a non-master role. Judge the role at the path's id instead:
// hasRoleAtLocation(user, id, ROLES), guardMasterOrOwner(user, id), or
// user.rolesByLocation[id].
//
// ALLOWED: `user.role === 'master'` / `!== 'master'`. resolveActiveLocationRole
// answers 'master' only for a profiles.role master and rolesByLocation never
// holds 'master', so that comparison does not depend on the active studio.
// Prefer `user.isMaster` in new code.
//
// BLIND SPOTS, a reviewer's job: the role copied into a variable first
// (`const r = user.role; ROLES.includes(r)`), a role read inside a helper, a
// client component's gate, and every route OUTSIDE this folder (about 40 still
// check `user.role` against a list; see the TRAINERSROLE.1 plan, follow-up F1).

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

const ACTIVE_ROLE_IN_LIST = /\.(?:includes|has)\(\s*user\.role\s*\)/g
const ACTIVE_ROLE_EQUALS = /user\.role\s*[!=]==?\s*['"](?:owner|manager|head_coach|reception|staff)['"]/g

function activeRoleGates(source) {
  const code = stripComments(source)
  return [...code.matchAll(ACTIVE_ROLE_IN_LIST), ...code.matchAll(ACTIVE_ROLE_EQUALS)].map((m) => m[0])
}

describe('/api/locations/[id] routes judge the role at the path location', () => {
  it('catches the shape TRAINERSROLE.1 removed, and not a comment or a master check', () => {
    expect(activeRoleGates('if (!ALLOWED_ROLES.has(user.role)) {')).toEqual(['.has(user.role)'])
    expect(activeRoleGates('if (!MANAGER_ROLES.includes(user.role)) {')).toEqual(['.includes(user.role)'])
    expect(activeRoleGates("if (user.role === 'owner') {")).toEqual(["user.role === 'owner'"])
    expect(activeRoleGates('// the old ALLOWED_ROLES.has(user.role) check')).toEqual([])
    expect(activeRoleGates("const isMaster = user.role === 'master'")).toEqual([])
  })

  it('no route in this folder checks user.role against a role', () => {
    const files = routeFiles(HERE)
    expect(files.length).toBeGreaterThan(30) // 41 on 27 Sep 2026; a wrong HERE finds 0
    const offenders = files.flatMap((file) =>
      activeRoleGates(fs.readFileSync(file, 'utf8')).map((hit) => `${path.relative(HERE, file)}: ${hit}`))
    expect(offenders).toEqual([])
  })
})
