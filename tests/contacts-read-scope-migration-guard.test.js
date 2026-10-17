// CONTACTREADSCOPE.1b guard (mig 690): the migration and drift halves.
//
// Since mig 690 the one SELECT policy on public.contacts admits a staff
// session only at studios where it holds Contacts, through
// private.auth_contact_read_location_ids(), whose last tier is a role-default
// list written inline in SQL (the JS maps cannot be read from SQL). Pinned:
//
//  (c) no migration after 690 widens contacts' SELECT. A contacts policy
//      that covers SELECT may OR together ONLY the known branches
//      (READ_BRANCHES below: the Contacts helper by the contact's studio,
//      the member's own row, and since mig 731 (UN1TDUAL.1) an active
//      membership at a studio where the caller holds Contacts, through
//      private.auth_contact_membership_contact_ids()), and must keep the
//      Contacts helper branch; anything else (auth_is_in_location, true, a
//      raw contact_memberships subquery, another helper) is a breaker. Also
//      breakers: a (re)definition of the membership helper whose body is not
//      exactly 731's (it must take its studios from
//      auth_contact_read_location_ids and count only active rows), dropping
//      either helper without re-creating it in the same file, or toggling
//      contacts' row level security (DISABLE turns every policy off; FORCE /
//      NO FORCE changes whether the owner's DEFINER functions and triggers
//      are bound by it) (SEC-3);
//  (d) the helper's two default-role lists (web, then phone), read from the
//      LATEST migration that creates it, equal the roles for which
//      DEFAULT_WEB_PERMISSIONS_BY_ROLE / DEFAULT_MOBILE_PERMISSIONS_BY_ROLE
//      say contacts: true. Change a default in JS and this fails until a
//      migration re-creates the helper with the new list;
//  (e) the latest helper keeps the organisation-admin tier (mig 699, SEC-3:
//      getCurrentUser's SAAS-4 synthetic owner at the org's active studios).
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
const MEMBERSHIP_HELPER = 'auth_contact_membership_contact_ids'

// The only branches a contacts policy covering SELECT may OR together,
// normalised (lowercase, no whitespace or double quotes, redundant parens and
// pg_policies' `AS alias` dropped). Adding one is a reviewed change here.
export const READ_BRANCHES = Object.freeze({
  contacts: `location_id=any((selectprivate.${HELPER}())::uuid[])`,        // 690: Contacts at the contact's studio
  own: 'user_id=(selectauth.uid())',                                       // members: their own row
  membership: `id=any((selectprivate.${MEMBERSHIP_HELPER}())::uuid[])`,     // 731: active member of a studio where the caller holds Contacts
})
// Mig 731's membership helper body, normalised the same way: studios from the
// Contacts resolver, active rows only. A redefinition must match it exactly.
export const MEMBERSHIP_HELPER_BODY = norm(`
  SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[])
    FROM public.contact_memberships cm
   WHERE cm.status = 'active'
     AND cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])`)

function norm(s) {
  let t = s.toLowerCase().replace(/\s+/g, '').replace(/"/g, '').replace(/\)as[a-z_][a-z0-9_]*\)/g, '))')
  for (;;) {
    const inner = stripOuter(t)
    if (inner === t) return t
    t = inner
  }
}
/** `(x)` -> `x` when the first paren closes at the very end. */
function stripOuter(s) {
  if (!s.startsWith('(')) return s
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) return i === s.length - 1 ? s.slice(1, -1).trim() : s }
  }
  return s
}
/** The text inside the first `USING ( … )` of a policy body, or null. Quotes are skipped. */
function usingExpr(body) {
  const m = /\busing\s*\(/i.exec(body)
  if (!m) return null
  let depth = 0
  let q = null
  for (let i = m.index + m[0].length - 1; i < body.length; i++) {
    const c = body[i]
    if (q) { if (c === q) q = null; continue }
    if (c === "'" || c === '"') { q = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return body.slice(m.index + m[0].length, i) }
  }
  return null
}
/** Top-level OR operands, flattened through parenthesised ORs. */
export function orBranches(expr) {
  const out = []
  const parts = []
  let depth = 0
  let q = null
  let start = 0
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (q) { if (c === q) q = null; continue }
    if (c === "'" || c === '"') { q = c; continue }
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /^or\b/i.test(expr.slice(i, i + 3)) && /[\s)]/.test(expr[i - 1] ?? ' ') && /[\s(]/.test(expr[i + 2] ?? ' ')) {
      parts.push(expr.slice(start, i)); start = i + 2
    }
  }
  parts.push(expr.slice(start))
  if (parts.length === 1) {
    const t = parts[0].trim()
    const inner = t.startsWith('(') ? stripOuter(t) : t
    return inner !== t ? orBranches(inner) : [t]
  }
  for (const p of parts) out.push(...orBranches(p.trim()))
  return out
}
const migNum = (f) => Number.parseInt(f, 10)
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (migNum(a) - migNum(b)) || a.localeCompare(b))
const CREATES_HELPER = new RegExp(`\\bcreate\\s+(or\\s+replace\\s+)?function\\s+private\\s*\\.\\s*${HELPER}\\b`, 'i')
const createsFn = (name) => new RegExp(`\\bcreate\\s+(or\\s+replace\\s+)?function\\s+private\\s*\\.\\s*${name}\\b`, 'i')

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
    const using = usingExpr(body)
    const branches = using === null ? null : orBranches(using).map(norm)
    const allowed = Object.values(READ_BRANCHES)
    if (!branches || !branches.includes(READ_BRANCHES.contacts) || branches.some((b) => !allowed.includes(b))) {
      hits.push(m[0].trim().replace(/\s+/g, ' '))
    }
  }
  // the membership helper (re)defined with any body but 731's, or not SECURITY DEFINER
  const membershipDefs = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+private\\s*\\.\\s*${MEMBERSHIP_HELPER}\\b([\\s\\S]*?)\\bas\\s+(\\$\\w*\\$)([\\s\\S]*?)\\2`, 'gi')
  for (const m of code.matchAll(membershipDefs)) {
    if (norm(m[3]) !== MEMBERSHIP_HELPER_BODY || !/\bsecurity\s+definer\b/i.test(m[1])) hits.push(`create function private.${MEMBERSHIP_HELPER} (body or SECURITY DEFINER differs from mig 731)`)
  }
  // contacts' row level security toggled (any ALTER TABLE action list on contacts)
  const alters = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?public"?\s*\.\s*)?"?contacts"?(?![\w"])([^;]*)/gi
  for (const m of code.matchAll(alters)) {
    if (/\b(disable|no\s+force|force)\s+row\s+level\s+security\b/i.test(m[1])) hits.push(m[0].trim().replace(/\s+/g, ' '))
  }
  for (const name of [HELPER, MEMBERSHIP_HELPER]) {
    const drops = new RegExp(`\\bdrop\\s+function\\s+(?:if\\s+exists\\s+)?private\\s*\\.\\s*${name}\\b[^;]*`, 'gi')
    for (const m of code.matchAll(drops)) {
      if (!createsFn(name).test(code.slice(m.index))) hits.push(m[0].trim())
    }
  }
  return hits
}

/** The role lists the helper's two CASE defaults use, from the LATEST migration that creates it. */
export function helperDefaultRoles(files = migrationFiles()) {
  const creators = files.filter((f) => CREATES_HELPER.test(sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8'))))
  const latest = creators.at(-1)
  if (!latest) return { latest: null, lists: [] }
  const sql = sqlCode(readFileSync(path.join(MIGRATIONS, latest), 'utf8'))
  // `pl.role` until 690, the effective role `er.role` since 699 (SEC-3)
  const lists = [...sql.matchAll(/ELSE\s+(?:pl|er)\s*\.\s*role\s+IN\s*\(([^)]*)\)/gi)]
    .map((m) => m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort())
  return { latest, lists, sql }
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

  it('731 (UN1TDUAL.1) passes: exactly its membership branch and helper are accepted', () => {
    const f731 = migrationFiles().find((f) => migNum(f) === 731)
    expect(f731, 'mig 731 missing').toBeTruthy()
    const sql731 = readFileSync(path.join(MIGRATIONS, f731), 'utf8')
    expect(contactReadScopeBreakers(sql731)).toEqual([])
    // the branch really is read (not waved through by a loose match)
    const using = sqlCode(sql731).match(/alter\s+policy\s+contacts_select\s+on\s+public\.contacts\s+using\s*\(([\s\S]*?)\);/i)[1]
    expect(orBranches(using).length).toBe(3)
    // the same branches in any order, extra parens, pg_policies' deparse
    const M = `id = ANY ((SELECT private.${MEMBERSHIP_HELPER}())::uuid[])`
    const C = `location_id = ANY ((SELECT private.${HELPER}())::uuid[])`
    expect(contactReadScopeBreakers(`ALTER POLICY contacts_select ON public.contacts USING ((${M}) OR (${C} OR user_id = (SELECT auth.uid())));`)).toEqual([])
    expect(contactReadScopeBreakers(`ALTER POLICY contacts_select ON public.contacts USING ((location_id = ANY (( SELECT private.${HELPER}() AS ${HELPER})::uuid[])) OR (id = ANY (( SELECT private.${MEMBERSHIP_HELPER}() AS ${MEMBERSHIP_HELPER})::uuid[])));`)).toEqual([])
  })

  it('every other widening of the read is still a breaker', () => {
    const C = `location_id = ANY ((SELECT private.${HELPER}())::uuid[])`
    const OWN = 'user_id = (SELECT auth.uid())'
    const M = `id = ANY ((SELECT private.${MEMBERSHIP_HELPER}())::uuid[])`
    for (const extra of [
      'private.auth_is_in_location(location_id)',
      'true',
      '1 = 1',
      // a membership branch WITHOUT the Contacts-readable restriction
      `id IN (SELECT cm.contact_id FROM public.contact_memberships cm WHERE cm.status = 'active')`,
      `EXISTS (SELECT 1 FROM public.contact_memberships cm WHERE cm.contact_id = contacts.id AND private.auth_is_in_location(cm.location_id))`,
      // the membership helper called per row, or under another name
      `id = ANY (private.${MEMBERSHIP_HELPER}())`,
      'id = ANY ((SELECT private.auth_contact_membership_ids_all())::uuid[])',
      // a widened form of an allowed branch
      `(${M} OR true)`,
      `location_id IS NULL`,
    ]) {
      const sql = `ALTER POLICY contacts_select ON public.contacts USING (${C} OR ${OWN} OR ${M} OR ${extra});`
      expect(contactReadScopeBreakers(sql), extra).toHaveLength(1)
    }
    expect(contactReadScopeBreakers('CREATE POLICY contacts_select ON public.contacts FOR SELECT USING (true);')).toHaveLength(1)
    // the membership branch must not REPLACE the Contacts branch
    expect(contactReadScopeBreakers(`ALTER POLICY contacts_select ON public.contacts USING (${OWN} OR ${M});`)).toHaveLength(1)
    // a role change with no USING is still reviewed
    expect(contactReadScopeBreakers('ALTER POLICY contacts_select ON public.contacts TO anon;')).toHaveLength(1)
  })

  it('the membership helper must keep 731\'s body (Contacts studios, active rows, DEFINER); dropping it needs a re-create', () => {
    const def = (body, extra = 'SECURITY DEFINER') => `CREATE OR REPLACE FUNCTION private.${MEMBERSHIP_HELPER}() RETURNS uuid[] LANGUAGE sql STABLE ${extra} SET search_path = '' AS $function$ ${body} $function$;`
    const ok = `SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[]) FROM public.contact_memberships cm WHERE cm.status = 'active' AND cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])`
    expect(contactReadScopeBreakers(def(ok))).toEqual([])
    for (const body of [
      // no Contacts-readable restriction: every active member anywhere
      `SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[]) FROM public.contact_memberships cm WHERE cm.status = 'active'`,
      // membership instead of Contacts
      `SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[]) FROM public.contact_memberships cm WHERE cm.status = 'active' AND private.auth_is_in_location(cm.location_id)`,
      // ended memberships too
      `SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[]) FROM public.contact_memberships cm WHERE cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])`,
    ]) expect(contactReadScopeBreakers(def(body)), body).toHaveLength(1)
    expect(contactReadScopeBreakers(def(ok, 'SECURITY INVOKER'))).toHaveLength(1)
    expect(contactReadScopeBreakers(`DROP FUNCTION private.${MEMBERSHIP_HELPER}();`)).toHaveLength(1)
    expect(contactReadScopeBreakers(`DROP FUNCTION IF EXISTS private.${MEMBERSHIP_HELPER}(); ${def(ok)}`)).toEqual([])
  })

  it('the latest definition of the membership helper in the migrations is 731\'s', () => {
    const creators = migrationFiles().filter((f) => createsFn(MEMBERSHIP_HELPER).test(sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8'))))
    expect(creators.at(-1), 'no migration creates the membership helper').toBeTruthy()
    // every definition passes the body check (contactReadScopeBreakers above runs on every file after 690)
    expect(migNum(creators[0])).toBe(731)
  })

  it('the detector catches row level security toggled on contacts (SEC-3), and nothing else', () => {
    for (const sql of [
      'ALTER TABLE public.contacts DISABLE ROW LEVEL SECURITY;',
      'alter table contacts disable row level security',
      'ALTER TABLE IF EXISTS ONLY "public"."contacts" FORCE ROW LEVEL SECURITY;',
      'ALTER TABLE public.contacts NO FORCE ROW LEVEL SECURITY;',
      'ALTER TABLE public.contacts ADD COLUMN x int, DISABLE ROW LEVEL SECURITY;',
    ]) expect(contactReadScopeBreakers(sql), sql).toHaveLength(1)
    for (const sql of [
      'ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.contacts_archive DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.contact_goals DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.contacts ADD COLUMN row_level text;',
      '-- ALTER TABLE public.contacts DISABLE ROW LEVEL SECURITY;',
    ]) expect(contactReadScopeBreakers(sql), sql).toEqual([])
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

  it('(e) the latest helper keeps the organisation-admin tier (mig 699)', () => {
    const { latest, sql } = helperDefaultRoles()
    expect(migNum(latest)).toBeGreaterThanOrEqual(699)
    const body = sql.slice(sql.search(CREATES_HELPER)).match(/\$function\$([\s\S]*?)\$function\$/)[1]
    expect(body).toMatch(/profile_organizations/)
    expect(body).toMatch(/role\s*=\s*'org_admin'/)
    expect(body).toMatch(/coalesce\(\s*l\.active\s*,\s*false\s*\)/i)
    expect(body).toMatch(/then\s+'owner'/i)
  })

  it('the web and phone maps know the same roles (no role silently defaults to no on one side)', () => {
    expect(Object.keys(DEFAULT_WEB_PERMISSIONS_BY_ROLE).sort()).toEqual(Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE).sort())
  })
})
