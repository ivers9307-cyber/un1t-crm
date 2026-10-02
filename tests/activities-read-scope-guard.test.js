// ACTIVITIESREAD.1 (follow-ups C132, SEC-3) — static guard: who reads
// public.activities directly.
//
// C132 found `activities` readable by any member of a studio (a contractor
// whose role template switches phone Tasks off read 70,483 rows). Mig 691
// (MOBILECANTEMPLATES.1) closed it: the one SELECT policy admits a signed-in
// session only at studios where it holds phone Tasks OR phone Pipeline, as
// resolvePermission says (role templates included). Re-measured on prod
// 2 Oct 2026 (rolled-back probes): the 6 contractor memberships with Tasks
// off by template read 0 rows at that studio. Pinned here, on the replayed
// net policy state:
//   (a) exactly one permissive policy covering SELECT on activities, for
//       authenticated only, in the 691 wrapper form (tasks OR pipeline) and
//       nothing else (no membership helper, no `true`, no other function);
//   (b) no migration after 691 gives anon or PUBLIC a privilege on it.
// A floor, not a proof: a policy made by hand on prod or by dynamic SQL is
// invisible; the replay of the migration that changes it is the proof.
//
// SEC-4 (C144, mig 700; Richard 2 Oct 2026): reading activities ALSO needs
// Contacts at the studio (every activity row belongs to a contact), so the
// one reader is now (tasks OR pipeline) AND the mig 690 Contacts helper,
// all three as InitPlans. tests/migration-700-sec-4.test.js is the replay.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'
import { sqlCode, ident, splitTop } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
export const ACTIVITIES_READ_MIGRATION = 691
const migNum = (f) => Number.parseInt(f, 10)
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .sort((a, b) => migNum(a) - migNum(b) || a.localeCompare(b))

const norm = (e) => (e || '').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim().toLowerCase()
const WRAPPER = (k) => `location_id = any ((select private.auth_mobile_can_location_ids('${k}'))::uuid[])`
const CONTACTS = 'location_id = any ((select private.auth_contact_read_location_ids())::uuid[])'
export const ACTIVITIES_READ = `(${WRAPPER('tasks')} or ${WRAPPER('pipeline')}) and ${CONTACTS}`

/** Permissive policies that let a client role read activities, from a replayed policy state. */
export function activitiesReaders(policies) {
  return policies.filter((p) => p.table === 'public.activities' && p.permissive === 'PERMISSIVE'
    && (p.cmd === 'SELECT' || p.cmd === 'ALL')
    && p.roles.some((r) => ['authenticated', 'anon', 'public'].includes(r)))
}

/** GRANTs in one migration that give anon or PUBLIC anything on activities. */
export function anonActivitiesGrants(sql) {
  const out = []
  for (const [stmt, , target, to] of sqlCode(sql).matchAll(/\bgrant\s+([^;]+?)\s+on\s+(?:table\s+)?([^;]+?)\s+to\s+([^;]+)/gi)) {
    const tables = splitTop(target).map((t) => t.split('.').map(ident).at(-1))
    const all = /^all\s+tables\s+in\s+schema\s+/i.test(target.trim())
    const roles = splitTop(to.replace(/\s+with\s+grant\s+option[\s\S]*$/i, '')).map(ident)
    if ((all || tables.includes('activities')) && roles.some((r) => ['anon', 'public'].includes(r))) out.push(stmt.trim().replace(/\s+/g, ' '))
  }
  return out
}

describe('(a) activities is read on phone Tasks / Pipeline AND Contacts only (migs 691 + 700)', () => {
  const readers = activitiesReaders(netPolicyState(MIGRATIONS))

  it('exactly one reader: activities_select, authenticated, the 700 form', () => {
    expect(readers.map((p) => `${p.name} ${p.cmd} ${p.roles.join(',')} (${p.file})`)).toHaveLength(1)
    const [p] = readers
    expect(p.name).toBe('activities_select')
    expect(p.roles).toEqual(['authenticated'])
    expect(norm(p.using), 'activities must not go back to membership (C132) or drop Contacts (C144)').toBe(ACTIVITIES_READ)
  })

  it('the detector catches the shapes that would reopen it', () => {
    const state = (body) => [{ table: 'public.activities', name: 'x', permissive: 'PERMISSIVE', ...body }]
    expect(activitiesReaders(state({ cmd: 'ALL', roles: ['authenticated'], using: 'private.auth_is_in_location(location_id)' }))).toHaveLength(1)
    expect(activitiesReaders(state({ cmd: 'SELECT', roles: ['public'], using: 'true' }))).toHaveLength(1)
    expect(activitiesReaders(state({ cmd: 'DELETE', roles: ['authenticated'], using: 'true' }))).toEqual([])
    expect(activitiesReaders(state({ cmd: 'SELECT', roles: ['service_role'], using: 'true' }))).toEqual([])
    expect(norm(`(location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])
          OR location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]))
         AND location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])`)).toBe(ACTIVITIES_READ)
    // the 691 form without Contacts is no longer enough (C144)
    expect(norm(`${WRAPPER('tasks')} or ${WRAPPER('pipeline')}`)).not.toBe(ACTIVITIES_READ)
    expect(norm(`${ACTIVITIES_READ} OR private.auth_is_in_location(location_id)`)).not.toBe(ACTIVITIES_READ)
  })
})

describe('(b) no later migration opens activities to anon / PUBLIC', () => {
  it('none after 691', () => {
    const offenders = migrationFiles().filter((f) => migNum(f) > ACTIVITIES_READ_MIGRATION)
      .flatMap((f) => anonActivitiesGrants(readFileSync(path.join(MIGRATIONS, f), 'utf8')).map((h) => `${f}: ${h}`))
    expect(offenders).toEqual([])
  })

  it('the detector', () => {
    expect(anonActivitiesGrants('GRANT SELECT ON public.activities TO anon;')).toHaveLength(1)
    expect(anonActivitiesGrants('grant all on table activities, deals to authenticated, public;')).toHaveLength(1)
    expect(anonActivitiesGrants('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;')).toHaveLength(1)
    expect(anonActivitiesGrants('GRANT SELECT ON public.activities TO authenticated;')).toEqual([])
    expect(anonActivitiesGrants('GRANT SELECT ON public.activities_log TO anon;')).toEqual([])
    expect(anonActivitiesGrants('-- GRANT SELECT ON public.activities TO anon;')).toEqual([])
  })
})
