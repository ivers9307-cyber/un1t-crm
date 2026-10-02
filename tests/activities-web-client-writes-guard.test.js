// C148 ACTWRITEGATEWEB.1 — no web browser code writes `activities`.
//
// A browser-client write is judged by RLS, and the activities write policies
// (mig 691) judge the PHONE Tasks or Pipeline key, so a person with the web
// Tasks key (`activities`) but neither phone key had their task saves
// refused. Web task writes go through service-role routes that judge the WEB
// rule at the task's studio (POST /api/activities/tasks and
// /api/activities/tasks/[id]/status; canWriteActivitiesAt). This pins that no
// client file under src/ (tests/helpers/js-code.js isClientFile) chains a
// write onto .from('activities'), read with codeOf (comments, JSX text and
// regex bodies blanked, never a regex comment-strip). A floor, not a proof: a
// table name in a variable, or a chain split across statements, is invisible.
// mobile/ is out of scope (the phone keeps its own keys, and RLS is its rule).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { codeOf, isClientFile } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx|ts|tsx)$/.test(name) && !/\.test\.(js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
const ACTIVITIES_WRITE = /\.from\(\s*['"`]activities['"`]\s*\)[\s\S]{0,300}?\.(update|insert|upsert|delete)\(/

describe('no web client code writes activities (C148)', () => {
  it('the detector sees the old shapes', () => {
    expect(ACTIVITIES_WRITE.test("await db.from('activities').insert(insert).select('*').single()")).toBe(true)
    expect(ACTIVITIES_WRITE.test("const res = await db.from('activities')\n  .update({ status: newStatus })\n  .eq('id', taskId)")).toBe(true)
    expect(ACTIVITIES_WRITE.test('await db.from("activities").delete().eq("id", id)')).toBe(true)
    expect(ACTIVITIES_WRITE.test("await db.from('activities').select('id').eq('id', id)")).toBe(false)
  })

  it('a write named only in a comment is not code', () => {
    const src = "'use client'\n// was: db.from('activities').insert({ subject })\nexport default function X() { return null }\n"
    expect(isClientFile(src)).toBe(true)
    expect(ACTIVITIES_WRITE.test(codeOf(src, 'x.jsx'))).toBe(false)
  })

  it('finds none under src/', () => {
    const offenders = walk(path.join(ROOT, 'src'))
      .filter((f) => { const s = readFileSync(f, 'utf8'); return isClientFile(s) && ACTIVITIES_WRITE.test(codeOf(s, f)) })
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })
})
