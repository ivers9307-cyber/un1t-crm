// MOBILECANTEMPLATES.1 — static guard for mig 691.
//
// Phone-direct RLS (activities, bookings, deals, notes, whatsapp_*) asks
// private.mobile_can_location_ids_for which studios hold a PHONE key. The
// SQL cannot import shared/permissions.js, so these are pinned here:
//   (a) every key a policy asks about is a phone key the location layer gates
//       (not a notify / approval / cross-platform key, whose JS tiers differ);
//   (b) the LATEST migration that seeds private.mobile_permission_defaults
//       replaces it in full and equals DEFAULT_MOBILE_PERMISSIONS_BY_ROLE for
//       every such key and every membership role (absent row = false in SQL);
//   (c) no later policy goes back to the per-row form (auth_mobile_can(…) /
//       mobile_can_for(…), ~0.35 ms a row) and every call of the wrapper is a
//       (SELECT …)::uuid[] sub-select (an InitPlan, once per statement);
//   (d) the latest core still reads the template, defaults and bundle tables
//       and the active-staff predicate (a floor; the replay's parity matrix is
//       the proof).
// A floor, not a proof: a policy built by EXECUTE format(…) or made by hand
// on prod is invisible here.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'
import { sqlCode } from './helpers/sql-code.js'
import {
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, MOBILE_PERMISSION_KEYS, CROSS_PLATFORM_KEYS, isFeatureGatedByLocation,
} from '../shared/permissions.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
export const MOBILE_CAN_TEMPLATES_MIGRATION = 691
// profile_locations_role_check: the roles a membership can hold (never master).
export const MEMBERSHIP_ROLES = ['owner', 'manager', 'head_coach', 'staff', 'reception']
const migNum = (f) => Number.parseInt(f, 10)
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .sort((a, b) => migNum(a) - migNum(b) || a.localeCompare(b))
const read = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')
const netPolicies = () => netPolicyState(MIGRATIONS)
const exprOf = (p) => `${p.using ?? ''} ${p.check ?? ''}`

/** The phone keys policy expressions ask about (wrapper or per-row form). */
export function rlsMobileKeys(exprs) {
  const keys = new Set()
  for (const e of exprs) {
    for (const m of e.matchAll(/\bauth_mobile_can_location_ids\s*\(\s*'(\w+)'/g)) keys.add(m[1])
    for (const m of e.matchAll(/\bauth_mobile_can\s*\(\s*\w+\s*,\s*'(\w+)'/g)) keys.add(m[1])
  }
  return [...keys].sort()
}

/** Per-row calls, and wrapper calls that are not a (SELECT …) sub-select. */
export function perRowCalls(expr) {
  const hits = [...expr.matchAll(/\b(?:auth_mobile_can|mobile_can_for)\s*\(/g)].map((m) => m[0])
  const wrapper = (expr.match(/\bauth_mobile_can_location_ids\s*\(/g) || []).length
  const wrapped = (expr.match(/\(\s*select\s+(?:private\s*\.\s*)?auth_mobile_can_location_ids\s*\(/gi) || []).length
  if (wrapper !== wrapped) hits.push(`${wrapper - wrapped} unwrapped auth_mobile_can_location_ids call(s)`)
  return hits
}

/** The latest migration that seeds the defaults: its rows, and whether it deletes first. */
export function latestDefaultsSeed(files = migrationFiles()) {
  const SEED = /insert\s+into\s+private\s*\.\s*mobile_permission_defaults\b/i
  const file = files.filter((f) => SEED.test(sqlCode(read(f)))).at(-1)
  const code = sqlCode(read(file))
  const at = code.search(SEED)
  const values = code.slice(at).match(/values([\s\S]*?)(?:\bon\s+conflict\b|;)/i)[1]
  const rows = [...values.matchAll(/\(\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*(true|false)\s*\)/gi)]
    .map((m) => ({ role: m[1], key: m[2], allowed: m[3].toLowerCase() === 'true' }))
  const replaces = /\bdelete\s+from\s+private\s*\.\s*mobile_permission_defaults\s*;/i.test(code.slice(0, at))
  return { file, rows, replaces }
}

describe('(a) the keys phone-direct RLS asks about', () => {
  const keys = rlsMobileKeys(netPolicies().map(exprOf))

  it('finds them (not vacuous)', () => {
    expect(keys).toEqual(['bookings', 'pipeline', 'tasks', 'whatsapp'])
  })

  it('each is a phone key the location layer gates, not a cross-platform one', () => {
    for (const k of keys) {
      expect(MOBILE_PERMISSION_KEYS, k).toContain(k)
      expect(isFeatureGatedByLocation(k), k).toBe(true)
      expect(CROSS_PLATFORM_KEYS, k).not.toContain(k)
    }
  })
})

describe('(b) private.mobile_permission_defaults = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE', () => {
  it('membership roles are the JS roles minus master (a new role must get rows)', () => {
    expect([...MEMBERSHIP_ROLES].sort()).toEqual(Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE).filter((r) => r !== 'master').sort())
  })

  it('the latest seed replaces the table in full and equals the JS map for every RLS key x membership role', () => {
    const { file, rows, replaces } = latestDefaultsSeed()
    expect(migNum(file)).toBeGreaterThanOrEqual(MOBILE_CAN_TEMPLATES_MIGRATION)
    expect(replaces, `${file}: DELETE FROM private.mobile_permission_defaults before the INSERT`).toBe(true)
    const keys = rlsMobileKeys(netPolicies().map(exprOf))
    const want = MEMBERSHIP_ROLES.flatMap((role) => keys.map((key) => ({ role, key, allowed: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[role][key] === true })))
    const sort = (a) => [...a].sort((x, y) => `${x.role}.${x.key}`.localeCompare(`${y.role}.${y.key}`))
    expect(sort(rows), 'DEFAULT_MOBILE_PERMISSIONS_BY_ROLE changed for an RLS key: reseed the table in a new migration').toEqual(sort(want))
  })
})

describe('(c) no policy goes back to the per-row form', () => {
  it('the net policy state has none', () => {
    const offenders = netPolicies().filter((p) => perRowCalls(exprOf(p)).length)
      .map((p) => `${p.table}.${p.name} (${p.file}): ${perRowCalls(exprOf(p)).join(', ')}`)
    expect(offenders).toEqual([])
  })

  // Mig 701 (C138 e) dropped bookings_insert / bookings_update: no client writes
  // bookings, the phone only reads (bookings_select stays).
  it('the 13 phone-gated policies all use the wrapper (not vacuous)', () => {
    const users = netPolicies().filter((p) => /\bauth_mobile_can_location_ids\s*\(/.test(exprOf(p)))
    expect(users.map((p) => `${p.table}.${p.name}`).sort()).toEqual([
      'public.activities.activities_insert', 'public.activities.activities_select', 'public.activities.activities_update',
      'public.bookings.bookings_select',
      'public.deals.deals_insert', 'public.deals.deals_select', 'public.deals.deals_update',
      'public.notes.notes_insert', 'public.notes.notes_select', 'public.notes.notes_update',
      'public.whatsapp_conversations.wa_conv_select', 'public.whatsapp_messages.wa_msg_select', 'public.whatsapp_templates.wa_tmpl_select',
    ])
  })

  it('the detector catches the shapes', () => {
    expect(perRowCalls("private.auth_mobile_can(location_id, 'tasks')")).toHaveLength(1)
    expect(perRowCalls("private.mobile_can_for(auth.uid(), location_id, 'tasks')")).toHaveLength(1)
    expect(perRowCalls("location_id = ANY (private.auth_mobile_can_location_ids('tasks'))")).toHaveLength(1)
    expect(perRowCalls("location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])")).toEqual([])
    expect(perRowCalls("location_id = ANY ((select auth_mobile_can_location_ids('tasks'))::uuid[])")).toEqual([])
  })
})

describe('(d) the latest core keeps its tiers (floor)', () => {
  it('reads templates (both rows), the defaults, the bundles and the active-staff predicate', () => {
    const def = /create\s+(?:or\s+replace\s+)?function\s+private\s*\.\s*mobile_can_location_ids_for\s*\(/i
    const file = migrationFiles().filter((f) => def.test(sqlCode(read(f)))).at(-1)
    expect(file, 'the core is missing').toBeTruthy()
    const code = sqlCode(read(file))
    const body = code.slice(code.search(def)).match(/\$function\$([\s\S]*?)\$function\$/)[1]
    expect((body.match(/location_role_permissions/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(body).toMatch(/employment_type\s*=\s*'all'/)
    expect(body).toMatch(/employment_type\s*=\s*p\.employment_type/)
    expect(body).toMatch(/mobile_permission_defaults/)
    expect(body).toMatch(/permission_key_bundles/)
    expect(body).toMatch(/active\s+is\s+not\s+false/i)
    expect(body).toMatch(/deleted_at\s+is\s+null/i)
    expect(body).toMatch(/jsonb_typeof/)
  })
})
