// CONTACTREADSCOPE.1b guard (mig 690): the migration and drift halves.
//
// Since mig 690 the one SELECT policy on public.contacts admits a staff
// session only at studios where it holds Contacts, through
// private.auth_contact_read_location_ids(), whose last tier is a role-default
// list written inline in SQL (the JS maps cannot be read from SQL). Pinned:
//
//  (c) no migration after 690 puts contacts' SELECT back on membership
//      (a contacts policy that does not call the helper, or that ORs
//      auth_is_in_location back in), or drops the helper without re-creating
//      it in the same file;
//  (d) the helper's two default-role lists (web, then phone), read from the
//      LATEST migration that creates it, equal the roles for which
//      DEFAULT_WEB_PERMISSIONS_BY_ROLE / DEFAULT_MOBILE_PERMISSIONS_BY_ROLE
//      say contacts: true. Change a default in JS and this fails until a
//      migration re-creates the helper with the new list.
//
// The client half (every client read of contacts on a reasoned census) is
// tests/contacts-read-scope-guard.test.js, from CONTACTREADSCOPE.1a (#1911).
// A floor, not a proof: SQL built at runtime is invisible, and the helper's
// other tiers are checked by the replay's parity matrix
// (tests/migration-690-contacts-read-scope.test.js), not here.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'
import { DEFAULT_WEB_PERMISSIONS_BY_ROLE, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE } from '../shared/permissions.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
export const CONTACT_READ_SCOPE_MIGRATION = 690
const HELPER = 'auth_contact_read_location_ids'
const migNum = (f) => Number.parseInt(f, 10)
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (migNum(a) - migNum(b)) || a.localeCompare(b))
const CREATES_HELPER = new RegExp(`\\bcreate\\s+(or\\s+replace\\s+)?function\\s+private\\s*\\.\\s*${HELPER}\\b`, 'i')

/** Statements in `sql` that would put contacts' SELECT back on membership, or remove the helper. */
export function contactReadScopeBreakers(sql) {
  const code = sqlCode(sql)
  const hits = []
  const policies = /\b(create|alter)\s+policy\s+("?\w+"?)\s+on\s+(?:public\s*\.\s*)?"?contacts"?(?![\w"])([\s\S]*?)(?:;|$)/gi
  for (const m of code.matchAll(policies)) {
    const body = m[3]
    // a write policy is the 653 guard's business; a policy that only renames is fine
    if (/\bfor\s+(insert|update|delete)\b/i.test(body)) continue
    if (/^\s*rename\b/i.test(body)) continue
    if (!new RegExp(`\\b${HELPER}\\b`).test(body) || /\bauth_is_in_location\b/.test(body)) hits.push(m[0].trim().replace(/\s+/g, ' '))
  }
  const drops = new RegExp(`\\bdrop\\s+function\\s+(?:if\\s+exists\\s+)?private\\s*\\.\\s*${HELPER}\\b[^;]*`, 'gi')
  for (const m of code.matchAll(drops)) {
    if (!CREATES_HELPER.test(code.slice(m.index))) hits.push(m[0].trim())
  }
  return hits
}

/** The role lists the helper's two CASE defaults use, from the LATEST migration that creates it. */
export function helperDefaultRoles(files = migrationFiles()) {
  const creators = files.filter((f) => CREATES_HELPER.test(sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8'))))
  const latest = creators.at(-1)
  if (!latest) return { latest: null, lists: [] }
  const sql = sqlCode(readFileSync(path.join(MIGRATIONS, latest), 'utf8'))
  const lists = [...sql.matchAll(/ELSE\s+pl\s*\.\s*role\s+IN\s*\(([^)]*)\)/gi)]
    .map((m) => m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort())
  return { latest, lists }
}

describe('(c) later migrations keep contacts_select on the Contacts helper', () => {
  it('no migration after 690 puts it back on membership or drops the helper', () => {
    const offenders = migrationFiles().filter((f) => migNum(f) > CONTACT_READ_SCOPE_MIGRATION)
      .flatMap((f) => contactReadScopeBreakers(readFileSync(path.join(MIGRATIONS, f), 'utf8')).map((h) => `${f}: ${h}`))
    expect(offenders, 'contacts_select must keep reading private.auth_contact_read_location_ids() (CONTACTREADSCOPE.1, mig 690)').toEqual([])
  })

  it('690 itself passes, and the detector catches the shapes that would undo it', () => {
    const f690 = migrationFiles().find((f) => migNum(f) === CONTACT_READ_SCOPE_MIGRATION)
    expect(f690, 'mig 690 missing').toBeTruthy()
    expect(contactReadScopeBreakers(readFileSync(path.join(MIGRATIONS, f690), 'utf8'))).toEqual([])
    // the 1 Oct policy back
    expect(contactReadScopeBreakers(`ALTER POLICY contacts_select ON public.contacts USING (private.auth_is_in_location(location_id) OR user_id = (SELECT auth.uid()));`)).toHaveLength(1)
    // a second, wider read policy
    expect(contactReadScopeBreakers(`CREATE POLICY contacts_staff ON public.contacts FOR SELECT TO authenticated USING (true);`)).toHaveLength(1)
    expect(contactReadScopeBreakers(`create policy "contacts_all" on contacts for all to authenticated using (true);`)).toHaveLength(1)
    // the helper ORed with membership
    expect(contactReadScopeBreakers(`ALTER POLICY contacts_select ON public.contacts USING (location_id = ANY ((SELECT private.${HELPER}())::uuid[]) OR private.auth_is_in_location(location_id));`)).toHaveLength(1)
    // the helper dropped, and dropped-then-recreated
    expect(contactReadScopeBreakers(`DROP FUNCTION private.${HELPER}();`)).toHaveLength(1)
    expect(contactReadScopeBreakers(`DROP FUNCTION private.${HELPER}(); CREATE FUNCTION private.${HELPER}() RETURNS uuid[] LANGUAGE sql AS $$ SELECT '{}'::uuid[] $$;`)).toEqual([])
    // not breakers: a comment, a write policy, a rename, a child table's policy
    expect(contactReadScopeBreakers(`-- ALTER POLICY contacts_select ON public.contacts USING (true);`)).toEqual([])
    expect(contactReadScopeBreakers(`CREATE POLICY contacts_ins ON public.contacts FOR INSERT TO authenticated WITH CHECK (false);`)).toEqual([])
    expect(contactReadScopeBreakers(`ALTER POLICY contacts_select ON public.contacts RENAME TO contacts_read;`)).toEqual([])
    expect(contactReadScopeBreakers(`CREATE POLICY contact_goals_read ON public.contact_goals FOR SELECT USING (private.auth_is_in_location(location_id));`)).toEqual([])
    expect(contactReadScopeBreakers(`CREATE POLICY x ON public.contacts_archive FOR SELECT USING (true);`)).toEqual([])
  })
})

describe("(d) the helper's role defaults are the JS defaults", () => {
  const holders = (map) => Object.entries(map).filter(([, v]) => v.contacts === true).map(([r]) => r).sort()

  it('the latest definition has two default lists: web, then phone', () => {
    const { latest, lists } = helperDefaultRoles()
    expect(latest, 'no migration creates private.auth_contact_read_location_ids').toBeTruthy()
    expect(lists).toHaveLength(2)
    expect(lists[0], 'web: DEFAULT_WEB_PERMISSIONS_BY_ROLE[*].contacts changed; re-create the helper with the new list').toEqual(holders(DEFAULT_WEB_PERMISSIONS_BY_ROLE))
    expect(lists[1], 'phone: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[*].contacts changed; re-create the helper with the new list').toEqual(holders(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE))
  })

  it('the web and phone maps know the same roles (no role silently defaults to no on one side)', () => {
    expect(Object.keys(DEFAULT_WEB_PERMISSIONS_BY_ROLE).sort()).toEqual(Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE).sort())
  })
})
