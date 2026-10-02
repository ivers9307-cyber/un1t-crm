// Shared detectors for the ways a later migration can hand a client session
// what an earlier one closed, without ever naming the closed table in a GRANT
// (GUARDSTRIP.1, C74; found in C89's review, estate-wide across the
// 646…684 per-table guards). Each takes one migration's SQL, or the whole
// replay, and reads it through sqlCode (comments blanked by the quote-aware,
// $tag$-pairing scan, never a regex).
//
//   roleLeaks          a role membership that gives a client role (anon,
//                      authenticated, PUBLIC) another role's privileges, or
//                      makes another role one of them; an object handed to a
//                      client role with OWNER TO
//   movedInto          ALTER … SET SCHEMA public, and ALTER … RENAME TO a
//                      closed table's name (a relation with its own ACL takes
//                      the closed name)
//   viewReplay         every view in public at the end of the replay, with
//                      whether it is security_invoker: a simple view runs as
//                      its owner and is auto-updatable, so a client privilege
//                      on a definer view over a closed table bypasses both the
//                      REVOKE and RLS
//   functionReplay     every public function's latest definition: SECURITY
//                      DEFINER or not, and the tables its body writes
//
// A floor, not a proof: SQL built at runtime (EXECUTE of a format() string),
// an old-style '…'-quoted function body and a policy made by hand on prod are
// invisible.

import { sqlCode, ident, splitTop } from './sql-code.js'

export const CLIENT_ROLES = ['anon', 'authenticated', 'public']

/**
 * Tables a migration closed to client sessions (all access, or writes), with
 * the closing migration. One list for the estate-wide checks; every table a
 * per-table guard closes is here (tests/closed-table-escapes-guard.test.js
 * fails on one that is not).
 */
export const CLOSED_TABLES = Object.freeze({
  // 646 NOTESGRANT.1: column grants (no table-level SELECT); 676 SHIFTCLIENTWRITE.1: no client writes
  shift_blocks: 646, shift_assignments: 646,
  // 648 SECFIX.3c: credential columns withheld; three tables with no client access
  locations: 648, contact_external_integrations: 648, channel_connections: 648, whatsapp_numbers: 648, xero_connections: 648,
  glofox_push_events: 651, // PASSCODEREAD.1
  contacts: 653, // CONTACTSELFWRITE.1 (657: anon off)
  email_sequences: 654, sequence_steps: 654, sequence_enrollments: 654, // PROFILESPREAD.1b
  whatsapp_messages: 656, // WAMSGCLIENTWRITE.1 (673: anon off)
  contact_preferences: 660, contact_location_preferences: 660, consent_log: 660, // CONSENTCLIENTWRITE.1, 662
  whatsapp_conversations: 661, whatsapp_broadcasts: 661, whatsapp_broadcast_recipients: 661, // WACONVCLIENTWRITE.1
  staff_attendance_events: 668, shift_swap_requests: 668, time_off_requests: 668, // GRANTSWEEP.1
  whatsapp_templates: 669, whatsapp_template_events: 669, // WATPLCLIENTWRITE.1
  challenges: 672, contact_segments: 672, car_notes: 672, // ANYMEMBERWRITE.1
  cars: 674, car_documents: 674, car_bca_submissions: 674, car_bca_submission_events: 674, company_settings: 674, // CARSCLIENTWRITE.1
  rosters: 679, shift_templates: 679, // ROSTERCLIENTWRITE.1
  // 680-684 MEMBERWRITESWEEP.1a-1e (tests/member-write-sweep-guard.test.js SWEEP)
  coach_kudos: 680, coaching_goals: 680, inbody_scans: 680, consultation_photos: 680, consultations: 680,
  presentations: 681, presentation_slides: 681, orders: 681, location_automations: 681, location_holidays: 681,
  person_groups: 681, person_group_members: 681, person_link_suggestions: 681,
  race_events: 682, teams: 682, race_registrations: 682, race_payments: 682, race_penalties: 682, race_waves: 682, team_members: 682,
  email_sends: 683, email_templates: 683, sms_broadcasts: 683, sms_broadcast_recipients: 683, agent_message_feedback: 683,
  campaigns: 684, campaign_recipients: 684,
  // 692 MEMBERWRITESWEEP.2/.3 (PR #1914, open when this was written; listed
  // ahead so the drift check holds whichever of the two merges first)
  blocked_times: 692, contact_events: 692, contact_tags: 692, shift_block_removals: 692, staff_allowances: 692,
  scheduled_reports: 692, race_checkins: 692, event_type_reminders: 692, promo_codes: 692, event_reminder_sends: 692,
  host_contacts: 692, host_campaigns: 692,
})

const NAME = String.raw`((?:"?[a-z_][\w]*"?\s*\.\s*)?"?[a-z_][\w]*"?)(?![\w."%$])`
function splitName(qualified) {
  const parts = qualified.split('.').map(ident)
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: 'public', name: parts[0] }
}
const one = (s) => s.trim().replace(/\s+/g, ' ')
const roleList = (list) => splitTop(list.replace(/\s+(with\s+(grant|admin|inherit|set)\s+option|with\s+(admin|inherit|set)\s+\w+|granted\s+by\b|cascade|restrict)[\s\S]*$/i, '')).map(ident)
const isClient = (r) => CLIENT_ROLES.includes(r)
const SUPABASE_AUTHENTICATOR = 'authenticator'

const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const MEMBERSHIP_RE = /\bgrant\s+((?:(?!\bon\b)[^;'$])+?)\s+to\s+([^;'$]+)/gi
const OWNER_RE = /\balter\s+(?:table|view|materialized\s+view|sequence|function|procedure|routine|schema|type|domain)\s+[^;]+?\bowner\s+to\s+"?(anon|authenticated|public)"?/gi
const CREATE_ROLE_RE = /\bcreate\s+(?:role|user|group)\s+("?[a-z_][\w]*"?)([^;]*)/gi
const ALTER_GROUP_RE = /\balter\s+group\s+("?[a-z_][\w]*"?)\s+add\s+user\s+([^;]+)/gi

/**
 * Role memberships that involve a client role, and objects handed to one.
 * `GRANT service_role TO authenticated`, `CREATE ROLE x ROLE authenticated`
 * and `ALTER GROUP x ADD USER authenticated` make a client role a member of
 * another role, so every signed-in (or anonymous) caller gets its privileges;
 * `GRANT authenticated TO x`, `CREATE ROLE x IN ROLE authenticated` and
 * `ALTER GROUP authenticated ADD USER x` give a new role a client role's
 * privileges. None has a use here: clients get named privileges on named
 * objects. The one exception is Supabase's own `authenticator`, the login
 * role PostgREST switches to anon/authenticated from.
 */
export function roleLeaks(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const out = []
  for (const [stmt, granted, to] of code.matchAll(MEMBERSHIP_RE)) {
    if (/\bon\b/i.test(stmt)) continue
    if (/^\s*(all|select|insert|update|delete|truncate|references|trigger|maintain|usage|execute|create|connect|temporary|temp)\b/i.test(granted)) continue
    const members = roleList(to)
    if (members.some(isClient) || (roleList(granted).some(isClient) && members.some((r) => r !== SUPABASE_AUTHENTICATOR))) out.push(one(stmt))
  }
  for (const [stmt] of code.matchAll(OWNER_RE)) out.push(one(stmt))
  for (const [stmt, role, opts] of code.matchAll(CREATE_ROLE_RE)) {
    const lists = [...opts.matchAll(/\b(?:in\s+role|in\s+group|role|user|admin)\s+((?:"?[a-z_][\w]*"?\s*,\s*)*"?[a-z_][\w]*"?)/gi)].flatMap((m) => roleList(m[1]))
    if (isClient(ident(role)) || lists.some(isClient)) out.push(one(stmt))
  }
  for (const [stmt, group, users] of code.matchAll(ALTER_GROUP_RE)) {
    const users_ = roleList(users)
    if (users_.some(isClient) || (isClient(ident(group)) && users_.some((r) => r !== SUPABASE_AUTHENTICATOR))) out.push(one(stmt))
  }
  return [...new Set(out)]
}

const SET_SCHEMA_RE = new RegExp(String.raw`\balter\s+(table|view|materialized\s+view|sequence|foreign\s+table)\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+set\s+schema\s+"?public"?`, 'gi')
const RENAME_RE = new RegExp(String.raw`\balter\s+(table|view|materialized\s+view|foreign\s+table)\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+rename\s+to\s+"?([a-z_][\w]*)"?`, 'gi')

/**
 * A relation moved into public, or renamed to a closed table's name: it keeps
 * its own ACL, so a client grant it carried now applies under that name.
 */
export function movedInto(sql, closed = Object.keys(CLOSED_TABLES)) {
  const code = sqlCode(sql)
  const out = []
  for (const [stmt] of code.matchAll(SET_SCHEMA_RE)) out.push(one(stmt))
  for (const [stmt, , , to] of code.matchAll(RENAME_RE)) if (closed.includes(ident(to))) out.push(one(stmt))
  return out
}

// ── views ────────────────────────────────────────────────────────────────
const CREATE_VIEW_RE = new RegExp(String.raw`\bcreate\s+(or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${NAME}\s*(?:\([^)]*\)\s*)?(?:with\s*\(([^)]*)\)\s*)?as\b([^;]*)`, 'gi')
const DROP_VIEW_RE = /\bdrop\s+(materialized\s+)?view\s+(?:if\s+exists\s+)?([^;]+)/gi
const ALTER_VIEW_OPT_RE = new RegExp(String.raw`\balter\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?${NAME}\s+(set|reset)\s*\(([^)]*)\)`, 'gi')
const ALTER_VIEW_RENAME_RE = new RegExp(String.raw`\balter\s+(?:table|view|materialized\s+view)\s+(?:if\s+exists\s+)?${NAME}\s+rename\s+to\s+"?([a-z_][\w]*)"?`, 'gi')
const VIEW_SET_SCHEMA_RE = new RegExp(String.raw`\balter\s+(view|materialized\s+view)\s+(?:if\s+exists\s+)?${NAME}\s+set\s+schema\s+"?public"?`, 'gi')

/** security_invoker from a reloptions list: true, false, or undefined when not named. */
function invokerOpt(opts = '') {
  const m = opts.match(/\bsecurity_invoker\b\s*(?:=\s*'?(\w+)'?)?/i)
  if (!m) return undefined
  return !m[1] || /^(on|true|1|yes)$/i.test(m[1])
}
/** The relations a view's query reads (FROM / JOIN targets), unqualified public names. */
export function relationsRead(query) {
  return [...new Set([...query.matchAll(new RegExp(String.raw`\b(?:from|join)\s+(?:only\s+)?${NAME}`, 'gi'))]
    .map((m) => splitName(m[1])).filter((n) => n.schema === 'public').map((n) => n.name))]
}

/**
 * Every view in public after running these migrations in order:
 * Map<name, { materialized, invoker, reads, file }>. CREATE OR REPLACE VIEW
 * takes its options from its own WITH clause (an omitted security_invoker is
 * off), ALTER VIEW … SET/RESET (security_invoker) changes it, RENAME and DROP
 * move or remove it, and a view moved in by SET SCHEMA public counts as a
 * definer view over unknown relations.
 */
export function viewReplay(migrations) {
  const views = new Map()
  for (const { file, sql } of migrations) {
    const code = sqlCode(sql)
    const events = []
    for (const m of code.matchAll(CREATE_VIEW_RE)) {
      const { schema, name } = splitName(m[3])
      if (schema !== 'public' || /\btemp/i.test(m[0].slice(0, 40))) continue
      events.push([m.index, () => views.set(name, { materialized: !!m[2], invoker: invokerOpt(m[4]) === true, reads: relationsRead(m[5]), file })])
    }
    for (const m of code.matchAll(DROP_VIEW_RE)) {
      const names = splitTop(m[2].replace(/\s+(cascade|restrict)\s*$/i, '')).map(splitName).filter((n) => n.schema === 'public')
      events.push([m.index, () => names.forEach((n) => views.delete(n.name))])
    }
    for (const m of code.matchAll(ALTER_VIEW_OPT_RE)) {
      const { schema, name } = splitName(m[1])
      const opt = invokerOpt(m[3])
      if (schema !== 'public' || (opt === undefined && !/security_invoker/i.test(m[3]))) continue
      events.push([m.index, () => { const v = views.get(name); if (v) v.invoker = m[2].toLowerCase() === 'set' ? opt === true : false }])
    }
    for (const m of code.matchAll(ALTER_VIEW_RENAME_RE)) {
      const { schema, name } = splitName(m[1])
      if (schema !== 'public') continue
      events.push([m.index, () => { if (views.has(name)) { views.set(ident(m[2]), views.get(name)); views.delete(name) } }])
    }
    for (const m of code.matchAll(VIEW_SET_SCHEMA_RE)) {
      events.push([m.index, () => views.set(splitName(m[2]).name, { materialized: /materialized/i.test(m[1]), invoker: false, reads: ['(moved in: unknown)'], file })])
    }
    for (const [, apply] of events.sort((a, b) => a[0] - b[0])) apply()
  }
  return views
}

// ── functions ────────────────────────────────────────────────────────────
const CREATE_FN_RE = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${NAME}\s*\(`, 'gi')
const DROP_FN_RE = new RegExp(String.raw`\bdrop\s+(?:function|procedure)\s+(?:if\s+exists\s+)?${NAME}`, 'gi')
const WRITE_RE = new RegExp(String.raw`\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into)\s+(?:only\s+)?${NAME}`, 'gi')

/** The tables a function body writes (INSERT/UPDATE/DELETE/TRUNCATE/MERGE), unqualified public names. */
export function tablesWritten(body) {
  return [...new Set([...body.matchAll(WRITE_RE)].map((m) => splitName(m[1])).filter((n) => n.schema === 'public').map((n) => n.name))]
}

/** One CREATE FUNCTION statement from `at`: its attribute text (body excluded) and its dollar-quoted body. */
function functionStatement(code, at) {
  let i = at
  let depth = 0
  let body = ''
  let attrs = ''
  while (i < code.length) {
    const c = code[i]
    if (c === '$') {
      const tag = code.slice(i, i + 64).match(/^\$([A-Za-z_][\w]*)?\$/)
      if (tag) {
        const end = code.indexOf(tag[0], i + tag[0].length)
        const stop = end === -1 ? code.length : end
        body += code.slice(i + tag[0].length, stop)
        i = stop + tag[0].length
        continue
      }
    }
    if (c === "'") { const j = code.indexOf("'", i + 1); attrs += code.slice(i, j + 1); i = j === -1 ? code.length : j + 1; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ';' && depth <= 0) break
    attrs += c
    i++
  }
  return { attrs, body }
}

/**
 * Every public function's latest definition after running these migrations:
 * Map<name, { definer, writes, file }> (overloads share a name; the latest
 * CREATE wins, which is the conservative reading for the grant check).
 */
export function functionReplay(migrations) {
  const fns = new Map()
  for (const { file, sql } of migrations) {
    const code = sqlCode(sql)
    const events = []
    for (const m of code.matchAll(CREATE_FN_RE)) {
      const { schema, name } = splitName(m[1])
      if (schema !== 'public') continue
      const { attrs, body } = functionStatement(code, m.index)
      events.push([m.index, () => fns.set(name, { definer: /\bsecurity\s+definer\b/i.test(attrs), writes: tablesWritten(body), file })])
    }
    for (const m of code.matchAll(DROP_FN_RE)) {
      const { schema, name } = splitName(m[1])
      if (schema === 'public') events.push([m.index, () => fns.delete(name)])
    }
    for (const [, apply] of events.sort((a, b) => a[0] - b[0])) apply()
  }
  return fns
}

const EXECUTE_GRANT_RE = new RegExp(String.raw`\bgrant\s+(?:execute|all(?:\s+privileges)?)\s+on\s+(?:function|procedure|routine)\s+${NAME}[^;]*?\bto\s+([^;'$]+)`, 'gi')
/** Public functions this file grants EXECUTE (or ALL) to a client role. */
export function clientExecuteGrants(sql) {
  const out = []
  for (const m of sqlCode(sql).replace(ADP_RE, ' ').matchAll(EXECUTE_GRANT_RE)) {
    const { schema, name } = splitName(m[1])
    if (schema === 'public' && roleList(m[2]).some(isClient)) out.push(name)
  }
  return out
}
