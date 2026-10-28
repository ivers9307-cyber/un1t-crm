// UN1TWRITE.7 guards. They prove two things without running anything:
//
//   1. the SYNC cannot write: no sync-side module reaches the write transport,
//      its ops, its ledger or its mirror, however many imports deep;
//   2. the WRITE side cannot misbehave: every call to the writer's send( names
//      a policy and one of the seven allowed endpoints, the endpoints and body
//      keys the CRM never sends appear nowhere in src/, POST /credits/grant
//      only inside regrantTrialCredits, called only from grantTrial
//      (TRIALREGRANT.1, Richard's decision 20 Oct 2026), the write modules
//      hold no PUT or DELETE verb, and only the ops module reaches the
//      transport's internals.
//
// How things are found: files are parsed with the TypeScript parser and the
// facts are read off the AST (imports, call expressions, identifiers, string,
// template and regex literals). Comments are never searched, so the transport
// can describe what it refuses in prose. What the guard does NOT see: a string
// built by concatenation ('/purchases/' + 'charge'), a send reached through an
// alias of the writer in a file that neither imports the write modules nor puts
// an HTTP verb first. It is a FLOOR; the transport's own allowlist
// (un1t-online-write.transport.test.js) is the proof.
//
// "the transport's own allowlist and banned-key list" is the one place the
// banned names may appear: /purchases/charge and /credits/grant inside the
// ENDPOINTS table and bypassCredit / forceRefund / promoCode inside
// BANNED_BODY_KEYS. Everything else is a violation (but /purchases/charge
// inside grantTrial and /credits/grant inside regrantTrialCredits), and the
// pins below fix those two tables as they are.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')
const WHOLE_REPO_TIMEOUT_MS = 120_000

const TRANSPORT = 'src/lib/un1t-online-write.js'
const OPS = 'src/lib/un1t-online-write-ops.js'

// ── Parsing ────────────────────────────────────────────────────────────────
const parse = (text, file = 'scan.jsx') => {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

/** Is this repo path a source file the guards scan (tests, helpers and .d.ts are not)? */
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

const propName = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null)
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/**
 * The text a node stands for when it is a string, a template or a regex
 * literal; `${…}` becomes `${}` and a regex loses its `\/` escapes. null for
 * anything else. Template pieces count one by one in `literalTexts`.
 */
function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => '${}' + s.literal.text).join('')
  }
  if (ts.isRegularExpressionLiteral(node)) return node.text.replace(/\\\//g, '/')
  return null
}

// Every name along the way up: functions, methods, and the variable a function
// or table is assigned to. 'grantTrial' or 'ENDPOINTS' being in the chain is
// what lets a literal stand.
function enclosingNames(node) {
  const names = []
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)) && n.name && ts.isIdentifier(n.name)) names.push(n.name.text)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.push(n.name.text)
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) names.push(n.name.text)
  }
  return names
}

/**
 * Every identifier equal to one of `names`, and every string, template or
 * regex literal that contains one, with where it sits.
 * @returns {{ line: number, name: string, chain: string[] }[]}
 */
export function nameHits(sf, names) {
  const out = []
  const visit = (node) => {
    if (ts.isIdentifier(node) && names.includes(node.text)) {
      out.push({ line: lineOf(sf, node), name: node.text, chain: enclosingNames(node) })
    } else {
      const text = literalText(node)
      if (text != null) {
        for (const name of names) if (text.includes(name)) out.push({ line: lineOf(sf, node), name, chain: enclosingNames(node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Every literal (string, template, regex) whose text matches `re`, with where it sits. */
export function literalHits(sf, re) {
  const out = []
  const visit = (node) => {
    const text = literalText(node)
    if (text != null && re.test(text)) out.push({ line: lineOf(sf, node), text, chain: enclosingNames(node) })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ── The source tree, read once ─────────────────────────────────────────────
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

// One TypeScript parse per file that could matter, cached. The whole-repo
// describes carry their own timeout: parsing the tree is what times a guard
// out at vitest's 5 s default on the CI runner.
let texts = null
const parsed = new Map()
function allSources() {
  if (!texts) texts = sourceFiles(SRC).map((file) => ({ file, key: rel(file), text: fs.readFileSync(file, 'utf8') }))
  return texts
}
function parsedFile(entry) {
  if (!parsed.has(entry.file)) parsed.set(entry.file, parse(entry.text, entry.file))
  return parsed.get(entry.file)
}
// Parse only the files whose text mentions one of the needles (a file that
// never names a thing cannot use it).
function filesMentioning(re) {
  return allSources().filter(({ text }) => re.test(text)).map((entry) => ({ ...entry, sf: parsedFile(entry) }))
}

// ── 1. The sync import fence ───────────────────────────────────────────────
// Sync side: C's projection (un1t-online-bookings.js) is listed for when it
// lands. The read client, its token fingerprint and the status helper are the
// read side too, so they are fenced with it.
const SYNC_SIDE_REQUIRED = [
  'src/lib/un1t-online-sync.js',
  'src/lib/un1t-online-map.js',
  'src/lib/un1t-online-contacts.js',
  'src/lib/un1t-online-occurrences.js',
  'src/lib/un1t-online-studio-preferences.js',
  'src/lib/un1t-online.js',
  'src/lib/un1t-online-token.js',
  'src/lib/un1t-online-status.js',
  'src/app/api/cron/un1t-online-sync/route.js',
  'src/app/api/locations/[id]/un1t-online/sync/route.js',
]
const SYNC_SIDE_WHEN_PRESENT = ['src/lib/un1t-online-bookings.js']

// The write modules: the transport, the ops, the ledger, the judge, and the
// mirror. The judge is pure, but only the write side has a use for it.
export const isWriteModule = (key) => /(^|\/)un1t-online-(write|mirror-write)(\.|-)[^/]*$/.test(key) && isScanned(key)

const CODE_EXT = ['.js', '.jsx', '.mjs', '.ts', '.tsx']

/** Module specifiers a parsed file imports, re-exports, import()s or require()s. */
export function importSpecifiers(sf) {
  const out = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) out.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Resolve a relative or `@/` specifier to a repo-relative path, or null for a
 * package (not ours to walk). `exists` answers for a repo-relative path.
 * Returns { key } or { unresolved: spec }.
 */
export function resolveSpecifier(fromKey, spec, exists) {
  let base
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), spec))
  else return null
  const candidates = [base, ...CODE_EXT.map((e) => base + e), ...CODE_EXT.map((e) => `${base}/index${e}`)]
  const hit = candidates.find((c) => exists(c))
  return hit ? { key: hit } : { unresolved: spec }
}

/**
 * Walk imports from `entries` to a fixed point. `io` = { read(key) → text|null,
 * exists(key) → boolean }. Only code files are opened (a .css or .json is a leaf).
 * @returns {{ chains: Map<string, string[]>, unresolved: string[] }} chains: every
 *   file reached → the import path that reached it, entry first.
 */
export function walkImports(entries, io) {
  const chains = new Map()
  const unresolved = []
  const queue = []
  for (const e of entries) {
    if (!chains.has(e)) { chains.set(e, [e]); queue.push(e) }
  }
  while (queue.length) {
    const key = queue.shift()
    if (!CODE_EXT.some((e) => key.endsWith(e))) continue
    const text = io.read(key)
    if (text == null) continue
    for (const spec of importSpecifiers(parse(text, key))) {
      const r = resolveSpecifier(key, spec, io.exists)
      if (!r) continue
      if (r.unresolved) { unresolved.push(`${key} imports ${r.unresolved}`); continue }
      if (!chains.has(r.key)) { chains.set(r.key, [...chains.get(key), r.key]); queue.push(r.key) }
    }
  }
  return { chains, unresolved }
}

const realIo = {
  exists: (key) => { try { return fs.statSync(path.join(ROOT, key)).isFile() } catch { return false } },
  read: (key) => { try { return fs.readFileSync(path.join(ROOT, key), 'utf8') } catch { return null } },
}

/** "entry -> … -> write module" for each write module a walk reached. */
export function fenceBreaches(entries, io) {
  const { chains } = walkImports(entries, io)
  return [...chains.entries()].filter(([key]) => isWriteModule(key)).map(([, chain]) => chain.join(' -> '))
}

// ── 2. Calls to the writer's send( ─────────────────────────────────────────
const HTTP_VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i
const POLICIES = ['verify', 'never', 'idempotent']
// The eight writes the CRM may make, with `${…}` in a path read as :id.
export const ALLOWED_WRITES = Object.freeze([
  'POST /bookings',
  'PATCH /bookings/:id/cancel',
  'POST /users/clients',
  'POST /auth/forgot-password',
  'POST /purchases/charge',
  'POST /purchases/checkout',
  // TRIALREGRANT.1: grantTrial's one-off credit re-grant only.
  'POST /credits/grant',
  // FEES.1: chargeClassFee's staff-reviewed late-cancel / no-show fee only.
  'POST /purchases/charge-custom',
])

// A path argument as a template: a literal as is, `${…}` as :id, null for
// anything the guard cannot read (a variable, a concatenation).
function pathTemplate(node) {
  const n = unwrap(node)
  if (!n) return null
  if (ts.isStringLiteralLike(n)) return n.text
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => ':id' + s.literal.text).join('')
  return null
}

/**
 * The calls to a writer's send( in a parsed file, with what they say.
 * A call is the writer's when it is `x.send(…)` (or `x['send'](…)`) in a file
 * that is, or imports, a write module; or, in any file, a send whose first
 * argument is an HTTP verb literal. An identifier send( with two or more
 * arguments counts in a write-side file (a destructured writer).
 * @returns {{ line: number, verb: string|null, path: string|null, policy: string|null, op: string|null, optsReadable: boolean }[]}
 */
export function writerSendCalls(sf, { writeSide }) {
  const out = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      const member = callee && ((ts.isPropertyAccessExpression(callee) && callee.name.text === 'send')
        || (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === 'send'))
      const ident = callee && ts.isIdentifier(callee) && callee.text === 'send'
      if (member || ident) {
        const first = unwrap(node.arguments[0])
        const verbFirst = !!first && ts.isStringLiteralLike(first) && HTTP_VERB.test(first.text)
        if (verbFirst || (writeSide && (member || node.arguments.length >= 2))) {
          const opts = unwrap(node.arguments[2])
          const optsReadable = !!opts && ts.isObjectLiteralExpression(opts) && !opts.properties.some((p) => ts.isSpreadAssignment(p))
          const lit = (key) => {
            if (!optsReadable) return null
            const p = opts.properties.find((q) => ts.isPropertyAssignment(q) && propName(q) === key)
            const v = p && unwrap(p.initializer)
            return v && ts.isStringLiteralLike(v) ? v.text : null
          }
          out.push({
            line: lineOf(sf, node),
            verb: first && ts.isStringLiteralLike(first) ? first.text.toUpperCase() : null,
            path: pathTemplate(node.arguments[1]),
            policy: lit('policy'),
            op: lit('op'),
            optsReadable,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** The value of `const <name> = { key: 'literal', … }` as a plain object, from the AST. */
export function frozenTable(sf, name) {
  let found = null
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      let init = unwrap(node.initializer)
      if (ts.isCallExpression(init) && init.arguments.length === 1) init = unwrap(init.arguments[0]) // Object.freeze({…})
      if (init && ts.isObjectLiteralExpression(init)) {
        found = {}
        for (const p of init.properties) {
          const v = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : null
          if (v && ts.isStringLiteralLike(v)) found[propName(p)] = v.text
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Does the call go to an allowed write? */
export const isAllowedWrite = (c) => c.verb != null && c.path != null && ALLOWED_WRITES.includes(`${c.verb} ${c.path}`)

/** "line N" of each send( whose policy is not a literal verify, never or idempotent, or does not match its op's. */
export function sendsWithoutPolicy(label, sf, opPolicy, opts = { writeSide: true }) {
  return writerSendCalls(sf, opts)
    .filter((c) => !(POLICIES.includes(c.policy) && c.op != null && opPolicy[c.op] === c.policy))
    .map((c) => `${label}:${c.line}`)
}

/** "line N" of each send( that is not one of the seven writes. */
export function sendsOffAllowlist(label, sf, opts = { writeSide: true }) {
  return writerSendCalls(sf, opts).filter((c) => !isAllowedWrite(c)).map((c) => `${label}:${c.line}`)
}

// ── 3. Banned endpoints, keys, verbs, internals ────────────────────────────
// Nowhere in src/ outside tests. reset-password is the un1t.online one,
// /users/{id}/reset-password; the CRM's own /reset-password page is not.
// /credits/grant is fenced on its own (creditsGrantOutsideRegrant): it may
// stand only inside regrantTrialCredits (TRIALREGRANT.1).
const BANNED_ENDPOINTS = [
  { label: '/refunds', re: /\/refunds/ },
  // FEES.1: charge-custom itself is fenced on its own (chargeCustomOutsideFee):
  // it may stand only inside chargeClassFee. Its emailed-link sibling never.
  { label: 'charge-custom/link', re: /charge-custom\/link/ },
  { label: 'payment-sheet', re: /payment-sheet/ },
  { label: 'mark-attendance', re: /mark-attendance/ },
  { label: '/users/{id}/reset-password', re: /\/users\/[^\s'"`]*reset-password/ },
]
const BANNED_KEYS = ['bypassCredit', 'forceRefund']
const BANNED_KEY_ALLOWED_IN = { file: TRANSPORT, chain: 'BANNED_BODY_KEYS' }

/** "line N" of each literal naming a banned endpoint. */
export function bannedEndpointHits(label, sf) {
  return BANNED_ENDPOINTS.flatMap(({ label: what, re }) => literalHits(sf, re).map((h) => `${label}:${h.line} (${what})`))
}

/** "line N" of each /purchases/charge outside grantTrial and outside the transport's ENDPOINTS table. */
export function chargeOutsideGrantTrial(key, sf) {
  return literalHits(sf, /purchases\/charge(?!-)/)
    .filter((h) => !h.chain.includes('grantTrial') && !(key === TRANSPORT && h.chain.includes('ENDPOINTS')))
    .map((h) => `${key}:${h.line}`)
}

/**
 * FEES.1 — "line N" of each charge-custom outside the ops module's
 * chargeClassFee and outside the transport's ENDPOINTS table (Richard's
 * decision 28 Oct 2026: the class fee is the only paid custom charge).
 */
export function chargeCustomOutsideFee(key, sf) {
  return literalHits(sf, /charge-custom/)
    .filter((h) => !(key === OPS && h.chain.includes('chargeClassFee')) && !(key === TRANSPORT && h.chain.includes('ENDPOINTS')))
    .map((h) => `${key}:${h.line}`)
}

/**
 * TRIALREGRANT.1 — "line N" of each /credits/grant outside the ops module's
 * regrantTrialCredits and outside the transport's ENDPOINTS table.
 */
export function creditsGrantOutsideRegrant(key, sf) {
  return literalHits(sf, /credits\/grant/)
    .filter((h) => !(key === OPS && h.chain.includes('regrantTrialCredits')) && !(key === TRANSPORT && h.chain.includes('ENDPOINTS')))
    .map((h) => `${key}:${h.line}`)
}

/**
 * TRIALREGRANT.1 — "line N" of each mention of regrantTrialCredits that is
 * not its own declaration in the ops module or a call inside grantTrial
 * there. Anywhere else (another file, an export, a call from another
 * primitive, a reference passed around) is a violation.
 */
export function regrantOutsideGrantTrial(key, sf) {
  const out = []
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'regrantTrialCredits') {
      const parent = node.parent
      const isDeclaration = ts.isFunctionDeclaration(parent) && parent.name === node
        && !(parent.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      const isCallInGrantTrial = ts.isCallExpression(parent) && parent.expression === node && enclosingNames(node).includes('grantTrial')
      if (!(key === OPS && (isDeclaration || isCallInGrantTrial))) out.push(`${key}:${lineOf(sf, node)}`)
    } else {
      const text = literalText(node)
      if (text != null && text.includes('regrantTrialCredits')) out.push(`${key}:${lineOf(sf, node)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** "line N" of each banned body key (as a key, a name or inside a string) outside the transport's BANNED_BODY_KEYS. */
export function bannedKeyHits(key, sf, names = BANNED_KEYS) {
  return nameHits(sf, names)
    .filter((h) => !(key === BANNED_KEY_ALLOWED_IN.file && h.chain.includes(BANNED_KEY_ALLOWED_IN.chain)))
    .map((h) => `${key}:${h.line} (${h.name})`)
}

/** "line N" of each PUT or DELETE verb literal. */
export function writeVerbHits(key, sf) {
  return literalHits(sf, /(^|[^A-Za-z])(PUT|DELETE)([^A-Za-z]|$)|^\s*(put|delete)\s*$/).map((h) => `${key}:${h.line}`)
}

/** "line N" of each POST, PUT, PATCH or DELETE verb literal. */
export function anyWriteVerbHits(key, sf) {
  return literalHits(sf, /^\s*(POST|PUT|PATCH|DELETE)\s*$/i).map((h) => `${key}:${h.line}`)
}

/** "line N" of each reference to _un1tWriteInternals, plus any `export * from` the transport. */
export function internalsHits(key, sf) {
  const out = nameHits(sf, ['_un1tWriteInternals']).map((h) => `${key}:${h.line}`)
  const visit = (node) => {
    if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      && /un1t-online-write(\.js)?$/.test(node.moduleSpecifier.text)) out.push(`${key}:${lineOf(sf, node)} (export * from the transport)`)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ── Canaries: the scanners bite on planted violations ──────────────────────
describe('the import fence (canaries)', () => {
  const fake = (files) => ({
    exists: (k) => Object.hasOwn(files, k),
    read: (k) => files[k] ?? null,
  })

  it('finds a write module imported directly, by @/, with a dynamic import, by require and by re-export', () => {
    const direct = fake({ 'src/lib/un1t-online-x.js': "import '@/lib/un1t-online-write'", 'src/lib/un1t-online-write.js': '' })
    expect(fenceBreaches(['src/lib/un1t-online-x.js'], direct)).toEqual(['src/lib/un1t-online-x.js -> src/lib/un1t-online-write.js'])
    for (const line of [
      "import { x } from './un1t-online-write-ops.js'",
      "const m = await import('./un1t-online-write-ledger')",
      "const m = require('./un1t-online-mirror-write')",
      "export * from './un1t-online-write-judge.js'",
      "export { x } from './un1t-online-write'",
    ]) {
      const io = fake({ 'src/lib/a.js': line, 'src/lib/un1t-online-write.js': '', 'src/lib/un1t-online-write-ops.js': '', 'src/lib/un1t-online-write-ledger.js': '', 'src/lib/un1t-online-mirror-write.js': '', 'src/lib/un1t-online-write-judge.js': '' })
      expect(fenceBreaches(['src/lib/a.js'], io), line).toHaveLength(1)
    }
  })

  it('finds it transitively, through a directory index, and names the whole chain', () => {
    const io = fake({
      'src/lib/a.js': "import { b } from './b.js'",
      'src/lib/b.js': "import { c } from '@/lib/deep'",
      'src/lib/deep/index.js': "import './un1t-online-write-ops.js'",
      'src/lib/deep/un1t-online-write-ops.js': '',
    })
    expect(fenceBreaches(['src/lib/a.js'], io)).toEqual(['src/lib/a.js -> src/lib/b.js -> src/lib/deep/index.js -> src/lib/deep/un1t-online-write-ops.js'])
  })

  it('terminates on a cycle, ignores packages, and does not flag the sync-side files themselves', () => {
    const io = fake({
      'src/lib/a.js': "import './b'\nimport 'react'\nimport fs from 'node:fs'",
      'src/lib/b.js': "import './a'",
    })
    expect(fenceBreaches(['src/lib/a.js'], io)).toEqual([])
  })

  it('reports an import it cannot resolve instead of silently skipping it', () => {
    const io = fake({ 'src/lib/a.js': "import './gone.js'" })
    expect(walkImports(['src/lib/a.js'], io).unresolved).toEqual(['src/lib/a.js imports ./gone.js'])
  })

  it('knows which files are write modules (not the sync, not a test)', () => {
    for (const k of ['un1t-online-write', 'un1t-online-write-ops', 'un1t-online-write-ledger', 'un1t-online-write-judge', 'un1t-online-mirror-write']) {
      expect(isWriteModule(`src/lib/${k}.js`), k).toBe(true)
    }
    for (const k of ['un1t-online-sync.js', 'un1t-online-settings.js', 'un1t-online.js', 'un1t-online-write.transport.test.js', 'un1t-online-write.test-helpers.js']) {
      expect(isWriteModule(`src/lib/${k}`), k).toBe(false)
    }
  })
})

describe('the send( scanner (canaries)', () => {
  const OP_POLICY = { book: 'verify', cancel: 'verify', create_client: 'verify', forgot_password: 'never', trial: 'never', checkout: 'idempotent' }

  it('reads the verb, the path template, the policy and the op off the AST; a call in a comment or string never counts', () => {
    const sf = parse([
      "// writer.send('POST', '/bookings', { policy: 'x' })",
      "const s = \"writer.send('POST', '/bookings')\"",
      "await writer.send('PATCH', `/bookings/${id}/cancel`, { body: {}, policy: 'verify', op: 'cancel' })",
      "await writer['send']('post', '/users/clients', { policy: 'verify', op: 'create_client' })",
    ].join('\n'))
    expect(writerSendCalls(sf, { writeSide: true })).toEqual([
      { line: 3, verb: 'PATCH', path: '/bookings/:id/cancel', policy: 'verify', op: 'cancel', optsReadable: true },
      { line: 4, verb: 'POST', path: '/users/clients', policy: 'verify', op: 'create_client', optsReadable: true },
    ])
  })

  it('flags a send with no policy, an unreadable policy, an unknown policy or a policy that is not its op\'s', () => {
    const sf = parse([
      "writer.send('POST', '/bookings', { op: 'book' })",
      "writer.send('POST', '/bookings', { policy, op: 'book' })",
      "writer.send('POST', '/bookings', { policy: undefined, op: 'book' })",
      "writer.send('POST', '/bookings', { policy: 'sometimes', op: 'book' })",
      "writer.send('POST', '/bookings', { policy: policyFor(op), op: 'book' })",
      "writer.send('POST', '/bookings', opts)",
      "writer.send('POST', '/bookings', { ...opts })",
      "writer.send('POST', '/bookings')",
      "writer.send('POST', '/bookings', { policy: 'never', op: 'book' })",
      "writer.send('POST', '/bookings', { policy: 'verify' })",
      "writer.send('POST', '/bookings', { policy: 'verify', op })",
      "writer.send('POST', '/bookings', { policy: 'verify', op: 'book' })",
      "writer.send('POST', '/purchases/checkout', cond ? { policy: 'never' } : { policy: 'idempotent' })",
    ].join('\n'))
    expect(sendsWithoutPolicy('x.js', sf, OP_POLICY)).toEqual(['x.js:1', 'x.js:2', 'x.js:3', 'x.js:4', 'x.js:5', 'x.js:6', 'x.js:7', 'x.js:8', 'x.js:9', 'x.js:10', 'x.js:11', 'x.js:13'])
  })

  it('flags a send that is not one of the seven writes, a variable verb or path, and a banned verb', () => {
    const sf = parse([
      "writer.send('POST', '/bookings', {})",
      "writer.send('PATCH', `/bookings/${id}/cancel`, {})",
      "writer.send('POST', '/users/clients', {})",
      "writer.send('POST', '/auth/forgot-password', {})",
      "writer.send('POST', '/purchases/charge', {})",
      "writer.send('POST', '/purchases/checkout', {})",
      "writer.send('DELETE', '/bookings/1', {})",
      "writer.send('PUT', `/users/${id}`, {})",
      "writer.send('PATCH', `/users/${id}`, {})",
      "writer.send('POST', '/credits/grant', {})",
      "writer.send('POST', '/bookings/1/mark-attendance', {})",
      "writer.send('GET', '/bookings', {})",
      "writer.send(verb, '/bookings', {})",
      "writer.send('POST', path, {})",
      "writer.send('POST', base + '/bookings', {})",
      "writer.send('POST', `${base}/bookings`, {})",
      "writer.send('PATCH', '/bookings/1/cancel', {})",
      "writer.send('PUT', '/credits/grant', {})",
      "writer.send('POST', '/credits/grant/x', {})",
    ].join('\n'))
    // Line 10 (POST /credits/grant) is the seventh allowed write (TRIALREGRANT.1); the op and policy are checked elsewhere.
    expect(sendsOffAllowlist('x.js', sf)).toEqual(['x.js:7', 'x.js:8', 'x.js:9', 'x.js:11', 'x.js:12', 'x.js:13', 'x.js:14', 'x.js:15', 'x.js:16', 'x.js:17', 'x.js:18', 'x.js:19'])
  })

  it('sees a verb-first send in any file, but another send( only in a write-side file', () => {
    const sf = parse([
      "adapter.send(recipient, text, { locationId })",
      "send({ type: 'done' })",
      "res.send(body)",
      "other.send('POST', '/bookings', {})",
      "const { send } = writer; send('POST', '/bookings', { policy: 'verify', op: 'book' })",
    ].join('\n'))
    expect(writerSendCalls(sf, { writeSide: false }).map((c) => c.line)).toEqual([4, 5])
    expect(writerSendCalls(sf, { writeSide: true }).map((c) => c.line)).toEqual([1, 3, 4, 5])
  })

  it('reads a TypeScript cast or satisfies around the options', () => {
    const sf = parse("await writer.send('POST', '/bookings', ({ policy: 'verify', op: 'book' }) satisfies Opts)", 'x.ts')
    expect(sendsWithoutPolicy('x.ts', sf, OP_POLICY)).toEqual([])
  })

  it('reads the policy table off the AST', () => {
    const sf = parse("export const UN1T_OP_POLICY = Object.freeze({ book: 'verify', forgot_password: 'never' })")
    expect(frozenTable(sf, 'UN1T_OP_POLICY')).toEqual({ book: 'verify', forgot_password: 'never' })
  })
})

describe('the banned-name scanners (canaries)', () => {
  it('finds every banned endpoint in a string, a template or a regex, and none in a comment', () => {
    const sf = parse([
      "// '/credits/grant' and /refunds and charge-custom",
      "const a = '/credits/grant'",
      'const b = `/refunds/${id}`',
      'const c = /^\\/purchases\\/charge-custom\\/link$/',
      "const d = '/purchases/payment-sheet'",
      "const e = `/bookings/${id}/mark-attendance`",
      'const f = `/users/${id}/reset-password`',
      "const g = '/api/users/me/reset-password'",
      "const ok = '/reset-password'",
      "const ok2 = '/auth/forgot-password'",
    ].join('\n'))
    // '/credits/grant' (line 2) has its own fence below (TRIALREGRANT.1).
    expect(bannedEndpointHits('x.js', sf).map((h) => h.split(' ')[0])).toEqual(['x.js:3', 'x.js:4', 'x.js:5', 'x.js:6', 'x.js:7', 'x.js:8'])
  })

  it('/credits/grant stands only inside regrantTrialCredits in the ops module (and the transport ENDPOINTS table)', () => {
    const sf = parse([
      "const ENDPOINTS = [{ path: /^\\/credits\\/grant$/ }]",
      "async function regrantTrialCredits() { return writer.send('POST', '/credits/grant', {}) }",
      "async function grantTrial() { return '/credits/grant' }",
      "const top = `/credits/grant`",
      "// '/credits/grant' in a comment",
      "const regrantTrialCredits2 = () => '/credits/grant'",
    ].join('\n'))
    expect(creditsGrantOutsideRegrant('src/x.js', sf)).toEqual(['src/x.js:1', 'src/x.js:2', 'src/x.js:3', 'src/x.js:4', 'src/x.js:6'])
    expect(creditsGrantOutsideRegrant(OPS, sf)).toEqual([`${OPS}:1`, `${OPS}:3`, `${OPS}:4`, `${OPS}:6`])
    expect(creditsGrantOutsideRegrant(TRANSPORT, sf)).toEqual([`${TRANSPORT}:2`, `${TRANSPORT}:3`, `${TRANSPORT}:4`, `${TRANSPORT}:6`])
  })

  it('regrantTrialCredits is declared unexported in the ops module and called only inside grantTrial', () => {
    const sf = parse([
      'async function regrantTrialCredits() { return 1 }',
      'export async function grantTrial() { const go = async () => regrantTrialCredits(); return go() }',
      'export async function book() { return regrantTrialCredits() }',
      'export const x = { regrantTrialCredits }',
      "const name = 'regrantTrialCredits'",
      'export async function grantTrial2() { return [regrantTrialCredits].map((f) => f()) }',
    ].join('\n'))
    expect(regrantOutsideGrantTrial(OPS, sf)).toEqual([`${OPS}:3`, `${OPS}:4`, `${OPS}:5`, `${OPS}:6`])
    // In any other file every mention is a violation, its declaration and calls too.
    expect(regrantOutsideGrantTrial('src/lib/agent/x.js', sf)).toEqual(['src/lib/agent/x.js:1', 'src/lib/agent/x.js:2', 'src/lib/agent/x.js:3', 'src/lib/agent/x.js:4', 'src/lib/agent/x.js:5', 'src/lib/agent/x.js:6'])
    const exported = parse('export async function regrantTrialCredits() { return 1 }')
    expect(regrantOutsideGrantTrial(OPS, exported)).toEqual([`${OPS}:1`])
  })

  it('/purchases/charge stands only inside grantTrial (and the transport ENDPOINTS table)', () => {
    const sf = parse([
      "const ENDPOINTS = [{ path: /^\\/purchases\\/charge$/ }]",
      "async function grantTrial() { return writer.send('POST', '/purchases/charge', {}) }",
      "const grantTrial2 = () => '/purchases/charge'",
      "async function other() { return '/purchases/charge' }",
      "const top = '/purchases/charge'",
      "const grantTrialArrow = () => 1",
      "const grantTrial = async () => ({ p: `/purchases/charge` })",
    ].join('\n'))
    expect(chargeOutsideGrantTrial('src/x.js', sf)).toEqual(['src/x.js:1', 'src/x.js:3', 'src/x.js:4', 'src/x.js:5'])
    expect(chargeOutsideGrantTrial(TRANSPORT, sf)).toEqual(['src/lib/un1t-online-write.js:3', 'src/lib/un1t-online-write.js:4', 'src/lib/un1t-online-write.js:5'])
  })

  it('finds bypassCredit and forceRefund as a key, a shorthand, a property, a computed key and inside a string', () => {
    const sf = parse([
      "const BANNED_BODY_KEYS = Object.freeze(['bypassCredit', 'forceRefund'])",
      'const a = { forceRefund: true }',
      'const b = { bypassCredit }',
      "const c = { 'bypassCredit': 1 }",
      "const d = { ['forceRefund']: 1 }",
      'x.forceRefund = true',
      "JSON.parse('{\"forceRefund\":true}')",
      "const e = { ...body, bypassCredit: false }",
      "const fine = { bypass: 1, refund: 2 }",
    ].join('\n'))
    expect(bannedKeyHits('src/x.js', sf).map((h) => h.split(' ')[0])).toEqual(['src/x.js:1', 'src/x.js:1', 'src/x.js:2', 'src/x.js:3', 'src/x.js:4', 'src/x.js:5', 'src/x.js:6', 'src/x.js:7', 'src/x.js:8'])
    // In the transport, BANNED_BODY_KEYS is the one place they may stand.
    expect(bannedKeyHits(TRANSPORT, sf).map((h) => h.split(' ')[0]).map((h) => h.split(':')[1])).toEqual(['2', '3', '4', '5', '6', '7', '8'])
  })

  it('finds a PUT or DELETE verb literal and no other word', () => {
    const sf = parse([
      "// method: 'PUT'",
      "const a = { method: 'PUT' }",
      "const b = { method: 'delete' }",
      'const c = `DELETE ${path}`',
      "const d = 'POST'",
      "const e = 'Please delete the row'",
      "const f = 'computer input'",
      "const g = 'OUTPUT'",
    ].join('\n'))
    expect(writeVerbHits('x.js', sf)).toEqual(['x.js:2', 'x.js:3', 'x.js:4'])
  })

  it('finds any write verb literal', () => {
    const sf = parse(["const a = 'POST'", "const b = ['patch']", "const c = 'GET'", "const d = 'POSTAL'", "const e = { method: `DELETE` }"].join('\n'))
    expect(anyWriteVerbHits('x.js', sf)).toEqual(['x.js:1', 'x.js:2', 'x.js:5'])
  })

  it('finds _un1tWriteInternals as a name, a property, a string and a star re-export of the transport', () => {
    const sf = parse([
      "import { _un1tWriteInternals } from './un1t-online-write.js'",
      'const { result } = mod._un1tWriteInternals',
      "const k = '_un1tWriteInternals'",
      "export * from './un1t-online-write.js'",
      "export * from './un1t-online-write'",
      "export * from './other.js'",
      "// _un1tWriteInternals",
    ].join('\n'))
    expect(internalsHits('x.js', sf)).toEqual(['x.js:1', 'x.js:2', 'x.js:3', 'x.js:4 (export * from the transport)', 'x.js:5 (export * from the transport)'])
  })

  it('an unsynced scan of a file that names none of it is empty', () => {
    const sf = parse("export const a = 1\nexport function grantTrial() { return 'x' }")
    expect(bannedEndpointHits('x.js', sf)).toEqual([])
    expect(chargeOutsideGrantTrial('x.js', sf)).toEqual([])
    expect(bannedKeyHits('x.js', sf)).toEqual([])
    expect(writeVerbHits('x.js', sf)).toEqual([])
    expect(internalsHits('x.js', sf)).toEqual([])
  })
})

// ── The real tree ──────────────────────────────────────────────────────────
describe('UN1TWRITE.7 — the sync cannot write', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  const present = [...SYNC_SIDE_REQUIRED, ...SYNC_SIDE_WHEN_PRESENT.filter((k) => realIo.exists(k))]

  it('every sync-side file the fence lists exists (a renamed file does not slip out of the fence)', () => {
    expect(SYNC_SIDE_REQUIRED.filter((k) => !realIo.exists(k))).toEqual([])
  })

  it('no sync-side module imports un1t-online-write, -write-ops, -write-ledger, -write-judge or -mirror-write, transitively', () => {
    expect(fenceBreaches(present, realIo)).toEqual([])
  })

  it('the walk resolves every relative and @/ import it meets (an import it cannot follow is a hole in the fence)', () => {
    expect(walkImports(present, realIo).unresolved).toEqual([])
  })

  it('the walk is not vacuous: it reaches the sync, its read client and more than the entry files', () => {
    const { chains } = walkImports(present, realIo)
    expect(chains.has('src/lib/un1t-online.js')).toBe(true)
    expect(chains.has('src/lib/un1t-online-sync.js')).toBe(true)
    expect(chains.size).toBeGreaterThan(present.length)
  })

  it('the fence is aimed at real files: the write modules exist and a write-side file does reach the transport', () => {
    for (const k of [TRANSPORT, OPS, 'src/lib/un1t-online-write-ledger.js', 'src/lib/un1t-online-write-judge.js', 'src/lib/un1t-online-mirror-write.js']) {
      expect(realIo.exists(k), k).toBe(true)
      expect(isWriteModule(k), k).toBe(true)
    }
    expect(fenceBreaches([OPS], realIo).length).toBeGreaterThan(0)
  })

  it('src/lib/un1t-online.js still has no write verb', () => {
    const text = realIo.read('src/lib/un1t-online.js')
    expect(text).toBeTruthy()
    expect(anyWriteVerbHits('src/lib/un1t-online.js', parse(text, 'un1t-online.js'))).toEqual([])
  })
})

// UN1TWRITE.8 — the refund card is RECORD-ONLY. A refund is never moved by the
// CRM (no /refunds endpoint, no forceRefund): fileRefundCard only files a card
// and the approval route only closes it. So un1t-online-approval.js (the walked
// entry; the route itself imports Glofox for other kinds and is not walked) may
// not reach the write transport, its ops, its ledger or the mirror, however
// many imports deep, and may not name a Glofox or un1t.online client. Task 23 adds the booking
// executor to un1t-online-approval.js; when it does, the refund entry below
// moves to its own file (or this walk becomes a per-function check) so the
// executor can import the ops while the refund path still cannot.
describe('UN1TWRITE.8 — the refund path is record-only', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  const REFUND_ENTRIES = ['src/lib/un1t-online-approval.js']

  it('the refund entry exists (a rename does not slip out of the fence)', () => {
    for (const k of REFUND_ENTRIES) expect(realIo.exists(k), k).toBe(true)
  })

  it('un1t-online-approval.js reaches no write module (transport, ops, ledger, judge, mirror), transitively', () => {
    expect(fenceBreaches(REFUND_ENTRIES, realIo)).toEqual([])
  })

  it('the walk resolves every import it meets, and is not vacuous', () => {
    const { chains, unresolved } = walkImports(REFUND_ENTRIES, realIo)
    expect(unresolved).toEqual([])
    expect(chains.size).toBeGreaterThan(REFUND_ENTRIES.length)
  })

  it('it imports no Glofox or un1t.online client either', () => {
    const { chains } = walkImports(REFUND_ENTRIES, realIo)
    const clients = [...chains.keys()].filter((k) => /(^|\/)(glofox|un1t-online)(\.|-(?!approval))[^/]*$/.test(k) && isScanned(k))
    expect(clients).toEqual([])
  })

  it('the fence is aimed at a real walker: an import of the ops from the approval file would be caught', () => {
    const io = {
      exists: realIo.exists,
      read: (k) => (k === 'src/lib/un1t-online-approval.js' ? "import { x } from '@/lib/un1t-online-write-ops'" : realIo.read(k)),
    }
    expect(fenceBreaches(REFUND_ENTRIES, io)).toContain('src/lib/un1t-online-approval.js -> src/lib/un1t-online-write-ops.js')
  })
})

describe('UN1TWRITE.7 — the write side cannot misbehave', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  const writeSideFile = (entry) => isWriteModule(entry.key) || /un1t-online-write/.test(entry.text.split('\n').filter((l) => /^\s*(import|export)\b|\bfrom\s+['"]|\bimport\(|\brequire\(/.test(l)).join('\n'))
  const sendFiles = () => filesMentioning(/\bsend\b/)
  const policyTable = () => frozenTable(parsedFile(allSources().find((e) => e.key === TRANSPORT)), 'UN1T_OP_POLICY')

  it('the policy table is the one the spec fixes: book, cancel, create_client verify; forgot_password, trial, trial_regrant never; checkout, fee_charge idempotent', () => {
    expect(policyTable()).toEqual({
      book: 'verify', cancel: 'verify', create_client: 'verify', forgot_password: 'never', trial: 'never', checkout: 'idempotent', trial_regrant: 'never',
      fee_charge: 'idempotent',
    })
  })

  it("every send( call in src/ passes a policy that is the literal 'verify', 'never' or 'idempotent', and its op's own", () => {
    const table = policyTable()
    const bad = sendFiles().flatMap((e) => sendsWithoutPolicy(e.key, e.sf, table, { writeSide: writeSideFile(e) }))
    expect(bad).toEqual([])
  })

  it("every send( call's method and path template is one of the eight allowed writes", () => {
    const bad = sendFiles().flatMap((e) => sendsOffAllowlist(e.key, e.sf, { writeSide: writeSideFile(e) }))
    expect(bad).toEqual([])
  })

  it('the scan really sees the ops module\'s nine sends (an empty result is not a broken scanner)', () => {
    const ops = sendFiles().find((e) => e.key === OPS)
    expect(ops).toBeTruthy()
    const calls = writerSendCalls(ops.sf, { writeSide: true })
    expect(calls.map((c) => `${c.verb} ${c.path}`).sort()).toEqual([
      'PATCH /bookings/:id/cancel', 'POST /auth/forgot-password', 'POST /bookings', 'POST /credits/grant', 'POST /purchases/charge',
      'POST /purchases/charge-custom', 'POST /purchases/checkout', 'POST /purchases/checkout', 'POST /users/clients',
    ])
    // FEES.1: the class fee is op fee_charge, re-sent only with its own key.
    const fee = calls.filter((c) => c.op === 'fee_charge')
    expect(fee.map((c) => `${c.verb} ${c.path} ${c.policy}`)).toEqual(['POST /purchases/charge-custom idempotent'])
    // TRIALREGRANT.1: the credit re-grant is op trial_regrant, never re-sent.
    const regrant = calls.filter((c) => c.op === 'trial_regrant')
    expect(regrant.map((c) => `${c.verb} ${c.path} ${c.policy}`)).toEqual(['POST /credits/grant never'])
    expect(calls.every((c) => c.optsReadable && c.op != null && c.policy != null)).toBe(true)
    // UN1TWRITE.10: the trial's charge and free checkout are op trial, never re-sent.
    const trial = calls.filter((c) => c.op === 'trial')
    expect(trial.map((c) => `${c.verb} ${c.path}`).sort()).toEqual(['POST /purchases/charge', 'POST /purchases/checkout'])
    expect(trial.every((c) => c.policy === 'never')).toBe(true)
  })

  it("the transport's own allowlist is pinned: exactly the eight writes, and the banned body keys it refuses", () => {
    const sf = parsedFile(allSources().find((e) => e.key === TRANSPORT))
    const entries = []
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ENDPOINTS') {
        let init = unwrap(node.initializer)
        if (ts.isCallExpression(init)) init = unwrap(init.arguments[0])
        for (const el of init.elements) {
          const prop = (k) => el.properties.find((p) => propName(p) === k)?.initializer
          const m = prop('method')
          const p = prop('path')
          entries.push(`${m.text} ${p.text.slice(1, -1).replace(/\\\//g, '/').replace(/^\^|\$$/g, '').replace(/\[A-Za-z0-9\]\[A-Za-z0-9_-\]\*/, ':id')}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(entries).toEqual(ALLOWED_WRITES)
    const banned = []
    const visit2 = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'BANNED_BODY_KEYS') {
        let init = unwrap(node.initializer)
        if (ts.isCallExpression(init)) init = unwrap(init.arguments[0])
        banned.push(...init.elements.map((e) => e.text))
      }
      ts.forEachChild(node, visit2)
    }
    visit2(sf)
    expect(banned).toEqual(['bypassCredit', 'forceRefund', 'promoCode'])
  })

  it('/purchases/charge appears only inside the function grantTrial (and the transport allowlist)', () => {
    const bad = filesMentioning(/purchases(\/|\\\/)charge/).flatMap((e) => chargeOutsideGrantTrial(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('/refunds, charge-custom/link, payment-sheet, mark-attendance and /users/{id}/reset-password appear nowhere in src/ outside tests', () => {
    const bad = filesMentioning(/\/refunds|charge-custom\/link|payment-sheet|mark-attendance|reset-password/)
      .flatMap((e) => bannedEndpointHits(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('FEES.1: charge-custom appears only inside chargeClassFee in the ops module (and the transport allowlist), and it is there', () => {
    const files = filesMentioning(/charge-custom/)
    expect(files.flatMap((e) => chargeCustomOutsideFee(e.key, e.sf))).toEqual([])
    const ops = files.find((e) => e.key === OPS)
    expect(ops).toBeTruthy()
    expect(literalHits(ops.sf, /charge-custom/).some((h) => h.chain.includes('chargeClassFee'))).toBe(true)
  })

  it('TRIALREGRANT.1: /credits/grant appears only inside regrantTrialCredits in the ops module (and the transport allowlist), and it is there', () => {
    const files = filesMentioning(/credits(\/|\\\/)grant/)
    expect(files.flatMap((e) => creditsGrantOutsideRegrant(e.key, e.sf))).toEqual([])
    const ops = allSources().find((e) => e.key === OPS)
    expect(literalHits(parsedFile(ops), /credits\/grant/).filter((h) => h.chain.includes('regrantTrialCredits')).length).toBeGreaterThan(0)
  })

  it('TRIALREGRANT.1: regrantTrialCredits is unexported, declared in the ops module and called only from grantTrial', () => {
    const files = filesMentioning(/regrantTrialCredits/)
    expect(files.map((e) => e.key)).toContain(OPS)
    expect(files.flatMap((e) => regrantOutsideGrantTrial(e.key, e.sf))).toEqual([])
    const ops = parsedFile(allSources().find((e) => e.key === OPS))
    const calls = []
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'regrantTrialCredits') calls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(ops)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('no un1t.online module names reset-password at all (a path built by concatenation would slip the pattern above)', () => {
    const bad = filesMentioning(/reset-password/).filter((e) => /(^|\/)un1t-online/.test(e.key))
      .flatMap((e) => literalHits(e.sf, /reset-password/).map((h) => `${e.key}:${h.line}`))
    expect(bad).toEqual([])
  })

  it('no object literal in src/ outside tests has a key bypassCredit or forceRefund (the transport only lists them in BANNED_BODY_KEYS)', () => {
    const bad = filesMentioning(/bypassCredit|forceRefund/).flatMap((e) => bannedKeyHits(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('promoCode is never a name or key in an un1t.online module (the transport only lists it in BANNED_BODY_KEYS)', () => {
    const bad = filesMentioning(/promoCode/).filter((e) => /(^|\/)un1t-online/.test(e.key))
      .flatMap((e) => bannedKeyHits(e.key, e.sf, ['promoCode']))
    expect(bad).toEqual([])
  })

  it("src/lib/un1t-online-write*.js (and the mirror) contain no 'PUT' or 'DELETE' verb literal", () => {
    const files = allSources().filter((e) => isWriteModule(e.key))
    expect(files.map((e) => e.key)).toEqual(expect.arrayContaining([TRANSPORT, OPS, 'src/lib/un1t-online-write-ledger.js', 'src/lib/un1t-online-write-judge.js', 'src/lib/un1t-online-mirror-write.js']))
    const bad = files.flatMap((e) => writeVerbHits(e.key, parsedFile(e)))
    expect(bad).toEqual([])
  })

  it('only un1t-online-write-ops.js imports _un1tWriteInternals (the transport defines it; nothing else names it)', () => {
    const bad = filesMentioning(/_un1tWriteInternals|un1t-online-write/)
      .filter((e) => e.key !== TRANSPORT && e.key !== OPS)
      .flatMap((e) => internalsHits(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('the internals guard is aimed at real code: the transport exports _un1tWriteInternals and the ops module imports it', () => {
    const t = allSources().find((e) => e.key === TRANSPORT)
    const o = allSources().find((e) => e.key === OPS)
    expect(internalsHits(TRANSPORT, parsedFile(t)).length).toBeGreaterThan(0)
    expect(internalsHits(OPS, parsedFile(o)).length).toBeGreaterThan(0)
    expect(o.text).toMatch(/import\s*\{[^}]*\b_un1tWriteInternals\b[^}]*\}\s*from\s*'\.\/un1t-online-write\.js'/)
  })
})
