// PRIVATEFNEXEC.1 guard (mig 678). Since 678 anon and PUBLIC execute no
// function in schema private, and a function postgres creates there is
// executable by postgres, authenticated and service_role (the default no
// longer names PUBLIC). anon has no USAGE on private, but a policy, view or
// default references a function by OID and skips that check, so a PUBLIC
// EXECUTE on a policy helper is reachable by anon wherever anon reaches the
// table. Pinned here, for every migration from 678 on:
//
//  1. No GRANT of EXECUTE (or ALL) on a private function, or on ALL
//     FUNCTIONS/ROUTINES IN SCHEMA private, to anon or PUBLIC.
//  2. No ALTER DEFAULT PRIVILEGES re-opens FUNCTIONS/ROUTINES to anon or
//     PUBLIC in private (or globally: mig 667 made the global default
//     postgres-only).
//  3. No GRANT USAGE on schema private to anon or PUBLIC.
//
// A floor, not a proof: SQL built at runtime is invisible. Removing
// authenticated's EXECUTE from a policy helper (which would 42501 every
// signed-in read through that policy) is not detected: the replay of the
// migration that does it must show a signed-in read.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { sqlCode, ident, splitTop } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const PRIVATE_FN_MIGRATION = 678
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')

const ANONISH = ['anon', 'public']
const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_RE = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const rolesOf = (list) => splitTop(list.replace(/\s+(with\s+grant\s+option|granted\s+by\b|cascade|restrict)[\s\S]*$/i, '')).map(ident)

/** GRANTs in one migration that open a private function (or the schema) to anon/PUBLIC (rules 1, 3). */
export function anonPrivateGrants(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const out = []
  for (const [stmt, privs, target, to] of code.matchAll(GRANT_RE)) {
    if (!rolesOf(to).some((r) => ANONISH.includes(r))) continue
    const t = target.trim()
    const s = stmt.trim().replace(/\s+/g, ' ')
    const all = t.match(/^all\s+(functions|routines|procedures)\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[2]).map(ident).includes('private')) out.push(s); continue }
    const schema = t.match(/^schema\s+([\s\S]+)$/i)
    if (schema) { if (/\busage\b|\ball\b/i.test(privs) && splitTop(schema[1]).map(ident).includes('private')) out.push(s); continue }
    if (!/^(function|procedure|routine)\s/i.test(t)) continue
    if (!/\b(execute|all)\b/i.test(privs)) continue
    const names = splitTop(t.replace(/^(function|procedure|routine)\s+/i, '')).map((i) => i.replace(/\([\s\S]*$/, '').split('.').map(ident))
    if (names.some((p) => p.length === 2 && p[0] === 'private')) out.push(s)
  }
  return out
}

/** ALTER DEFAULT PRIVILEGES that give anon/PUBLIC functions in private or globally (rule 2). */
export function privateDefaultReopeners(sql) {
  const hits = []
  for (const [stmt] of sqlCode(sql).matchAll(ADP_RE)) {
    if (!/\bgrant\s+[\s\S]+?\s+on\s+(functions|routines)\b/i.test(stmt)) continue
    const to = stmt.match(/\bto\s+([\s\S]+?)\s*;?\s*$/i)
    if (!to || !rolesOf(to[1]).some((r) => ANONISH.includes(r))) continue
    const schemas = stmt.match(/\bin\s+schema\s+([\s\S]+?)\s+grant\b/i)
    if (!schemas || splitTop(schemas[1]).map(ident).includes('private')) hits.push(stmt.trim().replace(/\s+/g, ' '))
  }
  return hits
}

const migrationFiles = () => readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))

describe('later migrations keep private functions closed to anon (mig 678)', () => {
  it('mig 678 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${PRIVATE_FN_MIGRATION}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= PRIVATE_FN_MIGRATION)
  it.each(later)('%s: opens no private function or default to anon/PUBLIC', (file) => {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
    expect(anonPrivateGrants(sql), `${file}: anon/PUBLIC may not execute a private function (mig 678); grant authenticated (and service_role) by name`).toEqual([])
    expect(privateDefaultReopeners(sql), `${file}: the private function default stays authenticated + service_role (mig 678)`).toEqual([])
  })
})

describe('the detectors', () => {
  it('anonPrivateGrants flags anon/PUBLIC on private functions and the schema', () => {
    for (const sql of [
      'GRANT EXECUTE ON FUNCTION private.auth_is_master() TO PUBLIC;',
      'GRANT EXECUTE ON FUNCTION private.auth_is_master(), private.auth_role() TO authenticated, anon;',
      'grant all on function private.mobile_can_for(uuid, uuid, text) to anon;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO PUBLIC;',
      'GRANT USAGE ON SCHEMA private TO anon;',
      `DO $$ BEGIN PERFORM 1; END $$;\nGRANT EXECUTE ON FUNCTION private.auth_is_master() TO anon; -- /* not a comment start`,
    ]) expect(anonPrivateGrants(sql), sql).not.toEqual([])
    for (const sql of [
      'GRANT EXECUTE ON FUNCTION private.auth_is_master() TO authenticated, service_role;',
      'GRANT EXECUTE ON FUNCTION public.f() TO anon;',
      'GRANT USAGE ON SCHEMA private TO authenticated;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;',
      'REVOKE EXECUTE ON FUNCTION private.auth_is_master() FROM PUBLIC, anon;',
      '-- rollback: GRANT EXECUTE ON FUNCTION private.auth_is_master() TO PUBLIC;',
    ]) expect(anonPrivateGrants(sql), sql).toEqual([])
  })

  it('privateDefaultReopeners flags a private or global function default to anon/PUBLIC', () => {
    for (const sql of [
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'alter default privileges for role postgres grant execute on routines to anon;',
    ]) expect(privateDefaultReopeners(sql), sql).not.toEqual([])
    for (const sql of [
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
    ]) expect(privateDefaultReopeners(sql), sql).toEqual([])
  })
})
