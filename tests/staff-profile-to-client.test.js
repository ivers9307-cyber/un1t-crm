// STAFFPROFILEPICK.1 guard. A `profiles` row read with `*` carries pin_hash
// (a short PIN's hash: offline-guessable), pin_* bookkeeping, unifi_user_id,
// pay, signatures and tombstone/auth bookkeeping. Every such read in src/,
// shared/ and mobile/ is on the exact list below, with what happens to the
// rows. A new one, a changed count, or a stale entry fails. The list can
// only shrink by deletion (the SECFIX.3a posture,
// tests/location-secrets-to-client.test.js).
//
//   server-only  the rows never leave the server (reason given)
//   count-only   a head:true count; no row is returned at all
//
// Two more locks on the same class:
//   * the named lists (src/lib/staff-fields.js) exist on profiles /
//     profile_locations and hold no PIN, secret, UniFi-id, tombstone or
//     auth column;
//   * STAFF_EDITOR_FIELDS is EXACTLY what StaffForm reads off its `staff`
//     prop (minus the page-computed is_master and assignments). A field the
//     page does not send renders as a default and is SAVED BACK over the real
//     value: the history the editor page's CRITICAL comment records for
//     profile_locations, one table over.
//
// A floor, not a proof: a select string built at runtime, a table name in a
// variable, or a row handed on under another name is invisible here.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { collectSchema } from '../scripts/check-select-columns.mjs'
import { isSecretKeyName } from '../src/lib/secret-keys.js'
import {
  STAFF_MANAGED_FIELDS, STAFF_MANAGED_LINK_FIELDS, STAFF_EDITOR_FIELDS,
} from '../src/lib/staff-fields.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCHEMA = collectSchema(path.join(ROOT, 'supabase/migrations')).schema

export const PROFILE_STAR_READS = {
  'src/app/api/staff/[id]/route.js': { count: 2, disposition: 'server-only', why: 'PUT targetBefore feeds the UniFi revoke/sync and the edit gate; refreshed feeds the role recompute and the legacy door flag. The response re-reads STAFF_MANAGED_SELECT.' },
  'src/lib/assignment-changes.js': { count: 2, disposition: 'count-only', why: 'countActiveMasters / wouldLeaveZeroMasters: select(\'*\', { count, head: true })' },
}

const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx)$/.test(name) && !/\.test\.(m?js|jsx)$|\.test-helpers\.js$/.test(name)) out.push(full)
  }
  return out
}

export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const PATTERNS = [
  // from('profiles')….select('*') / select('*, …'), not crossing into another from(
  /from\(\s*['"`]profiles['"`]\s*\)(?:(?!\bfrom\()[^;]){0,300}?\.select\(\s*['"`]\s*\*\s*[,'"`]/g,
  // from('profiles')….update(…).select() — PostgREST returns every column
  /from\(\s*['"`]profiles['"`]\s*\)(?:(?!\bfrom\()[^;]){0,300}?\.select\(\s*\)/g,
  // a star-with-links select string kept in a const ('*, profile_locations(…')
  /(?<!\.select\(\s*)['"`]\s*\*\s*,\s*profile_locations\s*\(/g,
  // an embed of the whole profile: profiles(*), x:profiles!fk(*), profile_id(*)
  /\bprofiles(?:!\w+)?\s*\(\s*\*\s*[,)]/g,
  /\b(?:profile_id|user_id|staff_id|assigned_to|created_by|actor_id)(?:!\w+)?\s*\(\s*\*\s*[,)]/g,
]

export function countProfileStarReads(text) {
  const code = stripComments(text)
  return PATTERNS.reduce((n, p) => n + [...code.matchAll(p)].length, 0)
}

const STAFF_PROP_READ = /\bstaff\??\.([A-Za-z_]\w*)/g
const PAGE_COMPUTED = new Set(['is_master', 'assignments'])

export function staffPropReads(text) {
  const code = stripComments(text)
  return [...new Set([...code.matchAll(STAFF_PROP_READ)].map((m) => m[1]))].filter((k) => !PAGE_COMPUTED.has(k)).sort()
}

const STAFF_WHOLE_USE = /=\s*staff\b(?!\s*[.?])|\{\s*\.\.\.staff\b|=\{\s*staff\s*\}|\bstaff\s*\[|[(,][ \t]*staff[ \t]*[,)]/

const NEVER = /^(pin_|unifi_user_id$|unifi_synced_at$|protect_face_id$|deleted_|auth_|two_factor|home_screen_path$|email_signature)/

describe('every star-read of profiles is reviewed (STAFFPROFILEPICK.1)', () => {
  const found = {}
  for (const file of ['src', 'shared', 'mobile'].flatMap((d) => walk(path.join(ROOT, d)))) {
    const n = countProfileStarReads(readFileSync(file, 'utf8'))
    if (n) found[path.relative(ROOT, file)] = n
  }

  it('the files and counts are exactly the reviewed list', () => {
    const listed = Object.fromEntries(Object.entries(PROFILE_STAR_READS).map(([f, e]) => [f, e.count]))
    expect(found, 'a new or changed star-read of profiles: name the columns (src/lib/staff-fields.js), or add it here with why it never leaves the server').toEqual(listed)
  })

  it('every entry has a known disposition and says why', () => {
    for (const [file, e] of Object.entries(PROFILE_STAR_READS)) {
      expect(['server-only', 'count-only'], file).toContain(e.disposition)
      expect(e.why, file).toBeTruthy()
    }
  })

  it('the counter sees each form, and not the named ones', () => {
    expect(countProfileStarReads(`db.from('profiles').select('*').eq('id', x)`)).toBe(1)
    expect(countProfileStarReads(`db\n  .from('profiles')\n  .select('*, profile_locations(*)')`)).toBe(1)
    expect(countProfileStarReads(`db.from('profiles').update(p).eq('id', x).select().single()`)).toBe(1)
    expect(countProfileStarReads(`const FULL = '*, profile_locations(*, locations(*))'`)).toBe(1)
    expect(countProfileStarReads(`select('id, owner:profiles!owner_id(*)')`)).toBe(1)
    expect(countProfileStarReads(`select('id, profile_id(*)')`)).toBe(1)
    expect(countProfileStarReads(`db.from('profiles').select('id, full_name')`)).toBe(0)
    expect(countProfileStarReads(`db.from('profiles').select(STAFF_MANAGED_SELECT)`)).toBe(0)
    expect(countProfileStarReads(`db.from('profiles').update(p).eq('id', x).select('id, role')`)).toBe(0)
    expect(countProfileStarReads(`excludeTombstones(db.from('profiles').select('id')), db.from('locations').select('*')`)).toBe(0)
    expect(countProfileStarReads(`// the '*, profile_locations(*)' select below`)).toBe(0)
    expect(countProfileStarReads('`${a}, profile_locations(*)`')).toBe(0)
  })
})

describe('the named lists (STAFFPROFILEPICK.1)', () => {
  it('every name exists on profiles / profile_locations', () => {
    for (const c of [...STAFF_MANAGED_FIELDS, ...STAFF_EDITOR_FIELDS]) expect([c, SCHEMA.get('profiles').has(c)]).toEqual([c, true])
    for (const c of STAFF_MANAGED_LINK_FIELDS) expect([c, SCHEMA.get('profile_locations').has(c)]).toEqual([c, true])
  })

  it('none is a PIN, secret, UniFi-id, tombstone, auth or signature column', () => {
    for (const c of [...STAFF_MANAGED_FIELDS, ...STAFF_MANAGED_LINK_FIELDS, ...STAFF_EDITOR_FIELDS]) {
      expect([c, NEVER.test(c) || isSecretKeyName(c)]).toEqual([c, false])
    }
    // not vacuous: the rule really catches the columns this row is about
    for (const c of ['pin_hash', 'pin_set_at', 'unifi_user_id', 'deleted_at', 'auth_disposition']) {
      expect([c, NEVER.test(c) || isSecretKeyName(c)]).toEqual([c, true])
    }
  })
})

describe('STAFF_EDITOR_FIELDS is exactly what StaffForm reads off `staff` (D5)', () => {
  const reads = staffPropReads(readFileSync(path.join(ROOT, 'src/components/StaffForm.jsx'), 'utf8'))

  it('not vacuous: the census finds the form\'s reads', () => {
    expect(reads).toEqual(expect.arrayContaining(['id', 'full_name', 'annual_salary', 'contracted_hours_per_week']))
  })

  it('the two sets are equal', () => {
    expect(reads, 'add the field to STAFF_EDITOR_FIELDS (src/lib/staff-fields.js), or stop reading it').toEqual([...STAFF_EDITOR_FIELDS].sort())
  })

  it('the form never hands `staff` on whole (a spread, a pass-through, an index)', () => {
    // The census reads `staff.x` / `staff?.x`; a row passed on whole would be
    // read by a component this test never opens, so it is refused outright.
    const code = stripComments(readFileSync(path.join(ROOT, 'src/components/StaffForm.jsx'), 'utf8'))
    expect(code.match(STAFF_WHOLE_USE), 'read fields off `staff` by name, so the census sees them').toBeNull()
    for (const bad of ['const s = staff', '{ ...staff }', '<Child row={staff} />', 'staff[key]', 'describe(staff)', 'f(a, staff, b)']) {
      expect([bad, STAFF_WHOLE_USE.test(bad)]).toEqual([bad, true])
    }
    for (const ok of ['staff,', 'onSaved,\n  staff,\n  locations,', 'const isEdit = !!staff', 'staff.id', 'staff?.full_name', "defaultPermsForRole('staff')", 'staffId']) {
      expect([ok, STAFF_WHOLE_USE.test(ok)]).toEqual([ok, false])
    }
  })

  it('the census reader sees the forms it must', () => {
    expect(staffPropReads('const a = staff?.annual_salary; const b = staff.id; staff?.is_master; staff?.assignments')).toEqual(['annual_salary', 'id'])
    expect(staffPropReads('// staff.pin_hash in a comment')).toEqual([])
    expect(staffPropReads('staffId.x; mystaff.y')).toEqual([])
  })
})
