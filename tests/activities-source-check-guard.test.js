// C150 ACTSOURCECHECK.1 guard. public.activities carries
// activities_source_check (mig 138: source IN ('crm', 'glofox')). The phone's
// task create (mobile/lib/tasks-api.js, source 'manual') and the API-key route
// (src/app/api/tasks/route.js, source 'api') wrote values outside it, so
// Postgres refused every one of those inserts and prod held 0 kind='task'
// rows. Nothing reads 'manual' or 'api' back: the only reader of
// activities.source tells Glofox-synced rows apart (source === 'glofox').
//
// Pinned here: every literal `source` written to activities by non-test code
// in src/, mobile/, shared/ and supabase/functions is in the CHECK list, as
// defined by the LATEST migration that adds activities_source_check (a later
// migration that widens it widens this list; one that drops it without
// re-adding it fails the guard until someone decides). A `source` the scanner
// cannot resolve to literals fails too: make it a literal or teach the guard.
//
// How a write is found: the TypeScript AST of the file's code (codeOf: comments,
// JSX text and regex bodies blanked) for `.from('activities').insert|upsert|
// update(arg)`; arg is followed through an object literal, an array literal,
// a const in the same file, `.push(…)` onto it, `x.source = …`, a `.map(…)`
// callback's returned object and ?:. A floor, not a proof: a builder held in a
// variable, a row built in another file, or a spread of runtime data is not
// seen. SQL is read through sqlCode (one quote- and $tag$-aware pass), never a
// regex comment strip.

import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { codeOf } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const SCAN_DIRS = ['src', 'mobile', 'shared', 'supabase/functions']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'build', '__tests__', '__mocks__'])
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

// ── the CHECK list, from the migrations ──────────────────────────────────

const DEFINE = /\bconstraint\s+"?activities_source_check"?\s+check\s*\(/gi
const DROP = /\bdrop\s+constraint\s+(?:if\s+exists\s+)?"?activities_source_check"?/gi

/** The body of the parenthesis opening at `open` (quote-aware). */
function parenBody(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === "'") {
      i++
      while (i < code.length && !(code[i] === "'" && code[i + 1] !== "'")) i += code[i] === "'" ? 2 : 1
      continue
    }
    if (c === '(') depth++
    if (c === ')' && --depth === 0) return code.slice(open + 1, i)
  }
  throw new Error('unbalanced CHECK (')
}

/** The values a `source IN (…)` / `source = ANY (ARRAY[…])` CHECK allows. */
export function checkValues(body) {
  const shape = /^\s*\(*\s*source\s*\)*\s*(?:in\s*\(|=\s*any\s*\(\s*\(?\s*array\s*\[)/i
  if (!shape.test(body)) throw new Error(`activities_source_check has a shape this guard cannot read: ${body.trim()}`)
  return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'"))
}

/**
 * The CHECK list as the last migration that touches activities_source_check
 * leaves it: { file, values } (values null when that migration drops it).
 *
 * @param {{ name: string, sql: string }[]} migrations  in apply order
 */
export function latestSourceCheck(migrations) {
  let state = null
  for (const { name, sql } of migrations) {
    const code = sqlCode(sql)
    const events = [
      ...[...code.matchAll(DROP)].map((m) => ({ at: m.index, values: null })),
      ...[...code.matchAll(DEFINE)].map((m) => ({ at: m.index, values: checkValues(parenBody(code, m.index + m[0].length - 1)) })),
    ].sort((a, b) => a.at - b.at)
    for (const e of events) state = { file: name, values: e.values }
  }
  return state
}

const migrationOrder = (a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b)

function repoMigrations() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort(migrationOrder)
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name), 'utf8') }))
}

// ── the literal sources written, from the code ───────────────────────────

const WRITES = new Set(['insert', 'upsert', 'update'])
const isString = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
const propName = (n) => (n && (ts.isIdentifier(n) || isString(n)) ? n.text : null)
const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression?.(n))) n = n.expression
  return n
}

function parse(code, file) {
  const kinds = /\.[mc]?ts$/.test(file) ? [ts.ScriptKind.TS] : [ts.ScriptKind.TSX, ts.ScriptKind.JSX]
  let best = null
  for (const kind of kinds) {
    const sf = ts.createSourceFile(kind === ts.ScriptKind.JSX ? 'scan.jsx' : 'scan.tsx', code, ts.ScriptTarget.Latest, true, kind)
    if (!best || sf.parseDiagnostics.length < best.parseDiagnostics.length) best = sf
    if (!sf.parseDiagnostics.length) break
  }
  return best
}

function walkAst(node, fn) {
  fn(node)
  ts.forEachChild(node, (c) => walkAst(c, fn))
}

/**
 * Every `source` written to activities in one file.
 * @returns {{ values: { value: string, line: number }[], unresolved: { line: number, text: string }[] }}
 */
export function activitiesSourceWrites(text, file = 'scan.js') {
  const code = codeOf(text, file)
  const out = { values: [], unresolved: [] }
  if (!/\.from\(\s*['"`]activities['"`]\s*\)/.test(code)) return out
  const sf = parse(code, file)
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  const decls = new Map() // name → initializers
  const pushes = new Map() // name → pushed args
  const sourceSets = new Map() // name → `name.source = expr`
  const fns = new Map() // name → same-file function declarations
  const add = (m, k, v) => m.set(k, [...(m.get(k) || []), v])
  walkAst(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) add(decls, n.name.text, n.initializer)
    if (ts.isFunctionDeclaration(n) && n.name && n.body) add(fns, n.name.text, n)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'push'
      && ts.isIdentifier(n.expression.expression)) {
      for (const a of n.arguments) add(pushes, n.expression.expression.text, a)
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'source' && ts.isIdentifier(n.left.expression)) {
      add(sourceSets, n.left.expression.text, n.right)
    }
  })

  const value = (expr, seen) => {
    const e = unwrap(expr)
    if (isString(e)) return void out.values.push({ value: e.text, line: line(e) })
    if (ts.isConditionalExpression(e)) { value(e.whenTrue, seen); value(e.whenFalse, seen); return }
    if (ts.isIdentifier(e) && decls.has(e.text) && !seen.has(`v:${e.text}`)) {
      seen.add(`v:${e.text}`)
      for (const init of decls.get(e.text)) value(init, seen)
      return
    }
    out.unresolved.push({ line: line(e), text: e.getText(sf) })
  }

  const returned = (fnNode) => {
    if (!ts.isBlock(fnNode.body)) return [fnNode.body]
    const rets = []
    const visit = (n) => {
      if (ts.isFunctionLike(n)) return
      if (ts.isReturnStatement(n) && n.expression) rets.push(n.expression)
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(fnNode.body, visit)
    return rets
  }

  const row = (expr, seen) => {
    const e = unwrap(expr)
    if (!e) return
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && propName(p.name) === 'source') value(p.initializer, seen)
        else if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'source') value(p.name, seen)
        else if (ts.isSpreadAssignment(p)) row(p.expression, seen)
      }
      return
    }
    if (ts.isArrayLiteralExpression(e)) { for (const el of e.elements) row(el, seen); return }
    if (ts.isConditionalExpression(e)) { row(e.whenTrue, seen); row(e.whenFalse, seen); return }
    if (ts.isIdentifier(e)) {
      if (seen.has(`r:${e.text}`)) return
      seen.add(`r:${e.text}`)
      for (const init of decls.get(e.text) || []) row(init, seen)
      for (const a of pushes.get(e.text) || []) row(a, seen)
      for (const v of sourceSets.get(e.text) || []) value(v, seen)
      return
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
      && ['map', 'flatMap'].includes(e.expression.name.text)) {
      const fn = unwrap(e.arguments[0])
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) for (const r of returned(fn)) row(r, seen)
      return
    }
    // A row built by a same-file function: `const row = mapThing(x)`.
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && !seen.has(`f:${e.expression.text}`)) {
      const name = e.expression.text
      seen.add(`f:${name}`)
      const bodies = [...(fns.get(name) || []), ...(decls.get(name) || []).map(unwrap)
        .filter((d) => d && (ts.isArrowFunction(d) || ts.isFunctionExpression(d)))]
      for (const fn of bodies) for (const r of returned(fn)) row(r, seen)
    }
  }

  walkAst(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'from') return
    const table = n.arguments[0]
    if (!table || !isString(table) || table.text !== 'activities') return
    const access = n.parent
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== n || !WRITES.has(access.name.text)) return
    const call = access.parent
    if (!call || !ts.isCallExpression(call) || call.expression !== access) return
    row(call.arguments[0], new Set())
  })
  return out
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.(test|spec)\.(m?js|jsx|ts|tsx)$/.test(name) && !/test-helpers/.test(name)) out.push(full)
  }
  return out
}

function repoWrites() {
  const values = []
  const unresolved = []
  for (const dir of SCAN_DIRS) {
    for (const f of walk(path.join(ROOT, dir))) {
      const r = activitiesSourceWrites(readFileSync(f, 'utf8'), f)
      for (const v of r.values) values.push({ file: rel(f), ...v })
      for (const u of r.unresolved) unresolved.push({ file: rel(f), ...u })
    }
  }
  return { values, unresolved }
}

// ── tests ────────────────────────────────────────────────────────────────

describe('the CHECK list reader', () => {
  it('reads both spellings of the list', () => {
    expect(checkValues(" source IN ('crm', 'glofox')")).toEqual(['crm', 'glofox'])
    expect(checkValues("(source = ANY (ARRAY['crm'::text, 'glofox'::text]))")).toEqual(['crm', 'glofox'])
    expect(() => checkValues("source ~ '^c'")).toThrow(/cannot read/)
  })

  it('takes the latest migration, and a later drop without a re-add', () => {
    const m1 = { name: '138_a.sql', sql: "ALTER TABLE activities ADD CONSTRAINT activities_source_check CHECK (source IN ('crm', 'glofox'));" }
    const m2 = { name: '900_b.sql', sql: "-- ADD CONSTRAINT activities_source_check CHECK (source IN ('nope'))\nALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_source_check;\nALTER TABLE activities ADD CONSTRAINT activities_source_check CHECK (source IN ('crm', 'glofox', 'api'));" }
    const m3 = { name: '901_c.sql', sql: 'ALTER TABLE activities DROP CONSTRAINT activities_source_check;' }
    expect(latestSourceCheck([m1])).toEqual({ file: '138_a.sql', values: ['crm', 'glofox'] })
    expect(latestSourceCheck([m1, m2])).toEqual({ file: '900_b.sql', values: ['crm', 'glofox', 'api'] })
    expect(latestSourceCheck([m1, m2, m3])).toEqual({ file: '901_c.sql', values: null })
  })

  it('migrations sort by number, not by string', () => {
    expect(['700_a.sql', '138_b.sql', '99_c.sql'].sort(migrationOrder)).toEqual(['99_c.sql', '138_b.sql', '700_a.sql'])
  })
})

describe('the write scanner', () => {
  const vals = (code, file) => activitiesSourceWrites(code, file).values.map((v) => v.value)

  it('follows inline objects, consts, spreads, arrays, .push, .map, x.source = and ?:', () => {
    expect(vals("db.from('activities').insert({ kind: 'task', source: 'a' })")).toEqual(['a'])
    expect(vals("const r = { source: 'b' }\nawait db.from('activities').insert(r)")).toEqual(['b'])
    expect(vals("const S = 'c'\ndb.from('activities').upsert({ source: S })")).toEqual(['c'])
    expect(vals("const base = { source: 'd' }\ndb.from('activities').insert({ ...base, x: 1 })")).toEqual(['d'])
    expect(vals("db.from('activities').insert([{ source: 'e' }, { source: 'f' }])")).toEqual(['e', 'f'])
    expect(vals("const rows = []\nrows.push({ source: 'g' })\ndb.from('activities').insert(rows)")).toEqual(['g'])
    expect(vals("const rows = list.map(m => ({ source: 'h' }))\ndb.from('activities').insert(rows)")).toEqual(['h'])
    expect(vals("const rows = list.map(function (m) { return { source: 'i' } })\ndb.from('activities').insert(rows)")).toEqual(['i'])
    expect(vals("const r = {}\nr.source = 'j'\ndb.from('activities').insert(r)")).toEqual(['j'])
    expect(vals("function mk(i) { if (!i) return null\n  return { source: 'p' } }\nconst row = mk(i)\ndb.from('activities').upsert(row)")).toEqual(['p'])
    expect(vals("const mk = (i) => ({ source: 'q' })\ndb.from('activities').insert(mk(i))")).toEqual(['q'])
    expect(vals("db.from('activities').update({ source: ok ? 'k' : 'l' })")).toEqual(['k', 'l'])
    expect(vals("const insert = { source: 'm' }\nconst { data } = await supabase.from('activities')\n  .insert(insert)\n  .select('*')\n  .single()")).toEqual(['m'])
  })

  it('ignores comments, other tables, nested keys and reads', () => {
    expect(vals("// db.from('activities').insert({ source: 'x' })\ndb.from('activities').select('source')")).toEqual([])
    expect(vals("db.from('activities').insert({ /* source: 'x' */ subject: 's' })")).toEqual([])
    expect(vals("db.from('contacts').insert({ source: 'manual' })")).toEqual([])
    expect(vals("db.from('activities').insert({ metadata: { source: 'glofox_sync' } })")).toEqual([])
    expect(vals("db.from('activities').select('*').eq('source', 'x')")).toEqual([])
  })

  it("a '/*' in JSX text or a string does not hide a write", () => {
    expect(vals("const a = <p>see /api/* routes</p>\ndb.from('activities').insert({ source: 'n' })\nconst b = <p>*/</p>", 'scan.jsx')).toEqual(['n'])
    expect(vals("const g = 'image/*'\ndb.from('activities').insert({ source: 'o' })\nconst h = '*/'")).toEqual(['o'])
  })

  it('a computed source is reported, not passed', () => {
    const r = activitiesSourceWrites("db.from('activities').insert({ source: body.source })")
    expect(r.values).toEqual([])
    expect(r.unresolved).toEqual([{ line: 1, text: 'body.source' }])
  })
})

describe('activities_source_check holds every literal source the code writes', () => {
  const check = latestSourceCheck(repoMigrations())
  const { values, unresolved } = repoWrites()

  it('a migration defines the CHECK and the latest one still has it', () => {
    expect(check, 'no migration defines activities_source_check').not.toBe(null)
    expect(check.values, `${check.file} drops activities_source_check without re-adding it: decide what source may hold, then update this guard`).not.toBe(null)
    expect(check.values).toContain('crm') // the column default (mig 138)
  })

  it('the scanner sees the known writers (a floor against a blind scanner)', () => {
    const files = new Set(values.map((v) => v.file))
    for (const f of ['mobile/lib/tasks-api.js', 'src/app/api/tasks/route.js', 'src/lib/glofox-sync.js']) {
      expect(files, `${f} writes a literal source to activities; the scanner no longer sees it`).toContain(f)
    }
  })

  it('every literal source is in the latest CHECK list', () => {
    const bad = values.filter((v) => !check.values.includes(v.value)).map((v) => `${v.file}:${v.line} source '${v.value}'`)
    expect(bad, `activities_source_check (${check.file}) allows only ${check.values.map((v) => `'${v}'`).join(', ')}; Postgres refuses these inserts`).toEqual([])
  })

  it('every source written to activities resolves to literals', () => {
    expect(unresolved.map((u) => `${u.file}:${u.line} source ${u.text}`)).toEqual([])
  })
})
