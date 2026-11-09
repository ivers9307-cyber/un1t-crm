// HOSTPORTAL.4 — every column list handed to loadHostEvent() exists on race_events.
//
// loadHostEvent(db, hostId, eventId, columns) in src/lib/host-portal.js takes
// its column list as an ARGUMENT, so `npm run check:select-columns` (which only
// reads strings written inside `.select(…)`) never sees it. A column that does
// not exist makes PostgREST answer 400, the helper logs and returns null, and
// the page answers 404 for every host, while every mocked test stays green.
//
// This reads each non-test call site under src/, resolves its fourth argument
// (a string literal, a `+` concatenation across lines, or a same-file `const`,
// through the check script's own evaluator) and checks it against the schema
// replayed from supabase/migrations by scripts/check-select-columns.mjs:
//   - top-level columns against race_events;
//   - columns inside an embed (`series:event_series ( … )`, `race_waves ( … )`)
//     against the embedded table, found by name or by FK column;
//   - an embed whose table the replay cannot resolve FAILS (it is never skipped).
// A call site whose column list cannot be resolved FAILS, naming the file.
//
// Blind spots (a floor, not proof): a column list built at runtime (a
// parameter, an import, a call) is reported unreadable rather than checked; a
// helper that wraps loadHostEvent and forwards `columns` is checked at its own
// call sites only if they name the helper `loadHostEvent`; a column the
// migrations add by a means the replay does not read (hand-made in the
// dashboard) is reported missing, which is the point: prod must be reproducible
// from the files.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  collectSchema,
  maskComments,
  parseSelect,
  cleanSelectString,
  splitTopLevel,
  splitArgs,
  resolveSelectArg,
  resolveEmbedTarget,
} from '../scripts/check-select-columns.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')
const HELPER_FILE = path.join(SRC, 'lib', 'host-portal.js')
const TABLE = 'race_events'
const { schema, fks } = collectSchema(path.join(ROOT, 'supabase', 'migrations'))

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.jsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** Text between the parens of the call whose `(` is at openIdx (string aware), or null. */
function callArgs(src, openIdx) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i) }
  }
  return null
}

/** Every `loadHostEvent(` call in one source text: [{ line, columns }], columns null when unreadable. */
export function findCalls(source) {
  const masked = maskComments(source)
  const calls = []
  for (const m of masked.matchAll(/(?<![\w$.])loadHostEvent\s*\(/g)) {
    if (/function\s*$/.test(masked.slice(0, m.index))) continue // the definition
    const args = callArgs(masked, m.index + m[0].length - 1)
    const line = masked.slice(0, m.index).split('\n').length
    const fourth = args === null ? undefined : splitArgs(args)[3]
    const columns = fourth ? resolveSelectArg(fourth, masked) : null
    calls.push({ line, columns })
  }
  return calls
}

/** Problems with one column list, as strings; empty when every column exists. */
export function columnProblems(columns) {
  const problems = []
  for (const r of parseSelect(columns, TABLE, schema, fks)) {
    if (!schema.get(r.table)?.has(r.column)) problems.push(`${r.table}.${r.column} does not exist`)
  }
  const unresolved = (list, table) => {
    for (let item of splitTopLevel(cleanSelectString(list))) {
      if (item.startsWith('...')) item = item.slice(3)
      const open = item.indexOf('(')
      if (open === -1) continue
      const head = item.slice(0, open)
      const rel = (head.includes(':') ? head.slice(head.indexOf(':') + 1) : head).split('!')[0]
      const target = resolveEmbedTarget(rel, table, schema, fks)
      if (!target) problems.push(`embed "${rel}" on ${table} names no known table`)
      else unresolved(item.slice(open + 1, item.lastIndexOf(')')), target)
    }
  }
  unresolved(columns, TABLE)
  return problems
}

const sites = walk(SRC)
  .filter((f) => f !== HELPER_FILE)
  .flatMap((f) => {
    const src = fs.readFileSync(f, 'utf8')
    if (!src.includes('loadHostEvent')) return []
    return findCalls(src).map((c) => ({ file: path.relative(ROOT, f), ...c }))
  })

describe('loadHostEvent column lists exist on race_events', () => {
  it('knows race_events, event_series and race_waves from the migrations', () => {
    expect(schema.get(TABLE)?.has('host_id')).toBe(true)
    expect(schema.has('event_series')).toBe(true)
    expect(schema.has('race_waves')).toBe(true)
  })

  it('finds at least six real call sites', () => {
    expect(sites.length).toBeGreaterThanOrEqual(6)
  })

  it('has no aliased import and no namespaced call, either of which would hide a call site from this guard', () => {
    const hidden = walk(SRC)
      .filter((f) => f !== HELPER_FILE)
      .flatMap((f) => {
        const masked = maskComments(fs.readFileSync(f, 'utf8'))
        const found = []
        if (/\bloadHostEvent\s+as\b/.test(masked)) found.push('imports loadHostEvent under another name')
        if (/\.\s*loadHostEvent\s*\(/.test(masked)) found.push('calls loadHostEvent through a namespace')
        return found.map((what) => `${path.relative(ROOT, f)} ${what}`)
      })
    expect(hidden, hidden.join('\n')).toEqual([])
  })

  it('reads every call site column list', () => {
    const unreadable = sites.filter((s) => !s.columns).map((s) => `${s.file}:${s.line}`)
    expect(unreadable, `column list not resolvable at: ${unreadable.join(', ')}`).toEqual([])
  })

  it('names only columns that exist', () => {
    const bad = sites
      .filter((s) => s.columns)
      .flatMap((s) => columnProblems(s.columns).map((p) => `${s.file}:${s.line} — ${p}`))
    expect(bad, bad.join('\n')).toEqual([])
  })
})

describe('the checker proves itself', () => {
  it('the alias and namespace patterns used above match the spellings they are meant to catch', () => {
    expect(/\bloadHostEvent\s+as\b/.test("import { loadHostEvent as load } from '@/lib/host-portal'")).toBe(true)
    expect(/\.\s*loadHostEvent\s*\(/.test('await portal.loadHostEvent(db, h, id, cols)')).toBe(true)
    expect(/\.\s*loadHostEvent\s*\(/.test('await loadHostEvent(db, h, id, cols)')).toBe(false)
  })

  it('reports a made-up top-level column', () => {
    const [call] = findCalls("await loadHostEvent(db, h, id, 'id, host_id, not_a_real_column')")
    expect(columnProblems(call.columns)).toEqual([`${TABLE}.not_a_real_column does not exist`])
  })

  it('reports a made-up column inside an embed', () => {
    const [call] = findCalls(
      "await loadHostEvent(db, h, id, 'id, host_id, series:event_series ( id, not_a_real_column ), race_waves ( start_time )')"
    )
    expect(columnProblems(call.columns)).toEqual(['event_series.not_a_real_column does not exist'])
  })

  it('reports an embed on an unknown table', () => {
    const [call] = findCalls("await loadHostEvent(db, h, id, 'id, no_such_table ( id )')")
    expect(columnProblems(call.columns)).toEqual(['embed "no_such_table" on race_events names no known table'])
  })

  it('resolves a multi-line concatenation and a same-file const, and leaves aliases alone', () => {
    const src = [
      "const COLS = 'id, host_id, series:event_series ( id, name )'",
      'await loadHostEvent(db, h, id, COLS)',
      "await loadHostEvent(db, h, id, 'id, ' +\n  'name')",
    ].join('\n')
    const calls = findCalls(src)
    expect(calls.map((c) => c.columns)).toEqual(['id, host_id, series:event_series ( id, name )', 'id, name'])
    expect(calls.flatMap((c) => columnProblems(c.columns))).toEqual([])
  })

  it('flags an unresolvable list and ignores the definition and comments', () => {
    const src = [
      '// loadHostEvent(db, h, id, "x")',
      'export async function loadHostEvent(db, hostId, eventId, columns) {}',
      'await loadHostEvent(db, h, id, someParam)',
    ].join('\n')
    const calls = findCalls(src)
    expect(calls).toHaveLength(1)
    expect(calls[0].columns).toBeNull()
  })
})
