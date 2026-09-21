// RLSACTIVE.1 — static gate: staff authority at the RLS layer must require an
// ACTIVE, non-tombstoned profile, and must keep requiring it.
//
// Mig 626 made every staff helper and every inline policy that reads
// profiles / profile_locations / profile_organizations check
// `active IS NOT FALSE AND deleted_at IS NULL` (directly, or through
// private.auth_is_active_staff()). This file replays supabase/migrations —
// policies through the SAME parser check:rls-restrictive uses
// (netPolicyState, which follows DROP / ALTER POLICY / ALTER TABLE … RENAME
// TO), functions following ALTER FUNCTION … SET SCHEMA — and fails when a
// FUTURE migration:
//   * creates, re-creates, ALTERs or renames its way to a policy that reads a
//     profile table inline where the SELECT reading it does not carry
//     `auth_is_active_staff` (the gate must sit in the subquery that reads
//     the table, not anywhere in the policy);
//   * adds or redefines a private.auth_* / role helper, or ANY SECURITY
//     DEFINER function in public/private that reads a profile table, without
//     the predicate (tied to a SELECT that reads `profiles`), without
//     delegating to a gated helper, or without being classified here.
// A new function or policy that is genuinely NOT staff authority goes in the
// allowlists below WITH a reason — never a blanket skip.
//
// The table matcher fails CLOSED: comma joins (`FROM locations l,
// profile_locations pl`), quoted identifiers (`public."profiles"`), `FROM
// ONLY`, schema-qualified or not — any bare mention of the three table names
// counts as a read, so an odd spelling is flagged, never waved through.
//
// KNOWN BLIND SPOTS (floor, not proof):
//   * a policy or function created by hand on prod, or inside `DO $$ … $$` /
//     dynamic EXECUTE (the replay strips dollar-quoted bodies of DO blocks);
//   * a caller identified some other way than auth.uid() — e.g.
//     `auth.jwt()->>'sub'` or current_setting('request.jwt.claims');
//   * a new user-id helper whose name is outside auth_* / get_user_role* /
//     mobile_can_for AND which is SECURITY INVOKER (a DEFINER one reading a
//     profile table is caught by the definer rule);
//   * a view (views carry no policies; security_invoker views inherit the
//     underlying tables' RLS, which this file does cover);
//   * a function whose `SECURITY DEFINER` is written AFTER its body (the
//     definer flag is read from the header before `AS $$`);
//   * a gate that sits in a nested sub-subquery, or inside an `OR`, within the
//     SELECT that reads the table — the check is "the gate appears somewhere
//     in that SELECT", not "the gate constrains every row it returns";
//   * parentheses inside string literals (the group matcher ignores quotes).
// OVER-FLAGS one valid shape, accepted because it fails closed:
//   `(SELECT private.auth_is_active_staff()) AND EXISTS (SELECT … FROM
//   profile_locations …)` — correct, but the gate is outside the SELECT that
//   reads the table, so it is flagged; write the gate inside that SELECT.
// Mig 626's own self-check covers the live catalog at apply time.

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const GATE = /auth_is_active_staff/
// Any bare mention of a profile table (optionally schema-qualified, optionally
// quoted). Not preceded by a word char, `.` or `"` (so `pl.profile_id`,
// `auth_can_view_all_profiles` and `other_schema.profiles` do not match).
const TABLE_REF = /(?<![\w."])(?:"?public"?\s*\.\s*)?"?(profiles|profile_locations|profile_organizations)"?(?!\w)/gi
const PREDICATE_ACTIVE = /\bactive\s+is\s+not\s+false\b/i
const PREDICATE_DELETED = /\bdeleted_at\s+is\s+null\b/i

// ─── policies that read a profile table inline and legitimately carry no gate
const POLICY_ALLOW = {
  'public.staff_allowances :: staff_allowances_select': 'reads the TARGET\'s profile_locations; caller authority is private.auth_is_manager_at() (gated, mig 626). Own-row branch = subject.',
  'public.staff_allowances :: staff_allowances_ins': 'target-scoped; caller authority is private.auth_is_manager_at() (gated).',
  'public.staff_allowances :: staff_allowances_upd': 'target-scoped; caller authority is private.auth_is_manager_at() (gated).',
  'public.staff_allowances :: staff_allowances_del': 'target-scoped; caller authority is private.auth_is_manager_at() (gated).',
  'storage.objects :: Owners can upload branding': 'file text (mig 013) is stale: prod redefined it out-of-band to call private.is_owner() (mig 549), which mig 626 gates.',
  'storage.objects :: Owners can update branding': 'as above — prod calls private.is_owner().',
  'storage.objects :: Owners can delete branding': 'as above — prod calls private.is_owner().',
}

// ─── every function that decides authority from a profile, classified ───────
// predicate  = its own body carries `active IS NOT FALSE` + `deleted_at IS NULL`
//              inside a SELECT that reads `profiles`
// delegates  = its body calls the named helper(s), each of class `predicate`
// member / neutral = not staff authority (reason required)
const FUNCTIONS = {
  'private.auth_is_active_staff': { class: 'predicate' },
  'private.auth_is_master': { class: 'predicate' },
  'private.auth_is_in_location': { class: 'predicate' },
  'private.auth_is_owner_at': { class: 'predicate' },
  'private.auth_is_admin_at': { class: 'predicate' },
  'private.auth_is_manager_at': { class: 'predicate' },
  'private.auth_is_in_organization': { class: 'predicate' },
  'private.auth_role': { class: 'predicate' },
  'private.get_user_role': { class: 'predicate' },
  'private.get_user_role_at': { class: 'predicate' },
  'private.mobile_can_for': { class: 'predicate' },
  'private.auth_can_view_all_profiles': { class: 'predicate' },
  'private.auth_is_admin_or_head_coach': { class: 'predicate' },
  'private.is_owner': { class: 'predicate' },
  'private.auth_has_mailbox_grant': { class: 'predicate' },
  'private.auth_has_ticket_mailbox_grant': { class: 'predicate' },
  'private.auth_is_owner': { class: 'delegates', to: ['private.auth_role'] },
  'private.auth_is_owner_or_manager': { class: 'delegates', to: ['private.auth_role'] },
  'private.auth_mobile_can': { class: 'delegates', to: ['private.mobile_can_for'] },
  'private.auth_is_manager_at_bridge': { class: 'delegates', to: ['private.auth_is_manager_at'] },
  'private.auth_can_read_shift_block': { class: 'delegates', to: ['private.auth_is_manager_at', 'private.auth_is_in_location'] },
  'private.auth_can_read_shift_assignment': { class: 'delegates', to: ['private.auth_is_manager_at', 'private.auth_is_in_location'] },
  'private.auth_contact_id': { class: 'member', reason: 'MEMBER authority (contacts.user_id). A deactivated coach who is a member keeps it.' },
  ...NEUTRAL_DEFINERS(),
}

// SECURITY DEFINER functions that read a profile table but decide no caller's
// authority. Each needs a reason; a new one fails the definer rule until it is
// listed here or gated.
function NEUTRAL_DEFINERS () {
  const neutral = (reason) => ({ class: 'neutral', reason })
  return {
    'private.refuse_tombstone_access_row': neutral('trigger (mig 622): refuses access rows for a tombstone; reads deleted_at of NEW.profile_id.'),
    'public.handle_new_user': neutral('auth.users INSERT trigger (mig 404): mints the profile; no caller authority.'),
  }
}

const files = () => readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))

/** schema.name → { file, body, definer } for the LAST definition, following ALTER FUNCTION … SET SCHEMA. */
function latestFunctions () {
  const fns = new Map()
  const def = /create\s+(?:or\s+replace\s+)?function\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(/gi
  const move = /alter\s+function\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\([^)]*\)\s*set\s+schema\s+"?(\w+)"?/gi
  for (const f of files()) {
    const text = readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/--[^\n]*/g, (c) => ' '.repeat(c.length))
    const events = []
    for (const m of text.matchAll(def)) events.push({ at: m.index, kind: 'def', m })
    for (const m of text.matchAll(move)) events.push({ at: m.index, kind: 'move', m })
    events.sort((a, b) => a.at - b.at)
    for (const e of events) {
      if (e.kind === 'move') {
        const from = `${(e.m[1] || 'public').toLowerCase()}.${e.m[2].toLowerCase()}`
        const to = `${e.m[3].toLowerCase()}.${e.m[2].toLowerCase()}`
        if (fns.has(from)) { fns.set(to, fns.get(from)); fns.delete(from) }
        continue
      }
      const rest = text.slice(e.at)
      const open = rest.match(/\$(\w*)\$/)
      if (!open) continue
      const start = open.index + open[0].length
      const close = rest.indexOf(open[0], start)
      if (close < 0) continue
      const key = `${(e.m[1] || 'public').toLowerCase()}.${e.m[2].toLowerCase()}`
      fns.set(key, { file: f, body: rest.slice(start, close), definer: /\bsecurity\s+definer\b/i.test(rest.slice(0, open.index)) })
    }
  }
  return fns
}

/** Every profile-table mention: { table, index }. */
const tableRefs = (text) => [...text.matchAll(TABLE_REF)].map((m) => ({ table: m[1].toLowerCase(), index: m.index }))
const readsProfileTable = (text) => tableRefs(text).length > 0

/**
 * The innermost parenthesised group around `index` whose content starts with
 * SELECT — the subquery that reads the table. Join parentheses
 * (`FROM (profile_locations pl JOIN …)`) are skipped outward. No such group
 * (a function body's top-level SELECT) → the whole text.
 */
function enclosingSelect (text, index) {
  let from = index
  for (;;) {
    let depth = 0
    let open = -1
    for (let i = from - 1; i >= 0; i--) {
      if (text[i] === ')') depth++
      else if (text[i] === '(') { if (depth === 0) { open = i; break } depth-- }
    }
    if (open < 0) return text
    let d = 0
    let close = text.length
    for (let j = open; j < text.length; j++) {
      if (text[j] === '(') d++
      else if (text[j] === ')' && --d === 0) { close = j; break }
    }
    const inner = text.slice(open + 1, close)
    if (/^\s*select\b/i.test(inner)) return inner
    from = open
  }
}

/** Policy expression: every SELECT that reads a profile table carries the gate. */
const policyGated = (body) => tableRefs(body).every(({ index }) => GATE.test(enclosingSelect(body, index)))

/** Function body: calls the gate, or some SELECT reading `profiles` carries both predicate parts. */
const functionGated = (body) => GATE.test(body) || tableRefs(body)
  .filter(({ table }) => table === 'profiles')
  .some(({ index }) => {
    const sel = enclosingSelect(body, index)
    return PREDICATE_ACTIVE.test(sel) && PREDICATE_DELETED.test(sel)
  })

/** Ungated inline policies in a replayed state, minus the allowlist. */
function ungatedPolicies (policies, allow = POLICY_ALLOW) {
  return policies
    .filter((p) => readsProfileTable(p.body) && !policyGated(p.body))
    .map((p) => `${p.table} :: ${p.name}`)
    .filter((k) => !allow[k])
}

const tmpDirs = []
function replayFixture (sqlByFile) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rls-gate-'))
  tmpDirs.push(dir)
  for (const [f, sql] of Object.entries(sqlByFile)) writeFileSync(path.join(dir, f), sql)
  return netPolicyState(dir)
}
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

describe('RLSACTIVE.1 — the detectors fail CLOSED', () => {
  const GATED = '(SELECT private.auth_is_active_staff())'
  it.each([
    ['comma join', 'EXISTS (SELECT 1 FROM locations l, profile_locations pl WHERE pl.profile_id = (SELECT auth.uid()))'],
    ['quoted identifier', 'EXISTS (SELECT 1 FROM public."profiles" p WHERE p.id = (SELECT auth.uid()))'],
    ['quoted schema + table', 'EXISTS (SELECT 1 FROM "public"."profile_organizations" po WHERE po.profile_id = (SELECT auth.uid()))'],
    ['FROM ONLY', 'EXISTS (SELECT 1 FROM ONLY profiles p WHERE p.id = (SELECT auth.uid()))'],
    ['join in parentheses', 'org_id IN (SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()))'],
  ])('flags an ungated %s', (_, expr) => {
    expect(readsProfileTable(expr)).toBe(true)
    expect(policyGated(expr)).toBe(false)
  })

  it('a gate elsewhere in the policy does not count for the subquery that reads the table', () => {
    const expr = `${GATED} OR EXISTS (SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (SELECT auth.uid()))`
    expect(policyGated(expr)).toBe(false)
    const ok = `EXISTS (SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (SELECT auth.uid()) AND ${GATED})`
    expect(policyGated(ok)).toBe(true)
  })

  it('does not mistake columns or helper names for the tables', () => {
    expect(readsProfileTable('pl.profile_id = (SELECT auth.uid()) OR private.auth_can_view_all_profiles()')).toBe(false)
  })

  it('an ALTER POLICY that rewrites a gated policy back to ungated is flagged', () => {
    const state = replayFixture({
      '001.sql': `CREATE POLICY p ON public.t FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (SELECT auth.uid()) AND ${GATED}));`,
      '002.sql': `ALTER POLICY p ON public.t USING (EXISTS (SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (SELECT auth.uid())));`,
    })
    expect(ungatedPolicies(state, {})).toEqual(['public.t :: p'])
  })

  it('a table rename carries the ungated policy to its new name (and an allowlist entry for the old name no longer covers it)', () => {
    const state = replayFixture({
      '001.sql': 'CREATE POLICY p ON public.old_t FOR SELECT USING (EXISTS (SELECT 1 FROM profiles WHERE id = (SELECT auth.uid())));',
      '002.sql': 'ALTER TABLE public.old_t RENAME TO new_t;',
    })
    expect(ungatedPolicies(state, { 'public.old_t :: p': 'stale' })).toEqual(['public.new_t :: p'])
  })

  it('a function "gate" must sit in the SELECT that reads profiles', () => {
    expect(functionGated(`SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND active IS NOT FALSE AND deleted_at IS NULL)`)).toBe(true)
    // predicate text present, but on another table's SELECT
    expect(functionGated(`SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()))
      AND EXISTS (SELECT 1 FROM public.teams WHERE active IS NOT FALSE AND deleted_at IS NULL)`)).toBe(false)
  })
})

describe('RLSACTIVE.1 — inline policies that read a profile table carry the active-staff gate', () => {
  const policies = netPolicyState(MIG_DIR)
  const inline = policies.filter((p) => readsProfileTable(p.body))

  it('finds the policies it is meant to guard (not vacuous)', () => {
    expect(inline.length).toBeGreaterThanOrEqual(54) // 47 gated by mig 626 + 7 allowlisted
    expect(inline.filter((p) => policyGated(p.body)).length).toBeGreaterThanOrEqual(47)
    expect(inline.map((p) => `${p.table} :: ${p.name}`)).toContain('public.invoices_queue :: inbound_invoices_read')
  })

  it('every one is gated in the subquery that reads the table, or allowlisted with a reason', () => {
    expect(ungatedPolicies(policies), 'add AND (SELECT private.auth_is_active_staff()) to the caller-scoped subquery (mig 626 shape), or allowlist it here with a reason').toEqual([])
  })

  it('the allowlist has no stale entries', () => {
    const live = new Set(ungatedPolicies(policies, {}))
    expect(Object.keys(POLICY_ALLOW).filter((k) => !live.has(k))).toEqual([])
  })
})

describe('RLSACTIVE.1 — staff helpers require an active profile', () => {
  const fns = latestFunctions()

  it('every classified function exists in the migrations', () => {
    expect(Object.keys(FUNCTIONS).filter((k) => !fns.has(k))).toEqual([])
  })

  it('a new private.auth_* / role helper, or any function reading a profile table for auth.uid(), must be classified', () => {
    const unclassified = [...fns.entries()]
      .filter(([k, v]) => {
        const [schema, name] = k.split('.')
        const helperName = schema === 'private' && /^(auth_|get_user_role|mobile_can_for|is_owner$|is_master|is_admin)/.test(name)
        const decidesFromProfile = /auth\.uid\(\)/.test(v.body) && readsProfileTable(v.body)
        return helperName || decidesFromProfile
      })
      .map(([k]) => k)
      .filter((k) => !FUNCTIONS[k])
    expect(unclassified, 'classify it in FUNCTIONS (predicate / delegates / member / neutral with a reason)').toEqual([])
  })

  it('a SECURITY DEFINER function in public/private that reads a profile table is gated or classified', () => {
    const bad = [...fns.entries()]
      .filter(([k, v]) => /^(public|private)\./.test(k) && v.definer && readsProfileTable(v.body))
      .filter(([k, v]) => !FUNCTIONS[k] && !functionGated(v.body))
      .map(([k, v]) => `${k} (${v.file})`)
    expect(bad, 'gate it (active IS NOT FALSE AND deleted_at IS NULL on the profiles read, or auth_is_active_staff()) or classify it in FUNCTIONS with a reason').toEqual([])
  })

  it('every `predicate` helper carries the predicate in a SELECT that reads profiles, in its LATEST body', () => {
    const missing = Object.entries(FUNCTIONS)
      .filter(([, c]) => c.class === 'predicate')
      .filter(([k]) => !functionGated(fns.get(k)?.body || ''))
      .map(([k]) => `${k} (${fns.get(k)?.file})`)
    expect(missing).toEqual([])
  })

  it('every `delegates` helper still calls only-gated helpers', () => {
    const bad = []
    for (const [k, c] of Object.entries(FUNCTIONS)) {
      if (c.class !== 'delegates') continue
      const body = fns.get(k)?.body || ''
      for (const to of c.to) {
        if (!body.includes(`${to}(`)) bad.push(`${k} no longer calls ${to}`)
        if (FUNCTIONS[to]?.class !== 'predicate') bad.push(`${k} delegates to ${to}, which is not a predicate helper`)
      }
      if (readsProfileTable(body) && !functionGated(body)) bad.push(`${k} reads a profile table itself without the predicate`)
    }
    expect(bad).toEqual([])
  })

  it('member authority never checks staff activity', () => {
    const body = fns.get('private.auth_contact_id').body
    expect(body).not.toMatch(/active|profiles/i)
  })

  it('the predicate is strictly IS NOT FALSE (a NULL active counts, matching the app) — never `active = true`', () => {
    const strict = Object.entries(FUNCTIONS)
      .filter(([, c]) => c.class === 'predicate')
      .filter(([k]) => /\bactive\s*(=\s*true|is\s+true)\b/i.test(fns.get(k).body))
      .map(([k]) => k)
    expect(strict).toEqual([])
  })
})
