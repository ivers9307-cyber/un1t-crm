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
//      exactly 731's, 732's (UN1TDUAL.4, which adds un1t_clients rows
//      linked to a contact) or 756's (GLOFOXSIBLING.1, which adds
//      glofox_crossover_members rows); EVERY branch must take its studios from
//      auth_contact_read_location_ids, and the membership branch counts only
//      active rows), or that is
//      not SECURITY DEFINER with SET search_path = '' (EVERY CREATE of it is
//      read, whatever its body's quoting, attributes after the body included),
//      an ALTER FUNCTION on either helper in a migration after 731 (SECURITY
//      INVOKER, OWNER TO, SET / RESET search_path all change what the policy
//      runs without re-creating it), dropping
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
// The membership helper's accepted bodies, normalised the same way. A
// redefinition must match one of them exactly. Every branch takes its
// studios from the Contacts resolver (InitPlan form); adding one is a
// reviewed change here.
export const MEMBERSHIP_HELPER_BODIES = Object.freeze({
  // 731 (UN1TDUAL.1): active memberships only
  731: norm(`
  SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[])
    FROM public.contact_memberships cm
   WHERE cm.status = 'active'
     AND cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])`),
  // 732 (UN1TDUAL.4): plus un1t_clients rows linked to a contact, any status
  732: norm(`
  SELECT coalesce(array_agg(DISTINCT x.contact_id), '{}'::uuid[])
    FROM (
      SELECT cm.contact_id
        FROM public.contact_memberships cm
       WHERE cm.status = 'active'
         AND cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])
      UNION
      SELECT uc.contact_id
        FROM public.un1t_clients uc
       WHERE uc.contact_id IS NOT NULL
         AND uc.location_id = ANY ((SELECT private.${HELPER}())::uuid[])
    ) x`),
  // 756 (GLOFOXSIBLING.1): plus glofox_crossover_members rows (a Glofox
  // studio's member whose contact lives at a sibling studio)
  756: norm(`
  SELECT coalesce(array_agg(DISTINCT x.contact_id), '{}'::uuid[])
    FROM (
      SELECT cm.contact_id
        FROM public.contact_memberships cm
       WHERE cm.status = 'active'
         AND cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])
      UNION
      SELECT uc.contact_id
        FROM public.un1t_clients uc
       WHERE uc.contact_id IS NOT NULL
         AND uc.location_id = ANY ((SELECT private.${HELPER}())::uuid[])
      UNION
      SELECT gx.contact_id
        FROM public.glofox_crossover_members gx
       WHERE gx.location_id = ANY ((SELECT private.${HELPER}())::uuid[])
    ) x`),
})
// The body the LATEST migration that creates the helper must carry.
export const LATEST_MEMBERSHIP_HELPER_MIGRATION = 756
export const MEMBERSHIP_HELPER_BODY = MEMBERSHIP_HELPER_BODIES[LATEST_MEMBERSHIP_HELPER_MIGRATION]
const ACCEPTED_HELPER_BODIES = Object.values(MEMBERSHIP_HELPER_BODIES)

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
// The migration that created the membership helper; an ALTER FUNCTION on
// either helper after it is a breaker.
export const MEMBERSHIP_SCOPE_MIGRATION = 731
/** `private.<name>`, either part optionally double-quoted, not a longer name. */
const fnRef = (name) => `"?private"?\\s*\\.\\s*"?${name}"?(?![\\w"])`
const createsFn = (name) => new RegExp(`\\bcreate\\s+(or\\s+replace\\s+)?function\\s+${fnRef(name)}`, 'i')
const CREATES_HELPER = createsFn(HELPER)

/** The statement of `code` starting at `from`, up to its top-level `;` ('…', "…" and $tag$ bodies skipped). */
function statementAt(code, from) {
  let i = from
  while (i < code.length) {
    const c = code[i]
    if (c === ';') return code.slice(from, i)
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < code.length) { if (code[j] === c) { if (code[j + 1] === c) { j += 2; continue } break } j++ }
      i = j + 1
      continue
    }
    if (c === '$' && !/[\w$]/.test(code[i - 1] ?? '')) {
      const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(code.slice(i, i + 256))
      if (m) {
        const end = code.indexOf(m[0], i + m[0].length)
        if (end === -1) return code.slice(from)
        i = end + m[0].length
        continue
      }
    }
    i++
  }
  return code.slice(from)
}

/**
 * A function definition's body and the rest of its statement (every
 * attribute, before or after the body), or null when no `AS $tag$…$tag$` or
 * `AS '…'` body can be read (e.g. BEGIN ATOMIC).
 */
function definitionParts(stmt) {
  const b = /\bas\s+(?:(\$(?:[A-Za-z_]\w*)?\$)([\s\S]*?)\1|'((?:[^']|'')*)')/i.exec(stmt)
  if (!b) return null
  return {
    body: b[2] ?? b[3].replace(/''/g, "'"),
    attrs: `${stmt.slice(0, b.index)} ${stmt.slice(b.index + b[0].length)}`,
  }
}

/** Why a definition's attributes are not SECURITY DEFINER with SET search_path = '' (empty when they are). */
function definerAttrProblems(attrs) {
  const why = []
  if (!/\bsecurity\s+definer\b/i.test(attrs) || /\bsecurity\s+invoker\b/i.test(attrs)) why.push('not SECURITY DEFINER')
  const sets = [...attrs.matchAll(/\bset\s+search_path\b[^,;]*?(?=\b(?:set|security|language|stable|immutable|volatile|strict|called|returns|cost|rows|parallel|leakproof|not|as)\b|$)/gi)].map((m) => m[0])
  const empty = /^set\s+search_path\s*(?:=|to\b)\s*(?:''|"")\s*$/i
  if (sets.length === 0 || sets.some((x) => !empty.test(x.trim()))) why.push("no SET search_path = ''")
  return why
}

/** Every CREATE of the membership helper in `code` (comments already blanked) whose body is not exactly 731's, 732's or 756's. */
export function membershipHelperDefBreakers(code) {
  const hits = []
  const creates = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+${fnRef(MEMBERSHIP_HELPER)}`, 'gi')
  for (const m of code.matchAll(creates)) {
    const parts = definitionParts(statementAt(code, m.index))
    const why = []
    if (!parts) why.push('no AS body the guard can read')
    else {
      if (!ACCEPTED_HELPER_BODIES.includes(norm(parts.body))) why.push('body is not mig 731\'s, 732\'s or 756\'s')
      why.push(...definerAttrProblems(parts.attrs))
    }
    if (why.length) hits.push(`create function private.${MEMBERSHIP_HELPER} (${why.join('; ')})`)
  }
  return hits
}

/** ALTER FUNCTION / ALTER ROUTINE on either contacts read helper (a breaker after mig 731). */
export function contactHelperAlterBreakers(sql) {
  const code = sqlCode(sql)
  const hits = []
  for (const name of [HELPER, MEMBERSHIP_HELPER]) {
    const alters = new RegExp(`\\balter\\s+(?:function|routine)\\s+${fnRef(name)}[^;]*`, 'gi')
    for (const m of code.matchAll(alters)) hits.push(m[0].trim().replace(/\s+/g, ' '))
  }
  return hits
}

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
  // the membership helper (re)defined with any body but 731's, 732's or 756's, or not
  // SECURITY DEFINER with SET search_path = '' (every CREATE of it)
  hits.push(...membershipHelperDefBreakers(code))
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

  it('732 (UN1TDUAL.4) passes: its helper body (memberships + un1t clients, both on the Contacts resolver) is accepted', () => {
    const f732 = migrationFiles().find((f) => migNum(f) === 732)
    expect(f732, 'mig 732 missing').toBeTruthy()
    const sql732 = readFileSync(path.join(MIGRATIONS, f732), 'utf8')
    expect(contactReadScopeBreakers(sql732)).toEqual([])
    // the body really is read and is 732's (not waved through by a loose match)
    expect(membershipHelperDefBreakers(sqlCode(sql732))).toEqual([])
    const code = sqlCode(sql732)
    expect(norm(definitionParts(statementAt(code, code.search(createsFn(MEMBERSHIP_HELPER)))).body)).toBe(MEMBERSHIP_HELPER_BODIES[732])
    // 732 never touches the policy
    expect(code).not.toMatch(/\balter\s+policy\b/i)
  })

  it('a 732-shaped helper body is a breaker when EITHER branch loses the Contacts restriction', () => {
    const def = (body) => `CREATE OR REPLACE FUNCTION private.${MEMBERSHIP_HELPER}() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$ ${body} $function$;`
    const R = `((SELECT private.${HELPER}())::uuid[])`
    const MEM = `SELECT cm.contact_id FROM public.contact_memberships cm WHERE cm.status = 'active' AND cm.location_id = ANY ${R}`
    const CLI = `SELECT uc.contact_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL AND uc.location_id = ANY ${R}`
    const wrap = (...branches) => `SELECT coalesce(array_agg(DISTINCT x.contact_id), '{}'::uuid[]) FROM (${branches.join(' UNION ')}) x`
    // the accepted body, reformatted
    expect(contactReadScopeBreakers(def(wrap(MEM, CLI)))).toEqual([])
    expect(contactReadScopeBreakers(def(`
      SELECT coalesce(array_agg(DISTINCT x.contact_id), '{}'::uuid[])
        FROM ( ${MEM}
               UNION
               ${CLI} ) x`))).toEqual([])
    for (const [why, body] of [
      // an unrestricted un1t_clients branch: every linked client of every studio
      ['un1t branch, no studio restriction', wrap(MEM, `SELECT uc.contact_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL`)],
      ['un1t branch on membership, not Contacts', wrap(MEM, `SELECT uc.contact_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL AND private.auth_is_in_location(uc.location_id)`)],
      ['un1t branch on the resolver per row', wrap(MEM, `SELECT uc.contact_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL AND uc.location_id = ANY (private.${HELPER}())`)],
      ['un1t branch on another studio list', wrap(MEM, `SELECT uc.contact_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL AND uc.location_id IS NOT NULL`)],
      // the membership branch losing its restriction inside the union
      ['membership branch, no studio restriction', wrap(`SELECT cm.contact_id FROM public.contact_memberships cm WHERE cm.status = 'active'`, CLI)],
      ['membership branch, ended rows too', wrap(`SELECT cm.contact_id FROM public.contact_memberships cm WHERE cm.location_id = ANY ${R}`, CLI)],
      // a third branch
      ['a third branch', wrap(MEM, CLI, 'SELECT c.id FROM public.contacts c')],
      ['un1t branch OR-widened', wrap(MEM, `SELECT uc.contact_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL AND (uc.location_id = ANY ${R} OR true)`)],
    ]) expect(contactReadScopeBreakers(def(body)), why).toHaveLength(1)
    // and 732's body as INVOKER, or without the pinned search_path, is still a breaker
    expect(contactReadScopeBreakers(def(wrap(MEM, CLI)).replace('SECURITY DEFINER', 'SECURITY INVOKER'))).toHaveLength(1)
    expect(contactReadScopeBreakers(def(wrap(MEM, CLI)).replace(`SET search_path = ''`, 'SET search_path = public'))).toHaveLength(1)
  })

  it('EVERY create of the membership helper is read: a \'…\' body, attributes after the body, a second CREATE, quoted names', () => {
    const ok = `SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[]) FROM public.contact_memberships cm WHERE cm.status = 'active' AND cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])`
    const bad = `SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[]) FROM public.contact_memberships cm WHERE cm.status = 'active'`
    const quoted = (b) => `'${b.replace(/'/g, "''")}'`
    const head = `CREATE OR REPLACE FUNCTION private.${MEMBERSHIP_HELPER}() RETURNS uuid[] LANGUAGE sql STABLE`
    const good = `${head} SECURITY DEFINER SET search_path = '' AS $function$ ${ok} $function$;`
    expect(contactReadScopeBreakers(good)).toEqual([])
    // a single-quoted body: read and judged like a dollar-quoted one
    expect(contactReadScopeBreakers(`${head} SECURITY DEFINER SET search_path = '' AS ${quoted(ok)};`)).toEqual([])
    expect(contactReadScopeBreakers(`${head} SECURITY DEFINER SET search_path = '' AS ${quoted(bad)};`)).toHaveLength(1)
    // attributes AFTER the body are read too
    expect(contactReadScopeBreakers(`${head} SECURITY DEFINER SET search_path = '' AS $function$ ${ok} $function$ SECURITY INVOKER;`)).toHaveLength(1)
    expect(contactReadScopeBreakers(`${head} AS $function$ ${ok} $function$ SECURITY DEFINER SET search_path = '';`)).toEqual([])
    expect(contactReadScopeBreakers(`${head} SECURITY DEFINER SET search_path = '' AS $function$ ${ok} $function$ SET search_path = public;`)).toHaveLength(1)
    // a body the guard cannot read is a breaker, not a pass
    expect(contactReadScopeBreakers(`${head} SECURITY DEFINER SET search_path = '' BEGIN ATOMIC ${ok}; END;`)).toHaveLength(1)
    // every CREATE in a file counts: one good then one bad, and two bad
    expect(contactReadScopeBreakers(`${good}\n${head} SECURITY DEFINER SET search_path = '' AS $b$ ${bad} $b$;`)).toHaveLength(1)
    expect(contactReadScopeBreakers(`${head} SECURITY DEFINER SET search_path = '' AS ${quoted(bad)};\n${head} SECURITY INVOKER SET search_path = '' AS $b$ ${ok} $b$;`)).toHaveLength(2)
    // a quoted schema/function name is the same function
    expect(contactReadScopeBreakers(`CREATE OR REPLACE FUNCTION "private"."${MEMBERSHIP_HELPER}"() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$ ${bad} $f$;`)).toHaveLength(1)
    // a longer name is another function
    expect(contactReadScopeBreakers(`CREATE FUNCTION private.${MEMBERSHIP_HELPER}_v2() RETURNS uuid[] LANGUAGE sql AS $f$ ${bad} $f$;`)).toEqual([])
  })

  it('the membership helper must set search_path to \'\' (SECURITY DEFINER)', () => {
    const ok = `SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[]) FROM public.contact_memberships cm WHERE cm.status = 'active' AND cm.location_id = ANY ((SELECT private.${HELPER}())::uuid[])`
    const def = (attrs) => `CREATE OR REPLACE FUNCTION private.${MEMBERSHIP_HELPER}() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER ${attrs} AS $function$ ${ok} $function$;`
    expect(contactReadScopeBreakers(def(`SET search_path = ''`))).toEqual([])
    expect(contactReadScopeBreakers(def(`SET search_path TO ''`))).toEqual([])
    for (const attrs of ['', 'SET search_path = public', `SET search_path = '', public`, 'SET search_path FROM CURRENT', `SET search_path = 'public'`]) {
      expect(contactReadScopeBreakers(def(attrs)), attrs || '(none)').toHaveLength(1)
    }
  })

  it('no migration after 731 ALTERs either helper', () => {
    const offenders = migrationFiles().filter((f) => migNum(f) > MEMBERSHIP_SCOPE_MIGRATION)
      .flatMap((f) => contactHelperAlterBreakers(readFileSync(path.join(MIGRATIONS, f), 'utf8')).map((h) => `${f}: ${h}`))
    expect(offenders, 're-create the helper (CREATE OR REPLACE, the guarded form) instead of ALTERing it').toEqual([])
  })

  it('the ALTER detector catches every ALTER FUNCTION / ROUTINE on either helper, and nothing else', () => {
    for (const sql of [
      `ALTER FUNCTION private.${MEMBERSHIP_HELPER}() SECURITY INVOKER;`,
      `ALTER FUNCTION private.${MEMBERSHIP_HELPER}() OWNER TO authenticated;`,
      `ALTER FUNCTION private.${MEMBERSHIP_HELPER}() RESET search_path;`,
      `ALTER FUNCTION private.${HELPER}() SET search_path = public;`,
      `alter function "private"."${HELPER}" security invoker`,
      `ALTER ROUTINE private.${HELPER}() RESET ALL;`,
      `DO $$ BEGIN EXECUTE 'ALTER FUNCTION private.${MEMBERSHIP_HELPER}() SECURITY INVOKER'; END $$;`,
    ]) expect(contactHelperAlterBreakers(sql), sql).toHaveLength(1)
    for (const sql of [
      `-- ALTER FUNCTION private.${MEMBERSHIP_HELPER}() SECURITY INVOKER;`,
      `ALTER FUNCTION private.auth_contact_ids_other() SECURITY INVOKER;`,
      `ALTER FUNCTION private.${HELPER}_v2() SECURITY INVOKER;`,
      `COMMENT ON FUNCTION private.${HELPER}() IS 'x';`,
      `REVOKE ALL ON FUNCTION private.${MEMBERSHIP_HELPER}() FROM PUBLIC, anon;`,
    ]) expect(contactHelperAlterBreakers(sql), sql).toEqual([])
    // 731 itself creates, never alters
    const f731 = migrationFiles().find((f) => migNum(f) === MEMBERSHIP_SCOPE_MIGRATION)
    expect(contactHelperAlterBreakers(readFileSync(path.join(MIGRATIONS, f731), 'utf8'))).toEqual([])
  })

  it('the latest definition of the membership helper in the migrations is 732\'s', () => {
    const creators = migrationFiles().filter((f) => createsFn(MEMBERSHIP_HELPER).test(sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8'))))
    expect(creators.at(-1), 'no migration creates the membership helper').toBeTruthy()
    // every definition passes the body check (contactReadScopeBreakers above runs on every file after 690)
    expect(migNum(creators.at(-1))).toBe(LATEST_MEMBERSHIP_HELPER_MIGRATION)
    const code = sqlCode(readFileSync(path.join(MIGRATIONS, creators.at(-1)), 'utf8'))
    const parts = definitionParts(statementAt(code, code.search(createsFn(MEMBERSHIP_HELPER))))
    expect(norm(parts.body), 'the latest helper body must be the one LATEST_MEMBERSHIP_HELPER_MIGRATION names').toBe(MEMBERSHIP_HELPER_BODY)
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

  it('the latest helper is SECURITY DEFINER with SET search_path = \'\'', () => {
    const { sql } = helperDefaultRoles()
    const parts = definitionParts(statementAt(sql, sql.search(CREATES_HELPER)))
    expect(parts, 'the latest auth_contact_read_location_ids definition has no readable body').toBeTruthy()
    expect(definerAttrProblems(parts.attrs)).toEqual([])
  })

  it('the web and phone maps know the same roles (no role silently defaults to no on one side)', () => {
    expect(Object.keys(DEFAULT_WEB_PERMISSIONS_BY_ROLE).sort()).toEqual(Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE).sort())
  })
})
