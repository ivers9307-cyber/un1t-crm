// CLOSEDFNREGRANT.1 (C147): the functions a migration deliberately closed to
// client roles, and a reader for the ways a later migration reopens one.
//
// The one registry. tests/closed-function-regrant-guard.test.js checks every
// entry against its closing file and every later migration, and fails when a
// migration from 677 on revokes EXECUTE on a named function from
// authenticated without the function being listed here.
//
// Why a later DROP + CREATE reopens a closed function: prod's pg_default_acl
// gives authenticated (and service_role) EXECUTE on every function postgres
// creates in schema private (mig 678's deliberate default, so new policy
// helpers work). A new function object takes the default ACL, so a
// migration that drops a closed function and creates it again, or creates it
// with plain CREATE FUNCTION, reopens it unless the same file revokes it again
// after the CREATE. CREATE OR REPLACE of a function that still exists keeps
// its ACL, so on its own it is fine. In schema public the default has been
// service_role only since mig 667, so there a re-CREATE starts closed; the
// guard still wants the REVOKE (CLAUDE.md: every new function not called by a
// client states it), which also holds on a database whose defaults were reset.
//
// Fictional ids only: the repo is public.

import { sqlCode, ident, splitTop } from './sql-code.js'

/**
 * Every function closed to authenticated, anon and PUBLIC, oldest first.
 * `closedBy` is the number of the migration that closed it; `args` is the
 * signature, for the error message (the reader matches on schema + name
 * and does not tell overloads apart).
 */
export const CLOSED_FUNCTIONS = [
  { fn: 'private.mobile_can_location_ids_for', args: '(uuid, text)', closedBy: 691,
    why: 'answers which locations ANY user id may act at; only the auth_ wrapper is for clients' },
  { fn: 'private.shift_template_qualification_cap', args: '()', closedBy: 695,
    why: 'a trigger function; a trigger fires without EXECUTE' },
  { fn: 'private.seed_staff_qualification_types', args: '()', closedBy: 695,
    why: 'a trigger function; a trigger fires without EXECUTE' },
  { fn: 'public.publish_sequence_steps', args: '(uuid, jsonb)', closedBy: 698,
    why: 'SECURITY DEFINER sequence publish; the server route calls it as service_role' },
  { fn: 'private.mobile_can_for', args: '(uuid, uuid, text)', closedBy: 699,
    why: 'answers a mobile permission for ANY user id' },
  { fn: 'private.get_user_role', args: '(uuid)', closedBy: 700,
    why: 'answers the role of ANY user id' },
  { fn: 'private.get_user_role_at', args: '(uuid, uuid)', closedBy: 700,
    why: 'answers the role of ANY user id at a location' },
  { fn: 'public.move_unavailable_time_off_to_availability', args: '(date)', closedBy: 703,
    why: 'AVAIL.3 data move: deletes and splits time_off_requests rows; an operator runs it as postgres' },
  { fn: 'public.restore_moved_unavailable_time_off', args: '(uuid)', closedBy: 703,
    why: 'AVAIL.3 rollback: re-inserts time_off_requests rows and deletes availability rules; operator only' },
  { fn: 'public.move_race_registration', args: '(uuid, uuid, uuid, uuid, int, int, boolean, text, uuid, text, text)', closedBy: 708,
    why: 'EVENT-MOVE.1: re-points any event entry (and its payment) to another event and clones its team; the staff/host routes judge every rule first' },
]

/** The client roles a closed function is closed to. */
export const CLIENT_ROLES = ['authenticated', 'anon', 'public']

const KINDS = '(?:function|procedure|routine)'
const TAIL = /\s+(with\s+grant\s+option|granted\s+by\b|cascade|restrict)\b[\s\S]*$/i
const rolesOf = (list) => splitTop(list.replace(TAIL, '')).map(ident)

/** 'private.get_user_role(uuid)' or '"private"."get_user_role"' -> 'private.get_user_role'; unqualified -> public. */
export function fnName(ref) {
  const parts = ref.replace(/\([\s\S]*$/, '').split('.').map(ident).filter(Boolean)
  return parts.length === 1 ? `public.${parts[0]}` : parts.slice(-2).join('.')
}

/** The functions a GRANT/REVOKE target names: a list, or ALL FUNCTIONS IN SCHEMA s (as 'schema:s'). */
function targetsOf(target) {
  const t = target.trim()
  const all = t.match(/^all\s+(?:functions|procedures|routines)\s+in\s+schema\s+([\s\S]+)$/i)
  if (all) return splitTop(all[1]).map((s) => `schema:${ident(s)}`)
  const one = t.match(new RegExp(`^${KINDS}\\s+([\\s\\S]+)$`, 'i'))
  return one ? splitTop(one[1]).map(fnName) : []
}

/**
 * The privilege events in one migration, in file order, read from its code
 * (comments blanked by sqlCode; string and $$ contents kept, so a statement
 * run from EXECUTE '…' counts):
 *   { kind: 'drop',   fns }               DROP FUNCTION/PROCEDURE/ROUTINE
 *   { kind: 'create', fns, replace }      CREATE [OR REPLACE] FUNCTION/PROCEDURE
 *   { kind: 'rename', from, to }          ALTER FUNCTION … RENAME TO …
 *   { kind: 'revoke', fns, roles }        REVOKE EXECUTE/ALL (not GRANT OPTION FOR)
 *   { kind: 'grant',  fns, roles }        GRANT EXECUTE/ALL
 * `fns` holds 'schema.name' and, for ALL FUNCTIONS IN SCHEMA s, 'schema:s'.
 * ALTER DEFAULT PRIVILEGES is skipped (it moves no existing function).
 */
export function privilegeEvents(sql) {
  const code = sqlCode(sql).replace(/\balter\s+default\s+privileges\b[^;]*/gi, (m) => ' '.repeat(m.length))
  const events = []
  const at = (re, fn) => { for (const m of code.matchAll(re)) { const e = fn(m); if (e) events.push({ ...e, index: m.index }) } }

  at(new RegExp(`\\bdrop\\s+${KINDS}\\s+(?:if\\s+exists\\s+)?([^;]+)`, 'gi'), (m) =>
    ({ kind: 'drop', fns: splitTop(m[1].replace(TAIL, '')).map(fnName) }))
  at(new RegExp(`\\bcreate\\s+(or\\s+replace\\s+)?(?:function|procedure)\\s+([\\w."$]+)\\s*\\(`, 'gi'), (m) =>
    ({ kind: 'create', fns: [fnName(m[2])], replace: Boolean(m[1]) }))
  at(new RegExp(`\\balter\\s+${KINDS}\\s+([\\w."$]+)\\s*(?:\\([^;]*?\\))?\\s+rename\\s+to\\s+([\\w"$]+)`, 'gi'), (m) => {
    const from = fnName(m[1])
    return { kind: 'rename', from, to: `${from.split('.')[0]}.${ident(m[2])}` }
  })
  at(/\brevoke\s+(grant\s+option\s+for\s+)?([^;]+?)\s+on\s+([^;]+?)\s+from\s+([^;]+)/gi, (m) => {
    if (m[1] || !/\b(execute|all)\b/i.test(m[2])) return null
    return { kind: 'revoke', fns: targetsOf(m[3]), roles: rolesOf(m[4]) }
  })
  at(/\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;]+)/gi, (m) => {
    if (!/\b(execute|all)\b/i.test(m[1])) return null
    return { kind: 'grant', fns: targetsOf(m[2]), roles: rolesOf(m[3]) }
  })
  return events.sort((a, b) => a.index - b.index)
}

/** Does a GRANT/REVOKE event reach `fn`, by name or through ALL FUNCTIONS IN its schema? */
const reaches = (e, fn) => e.fns.includes(fn) || e.fns.includes(`schema:${fn.split('.')[0]}`)

/**
 * Walk one migration for one closed function. `state` is { present, open }:
 * whether the function exists, and the client roles that can execute it.
 * Returns the state after the file. A new function object (a plain CREATE,
 * CREATE OR REPLACE after a DROP, or a RENAME onto the name) starts open to
 * every client role, the stricter reading of the default ACL; a REVOKE closes
 * the roles it names, a GRANT to a client role opens them.
 */
export function walkFunction(sql, fn, state = { present: true, open: [] }) {
  let present = state.present
  const open = new Set(state.open)
  for (const e of privilegeEvents(sql)) {
    if (e.kind === 'drop' && e.fns.includes(fn)) { present = false; open.clear() }
    else if (e.kind === 'create' && e.fns.includes(fn)) {
      if (!e.replace || !present) CLIENT_ROLES.forEach((r) => open.add(r))
      present = true
    } else if (e.kind === 'rename') {
      if (e.from === fn) { present = false; open.clear() }
      if (e.to === fn) { present = true; CLIENT_ROLES.forEach((r) => open.add(r)) }
    } else if (e.kind === 'revoke' && reaches(e, fn)) {
      for (const r of e.roles) open.delete(r)
    } else if (e.kind === 'grant' && reaches(e, fn)) {
      for (const r of e.roles) if (CLIENT_ROLES.includes(r)) open.add(r)
    }
  }
  return { present, open: CLIENT_ROLES.filter((r) => open.has(r)) }
}

/**
 * Functions one migration REVOKEs EXECUTE (or ALL) on, by name, from
 * authenticated, and leaves closed to it at the end of the file: a function it
 * revokes from every client role and then grants back to authenticated (the
 * "REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO
 * authenticated" idiom for a client-callable function) is not closed.
 */
export function closedToAuthenticated(sql) {
  const named = [...new Set(privilegeEvents(sql)
    .filter((e) => e.kind === 'revoke' && e.roles.includes('authenticated'))
    .flatMap((e) => e.fns.filter((f) => !f.startsWith('schema:'))))]
  const allOpen = { present: true, open: CLIENT_ROLES }
  return named.filter((fn) => {
    const after = walkFunction(sql, fn, allOpen)
    return after.present && !after.open.includes('authenticated')
  })
}
