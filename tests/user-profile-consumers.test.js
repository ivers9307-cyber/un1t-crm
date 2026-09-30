// PROFILESPREAD.1 guard. The user object (getCurrentUser, serialised into
// every page) carries only USER_PROFILE_COLUMNS of the person's profile. A
// reader of any OTHER profiles column off it would silently get undefined.
// This fails when src/ or shared/ reads a profiles column that is not in the
// list off an identifier bound to the user object (user, currentUser, me,
// viewer, caller, actor, sessionUser, authUser), or spreads the user object.
// A floor, not a proof: a read through another name, or a whole-object
// hand-off to a parameter named differently, is invisible to it (the plan's
// census followed those by hand). Add a column to the list on purpose, with
// its reader, in src/lib/user-profile.js.
//
// Two more halves of the same object (the location rows, PROFILESPREAD.1a F6):
// the user object's locations carry no `settings`, so nothing in src/,
// shared/ or mobile/ may read `settings` off `activeLocation` or
// `user.locations`, and the pure Glofox-presence helpers (which need
// `settings`) are called only by the registry and the by-id reader
// (src/lib/automations/glofox-status.js), never by a page on the user object.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { collectSchema } from '../scripts/check-select-columns.mjs'
import { USER_PROFILE_COLUMNS, AUTH_USER_FIELDS } from '../src/lib/user-profile.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const PROFILE_COLUMNS = [...collectSchema(path.join(ROOT, 'supabase/migrations')).schema.get('profiles')]
const DROPPED = PROFILE_COLUMNS.filter((c) => !USER_PROFILE_COLUMNS.includes(c))
const USER_IDENT = '(?:user|currentUser|me|viewer|caller|actor|sessionUser|authUser)'

const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|tsx?)$/.test(name) && !/\.test\.(m?js|jsx|tsx?)$|\.test-helpers\.js$/.test(name)) out.push(full)
  }
  return out
}

function droppedReads(text, dropped = DROPPED) {
  if (dropped.length === 0) return []
  const cols = dropped.join('|')
  // `user.col`, `user?.col`, `user['col']`, `user?.["col"]`, `` user[`col`] ``
  const re = new RegExp(
    `\\b${USER_IDENT}(?:\\??\\.(${cols})\\b|(?:\\?\\.)?\\[\\s*(['"\`])(${cols})\\2\\s*\\])`,
    'g',
  )
  return [...text.matchAll(re)].map((m) => m[1] || m[3])
}

// The plan's F6 census regex, verbatim.
const LOCATION_SETTINGS_READ = /(activeLocation|user\??\.locations(\[[^\]]*\])?)\??\.settings\b/g

function locationSettingsReads(text) {
  return [...text.matchAll(LOCATION_SETTINGS_READ)].map((m) => m[0])
}

const GLOFOX_PRESENCE_CALL = /\b(glofoxConnected|automationStatus)\(/g
const GLOFOX_PRESENCE_CALLERS = ['src/lib/automations/registry.js', 'src/lib/automations/glofox-status.js']

function glofoxPresenceCalls(text) {
  return [...text.matchAll(GLOFOX_PRESENCE_CALL)].map((m) => m[1])
}

function userSpreads(text) {
  return [...text.matchAll(new RegExp(`\\.\\.\\.${USER_IDENT}\\b(?!\\.)`, 'g'))].length
}

describe('no reader takes a dropped profile column off the user object (PROFILESPREAD.1)', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'shared'))]

  it('the dropped set is real (not vacuous)', () => {
    expect(DROPPED).toEqual(expect.arrayContaining(['pin_hash', 'annual_salary', 'hourly_rate', 'unifi_user_id', 'deleted_at']))
  })

  it('no file reads one', () => {
    const hits = []
    for (const f of files) for (const c of droppedReads(readFileSync(f, 'utf8'))) hits.push(`${path.relative(ROOT, f)}: .${c}`)
    expect(hits, 'add the column to USER_PROFILE_COLUMNS (with its reader), or read it fresh by id').toEqual([])
  })

  it('no file spreads the user object into another object', () => {
    const hits = files.filter((f) => userSpreads(readFileSync(f, 'utf8')) > 0).map((f) => path.relative(ROOT, f))
    expect(hits).toEqual([])
  })

  it('the matcher sees the forms it must', () => {
    expect(droppedReads('if (user.pin_hash) x()', ['pin_hash'])).toEqual(['pin_hash'])
    expect(droppedReads('const r = currentUser?.hourly_rate', ['hourly_rate'])).toEqual(['hourly_rate'])
    expect(droppedReads("if (user?.['pin_hash']) x()", ['pin_hash'])).toEqual(['pin_hash'])
    expect(droppedReads('const r = user["hourly_rate"]', ['hourly_rate'])).toEqual(['hourly_rate'])
    expect(droppedReads('const r = me[ `pin_hash` ]', ['pin_hash'])).toEqual(['pin_hash'])
    expect(droppedReads("user['pin_hash_x']", ['pin_hash'])).toEqual([])
    expect(droppedReads("user['pin_hash\"]", ['pin_hash'])).toEqual([])
    expect(droppedReads('user[key]', ['pin_hash'])).toEqual([])
    expect(droppedReads('row.pin_hash', ['pin_hash'])).toEqual([])
    expect(droppedReads('user.pin_hash_x', ['pin_hash'])).toEqual([])
    expect(userSpreads('const o = { ...user, x: 1 }')).toBe(1)
    expect(userSpreads('const o = { ...user.activeLocation }')).toBe(0)
  })
})

describe('the user object\'s locations carry no settings, and nothing reads them there (PROFILESPREAD.1a)', () => {
  const files = ['src', 'shared', 'mobile'].flatMap((d) => walk(path.join(ROOT, d)))

  it('walks all three trees (not vacuous)', () => {
    for (const d of ['src/', 'shared/', 'mobile/']) {
      expect(files.some((f) => path.relative(ROOT, f).startsWith(d)), d).toBe(true)
    }
  })

  it('no file reads settings off activeLocation or user.locations', () => {
    const hits = []
    for (const f of files) for (const h of locationSettingsReads(readFileSync(f, 'utf8'))) hits.push(`${path.relative(ROOT, f)}: ${h}`)
    expect(hits, 'read the location row fresh by id (readGlofoxAutomationStatus is the pattern)').toEqual([])
  })

  it('glofoxConnected( and automationStatus( are called only by the registry and the by-id reader', () => {
    const hits = []
    for (const f of files) {
      const rel = path.relative(ROOT, f)
      if (GLOFOX_PRESENCE_CALLERS.includes(rel)) continue
      for (const c of glofoxPresenceCalls(readFileSync(f, 'utf8'))) hits.push(`${rel}: ${c}(`)
    }
    expect(hits, 'call readGlofoxAutomationStatus(db, locationId) instead').toEqual([])
  })

  it('the allowed callers exist and still call them (not vacuous)', () => {
    for (const rel of GLOFOX_PRESENCE_CALLERS) {
      expect(glofoxPresenceCalls(readFileSync(path.join(ROOT, rel), 'utf8')).length, rel).toBeGreaterThan(0)
    }
  })

  it('the matchers see the forms they must', () => {
    expect(locationSettingsReads('const g = user.activeLocation.settings.glofox')).toEqual(['activeLocation.settings'])
    expect(locationSettingsReads('const g = activeLocation?.settings')).toEqual(['activeLocation?.settings'])
    expect(locationSettingsReads('user.locations[0].settings')).toEqual(['user.locations[0].settings'])
    expect(locationSettingsReads('user?.locations[i]?.settings')).toEqual(['user?.locations[i]?.settings'])
    expect(locationSettingsReads('row.settings')).toEqual([])
    expect(locationSettingsReads('activeLocation.settingsVersion')).toEqual([])
    expect(glofoxPresenceCalls('glofoxConnected(location) && automationStatus(k, l)')).toEqual(['glofoxConnected', 'automationStatus'])
    expect(glofoxPresenceCalls('import { glofoxConnected } from "x"')).toEqual([])
  })
})

// AUTHUSERPICK.1 — `user.user` is { id, email } (AUTH_USER_FIELDS). A read of
// any other auth-user field off it would silently get undefined, and a whole
// hand-off of it would let a reader elsewhere do the same. The census for
// this was 0 reads (plan C58 §2).
const AUTH_USER_ALLOWED = new Set(AUTH_USER_FIELDS)

function authUserReads(text) {
  const re = new RegExp(
    `\\b${USER_IDENT}\\??\\.user\\b(?:\\??\\.(\\w+)|(?:\\?\\.)?\\[\\s*(['"\`])(\\w+)\\2\\s*\\])?`,
    'g',
  )
  const out = []
  for (const m of text.matchAll(re)) {
    const field = m[1] || m[3] || null
    if (field === null) out.push('(whole)')
    else if (!AUTH_USER_ALLOWED.has(field)) out.push(field)
  }
  return out
}

describe('only id/email are read off user.user (AUTHUSERPICK.1)', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]

  it('no file reads another auth-user field, or hands user.user on whole', () => {
    const hits = []
    for (const f of files) for (const r of authUserReads(readFileSync(f, 'utf8'))) hits.push(`${path.relative(ROOT, f)}: .user.${r}`)
    expect(hits, 'user.user is { id, email } (src/lib/user-profile.js AUTH_USER_FIELDS): read the field another way, or add it on purpose').toEqual([])
  })

  it('the matcher sees each form', () => {
    expect(authUserReads('user.user.email')).toEqual([])
    expect(authUserReads('currentUser?.user?.id')).toEqual([])
    expect(authUserReads('user.user.app_metadata.provider')).toEqual(['app_metadata'])
    expect(authUserReads('me.user?.identities')).toEqual(['identities'])
    expect(authUserReads(`viewer.user['phone']`)).toEqual(['phone'])
    expect(authUserReads('send(user.user)')).toEqual(['(whole)'])
    expect(authUserReads('const x = { ...user.user }')).toEqual(['(whole)'])
    // not the auth user: other objects' `.user`, and user_id-style names
    expect(authUserReads('data.user.email')).toEqual([])
    expect(authUserReads('session?.user?.id')).toEqual([])
    expect(authUserReads('user.user_id')).toEqual([])
    expect(authUserReads('row.user_metadata')).toEqual([])
  })
})
