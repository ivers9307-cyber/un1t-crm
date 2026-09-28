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

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { collectSchema } from '../scripts/check-select-columns.mjs'
import { USER_PROFILE_COLUMNS } from '../src/lib/user-profile.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const PROFILE_COLUMNS = [...collectSchema(path.join(ROOT, 'supabase/migrations')).schema.get('profiles')]
const DROPPED = PROFILE_COLUMNS.filter((c) => !USER_PROFILE_COLUMNS.includes(c))
const USER_IDENT = '(?:user|currentUser|me|viewer|caller|actor|sessionUser|authUser)'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx)$/.test(name) && !/\.test\.(m?js|jsx)$|\.test-helpers\.js$/.test(name)) out.push(full)
  }
  return out
}

function droppedReads(text, dropped = DROPPED) {
  if (dropped.length === 0) return []
  const re = new RegExp(`\\b${USER_IDENT}\\??\\.(${dropped.join('|')})\\b`, 'g')
  return [...text.matchAll(re)].map((m) => m[1])
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
    expect(droppedReads('row.pin_hash', ['pin_hash'])).toEqual([])
    expect(droppedReads('user.pin_hash_x', ['pin_hash'])).toEqual([])
    expect(userSpreads('const o = { ...user, x: 1 }')).toBe(1)
    expect(userSpreads('const o = { ...user.activeLocation }')).toBe(0)
  })
})
