// RLSACTIVE.1 — static gate: staff authority at the RLS layer must require an
// ACTIVE, non-tombstoned profile, and must keep requiring it.
//
// Mig 626 made every staff helper and every inline policy that reads
// profiles / profile_locations / profile_organizations check
// `active IS NOT FALSE AND deleted_at IS NULL` (directly, or through
// private.auth_is_active_staff()). This file replays supabase/migrations —
// the policy replay is the SAME parser check:rls-restrictive uses
// (netPolicyState) — and fails when a FUTURE migration:
//   * creates or re-creates a policy that reads a profile table inline
//     without `auth_is_active_staff`, or
//   * adds or redefines a private.auth_* / role helper (or any function that
//     reads a profile table for auth.uid()) without the predicate, without
//     delegating to a gated helper, or without being classified here.
// A new function or policy that is genuinely NOT staff authority goes in the
// allowlists below WITH a reason — never a blanket skip.
//
// Floor, not proof: a policy or function created by hand on prod, or inside
// a dynamic EXECUTE, is invisible here. Mig 626's own self-check covers the
// live catalog at apply time.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const GATE = /auth_is_active_staff/
const PROFILE_TABLE = /\b(?:from|join)\s+\(*\s*(?:public\.)?(profiles|profile_locations|profile_organizations)\b/i
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
  'private.guard_at_least_one_master': { class: 'neutral', reason: 'trigger (mig 080); counts active masters itself.' },
  'private.refuse_tombstone_access_row': { class: 'neutral', reason: 'trigger (mig 622); refuses access rows for a tombstone.' },
}

const files = () => readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))

/** schema.name → { file, body } for the LAST definition, following ALTER FUNCTION … SET SCHEMA. */
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
      fns.set(key, { file: f, body: rest.slice(start, close) })
    }
  }
  return fns
}

const readsProfileTable = (body) => PROFILE_TABLE.test(body)
const hasPredicate = (body) => PREDICATE_ACTIVE.test(body) && PREDICATE_DELETED.test(body)

describe('RLSACTIVE.1 — inline policies that read a profile table carry the active-staff gate', () => {
  const policies = netPolicyState(MIG_DIR)
  const inline = policies.filter((p) => readsProfileTable(p.body))

  it('finds the policies it is meant to guard (not vacuous)', () => {
    expect(inline.length).toBeGreaterThanOrEqual(54) // 47 gated by mig 626 + 7 allowlisted
    expect(inline.filter((p) => GATE.test(p.body)).length).toBeGreaterThanOrEqual(47)
  })

  it('every one is gated or allowlisted with a reason', () => {
    const ungated = inline
      .filter((p) => !GATE.test(p.body))
      .map((p) => `${p.table} :: ${p.name}`)
      .filter((k) => !POLICY_ALLOW[k])
    expect(ungated, 'add AND (SELECT private.auth_is_active_staff()) to the caller-scoped subquery (mig 626 shape), or allowlist it here with a reason').toEqual([])
  })

  it('the allowlist has no stale entries', () => {
    const live = new Set(inline.filter((p) => !GATE.test(p.body)).map((p) => `${p.table} :: ${p.name}`))
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

  it('every `predicate` helper carries `active IS NOT FALSE` and `deleted_at IS NULL` in its LATEST body', () => {
    const missing = Object.entries(FUNCTIONS)
      .filter(([, c]) => c.class === 'predicate')
      .filter(([k]) => !hasPredicate(fns.get(k)?.body || ''))
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
      if (readsProfileTable(body) && !hasPredicate(body)) bad.push(`${k} reads a profile table itself without the predicate`)
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
