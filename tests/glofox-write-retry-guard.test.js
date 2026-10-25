// GLOFOXPOSTRETRY.1 guard. glofoxFetch re-sends a 5xx only for GET/HEAD by
// default, and every write in src/lib/glofox.js names its policy on purpose:
// 'idempotent' (a read that is a POST), 'never' (no safe dedupe read), or
// { verify } (a dedupe read before any re-send). A new write that relies on
// the default is fine today and silently wrong the day someone "fixes" a 5xx
// by adding retry: 'idempotent' without thinking about money. So: every
// glofoxFetch( call whose options name a method other than GET/HEAD must also
// name retry:.
//
// How calls are found: each scanned file (every .js/.jsx/.mjs/.ts/.tsx under
// src/, shared/ and scripts/, tests, test helpers and .d.ts excluded) that mentions
// glofoxFetch at all is parsed ONCE with the TypeScript parser, and the calls
// are read off the AST: a call of glofoxFetch (or of a name it was imported
// as, or `x.glofoxFetch(…)`), its third argument, and that object's `method`
// and `retry` properties. Nothing is matched in the text, so a call quoted in
// a comment or a string never counts, and nothing needs stripping.
//
// Stricter than "a literal POST without retry:": options the AST cannot read
// (a variable, a spread with no explicit method, a method that is not a
// string literal) fail too, unless the call names retry:. And the retry VALUE
// must be readable (review): 'idempotent', 'never', an object literal with a
// verify key, or a conditional whose branches are each one of those. A
// variable, `undefined` or any other string fails, since the policy it hides
// could be anything. A TypeScript cast or `satisfies` around the options is
// looked through. The file must say what it means where the guard can see it.
//
// A FLOOR, NOT A PROOF: a call through another variable (`const f =
// glofoxFetch; f(…)`) is invisible, and the guard checks that a policy is
// NAMED, not that it is the right one. The per-wrapper tests in
// src/lib/glofox-retry-policy.test.js pin each choice.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'shared', 'scripts'].map((d) => path.join(ROOT, d))
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

// .ts/.tsx parse as TypeScript (a JSX parse would choke on `<T>` and casts).
const parse = (text, file = 'scan.jsx') => {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

/** Is this repo path one the guard scans? */
export function isScanned(file) {
  return /\.(m?js|jsx|ts|tsx)$/.test(file) && !/\.d\.ts$/.test(file) && !/\.test\.|\.test-helpers?\./.test(file)
}

// Look through parentheses, `as T`, `<T>x` and `satisfies T`.
function unwrap(node) {
  let n = node
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) n = n.expression
  return n
}

/** Is a retry value one of the readable policies? */
function isReadablePolicy(node) {
  const n = unwrap(node)
  if (!n) return false
  if (ts.isStringLiteralLike(n)) return n.text === 'idempotent' || n.text === 'never'
  if (ts.isObjectLiteralExpression(n)) {
    return n.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && propName(p) === 'verify')
  }
  if (ts.isConditionalExpression(n)) return isReadablePolicy(n.whenTrue) && isReadablePolicy(n.whenFalse)
  return false
}

const propName = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null)

/** Local names glofoxFetch is imported as (itself always counts). */
function glofoxFetchNames(sf) {
  const names = new Set(['glofoxFetch'])
  for (const st of sf.statements) {
    const nb = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : null
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) if ((el.propertyName || el.name).text === 'glofoxFetch') names.add(el.name.text)
    }
  }
  return names
}

/**
 * Every glofoxFetch call in a parsed file, with what its options say.
 * @returns {{ line: number, method: string|null, readable: boolean, hasRetry: boolean, retryOk: boolean }[]}
 *   method: the literal method upper-cased, 'GET' when there are no options or
 *   no method key, null when it cannot be read. readable: false when the
 *   options are not an object literal, or spread something with no explicit
 *   method. hasRetry: a retry key is present; retryOk: its value is a
 *   readable policy (isReadablePolicy).
 */
export function glofoxFetchCalls(sf) {
  const names = glofoxFetchNames(sf)
  const out = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isCall = (ts.isIdentifier(callee) && names.has(callee.text))
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'glofoxFetch')
      if (isCall) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const opts = unwrap(node.arguments[2])
        if (!opts) {
          out.push({ line, method: 'GET', readable: true, hasRetry: false, retryOk: false })
        } else if (!ts.isObjectLiteralExpression(opts)) {
          out.push({ line, method: null, readable: false, hasRetry: false, retryOk: false })
        } else {
          const props = opts.properties
          const named = (key) => props.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propName(p) === key)
          const methodProp = named('method')
          const retryProp = named('retry')
          const hasSpread = props.some((p) => ts.isSpreadAssignment(p))
          let method = null
          if (!methodProp) method = hasSpread ? null : 'GET'
          else if (ts.isPropertyAssignment(methodProp) && ts.isStringLiteralLike(methodProp.initializer)) method = methodProp.initializer.text.toUpperCase()
          // A shorthand `retry` is a variable: unreadable.
          const retryOk = !!retryProp && ts.isPropertyAssignment(retryProp) && isReadablePolicy(retryProp.initializer)
          out.push({ line, method, readable: !(hasSpread && !methodProp), hasRetry: !!retryProp, retryOk })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** "file:line" of each call that may be a write and names no readable retry policy. */
export function writesWithoutPolicy(label, sf) {
  return glofoxFetchCalls(sf)
    .filter((c) => !c.retryOk && !(c.readable && (c.method === 'GET' || c.method === 'HEAD')))
    .map((c) => `${label}:${c.line}`)
}

function sourceFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '__tests__', '.next'].includes(entry.name)) continue
      out.push(...sourceFiles(full))
    } else if (isScanned(entry.name)) out.push(full)
  }
  return out
}

// Each file is read once, and parsed once only if it mentions glofoxFetch at
// all (a file that never names it cannot call it). The whole-repo describe
// carries its own timeout: a TypeScript parse per `it` is what timed another
// guard out at vitest's 5 s default on the CI runner.
const WHOLE_REPO_TIMEOUT_MS = 120_000
let cached = null
function sources() {
  if (!cached) {
    cached = SCAN_DIRS.flatMap(sourceFiles)
      .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
      .filter(({ text }) => text.includes('glofoxFetch'))
      .map(({ file, text }) => ({ file, sf: parse(text, file) }))
  }
  return cached
}

describe('the scanner (canaries)', () => {
  it('reads calls off the AST: a call quoted in a comment, a string or JSX text never counts', () => {
    const sf = parse([
      "// glofoxFetch(c, '/a', { method: 'POST' })",
      "/* glofoxFetch(c, '/b', { method: 'POST' }) */",
      "const s = \"glofoxFetch(c, '/c', { method: 'POST' })\"",
      "const t = `glofoxFetch(c, '/d', { method: 'POST' })`",
      "const el = <p>// glofoxFetch(c, '/e', {'{'} method: 'POST' {'}'})</p>",
      "await glofoxFetch(c, '/f', { method: 'POST', body: '{}' }) // the real one",
      'export async function glofoxFetch(creds, pathOrUrl, options = {}) {}',
    ].join('\n'))
    expect(glofoxFetchCalls(sf).map((c) => c.line)).toEqual([6])
  })

  it('flags writes with no policy; passes GET, no options, and a named policy', () => {
    const sf = parse([
      "glofoxFetch(c, '/a', { method: 'POST', body: '{}' })",
      "glofoxFetch(c, '/b', { method: 'put' })",
      'glofoxFetch(c, "/c", { method: verb })',
      'glofoxFetch(c, "/d", opts)',
      "glofoxFetch(c, '/e', { ...opts })",
      "glofoxFetch(c, '/f', { method: 'GET' })",
      "glofoxFetch(c, '/g')",
      "glofoxFetch(c, '/h', { signal })",
      "glofoxFetch(c, '/i', { method: 'POST', retry: { verify } })",
      "glofoxFetch(c, '/j', { method: 'POST', retry: v ? { verify: v } : 'never' })",
      "glofoxFetch(c, '/k', { method: 'HEAD', ...rest })",
      "glofoxFetch(c, '/l', { ...opts, retry: 'never' })",
    ].join('\n'))
    expect(writesWithoutPolicy('x.js', sf)).toEqual(['x.js:1', 'x.js:2', 'x.js:3', 'x.js:4', 'x.js:5'])
  })

  it('follows an aliased import and a member call', () => {
    const sf = parse([
      "import { glofoxFetch as gf } from '@/lib/glofox'",
      "gf(c, '/a', { method: 'POST' })",
      "glofox.glofoxFetch(c, '/b', { method: 'POST' })",
      "other.fetch(c, '/c', { method: 'POST' })",
    ].join('\n'))
    expect(writesWithoutPolicy('x.js', sf)).toEqual(['x.js:2', 'x.js:3'])
  })
})

describe('the retry value itself (review: a named key is not a named policy)', () => {
  it("a write passes only 'idempotent', 'never', an object literal with verify, or a conditional of those", () => {
    const sf = parse([
      "glofoxFetch(c, '/a', { method: 'POST', retry: 'never' })",
      "glofoxFetch(c, '/b', { method: 'POST', retry: 'idempotent' })",
      "glofoxFetch(c, '/c', { method: 'POST', retry: { verify } })",
      "glofoxFetch(c, '/d', { method: 'POST', retry: { verify: async () => 'absent' } })",
      "glofoxFetch(c, '/e', { method: 'POST', retry: ok ? { verify: v } : 'never' })",
      "glofoxFetch(c, '/f', { method: 'POST', retry: undefined })",
      "glofoxFetch(c, '/g', { method: 'POST', retry: policy })",
      "glofoxFetch(c, '/h', { method: 'POST', retry })",
      "glofoxFetch(c, '/i', { method: 'POST', retry: 'sometimes' })",
      "glofoxFetch(c, '/j', { method: 'POST', retry: { check } })",
      "glofoxFetch(c, '/k', { method: 'POST', retry: ok ? policy : 'never' })",
      "glofoxFetch(c, '/l', { method: 'GET', retry: anything })",
    ].join('\n'))
    expect(writesWithoutPolicy('x.js', sf)).toEqual(['x.js:6', 'x.js:7', 'x.js:8', 'x.js:9', 'x.js:10', 'x.js:11'])
  })

  it('reads TypeScript: a cast or satisfies around the options is looked through', () => {
    const sf = parse([
      "await glofoxFetch(c, '/a', { method: 'POST' } as RequestInit)",
      "await glofoxFetch(c, '/b', ({ method: 'POST', retry: 'never' }) satisfies Opts)",
      "const x: number = 1",
    ].join('\n'), 'x.ts')
    expect(writesWithoutPolicy('x.ts', sf)).toEqual(['x.ts:1'])
  })

  it('scans .ts and .tsx files too', () => {
    expect(isScanned('src/lib/a.ts')).toBe(true)
    expect(isScanned('src/app/b.tsx')).toBe(true)
    expect(isScanned('src/lib/a.test.ts')).toBe(false)
    expect(isScanned('src/lib/a.d.ts')).toBe(false)
  })
})

describe('GLOFOXPOSTRETRY.1 — every Glofox write names its retry policy', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  it('no glofoxFetch call that may be a write is missing one', () => {
    const bad = sources().flatMap(({ file, sf }) => writesWithoutPolicy(rel(file), sf))
    expect(bad).toEqual([])
  })

  it('the scan really sees the writes in glofox.js (an empty result is not a broken scanner)', () => {
    const glofox = sources().find(({ file }) => rel(file) === 'src/lib/glofox.js')
    expect(glofox).toBeTruthy()
    const writes = glofoxFetchCalls(glofox.sf).filter((c) => c.method === 'POST' || c.method === 'PUT')
    // 10 writes and read-POSTs in the plan's per-caller table, plus fetchBranchLeads.
    expect(writes.length).toBeGreaterThanOrEqual(11)
    expect(writes.every((c) => c.retryOk)).toBe(true)
  })
})
