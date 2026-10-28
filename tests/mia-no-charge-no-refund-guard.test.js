// MIAHATCH.6 (Task 21) — Mia never charges and never refunds (spec R1, R2;
// global constraints): no code sends bypassCredit or forceRefund, calls a
// refund endpoint, POST /purchases/charge (the €0 trial) lives only in D's
// write modules, reached by Mia through grantTrial, and /credits/grant
// (TRIALREGRANT.1, Richard's decision 20 Oct 2026: the one-off trial credit
// re-grant) stands only inside regrantTrialCredits in D's ops module (and the
// transport's ENDPOINTS allowlist), which only grantTrial calls, and inside
// grantCompCredits (UN1TCOMP.1, Richard's decision 28 Oct 2026: staff's
// complimentary credits), which no agent module may import, name or reach
// through the 'comp_credits' op.
// A refund is a record-only refund_request card (fileRefundCard) that staff
// act on by hand in un1t.online.
//
// What is scanned: every .js/.jsx/.mjs/.ts/.tsx file under src/, shared/ and
// supabase/functions/ except tests and test helpers. Files are parsed with the TypeScript parser and only
// identifiers and string, template and regex literals are read, so prose in a
// comment ("never forceRefund", "no /refunds") is not a violation, and a
// function or kind NAMED for refunds (fileRefundCard, 'refund_request',
// request_refund) is not one either: the refund rule is an ENDPOINT PATH, a
// literal holding a `/refund` or `/refunds` path segment.
//
// The one place a refund path legitimately appears in src/ today is the
// CRM's own shop orders (Revolut's order refund API and the staff orders
// route that wraps it). That has nothing to do with un1t.online, so it is
// allowlisted BY FILE, with a reason; an allowlisted file may never be a
// un1t.online, agent or purchase module, and an entry that stops matching
// fails as stale.
//
// A FLOOR, NOT A PROOF: a path built by concatenation ('/re' + 'fund') or a
// key reached through a variable is not seen. tests/un1t-online-write-guard
// pins the write transport itself (its endpoint table and banned body keys);
// this file pins Mia's side of R1/R2 across the whole tree.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = Object.freeze(['src', 'shared', 'supabase/functions'].map((d) => path.join(ROOT, d)))
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')
const WHOLE_TREE_TIMEOUT_MS = 120_000

const TRANSPORT = 'src/lib/un1t-online-write.js'
const OPS = 'src/lib/un1t-online-write-ops.js'
/** D's write modules: the only files that may name POST /purchases/charge. */
const CHARGE_ALLOWED_IN = Object.freeze([TRANSPORT, OPS])
/** The only declaration that may name the banned body keys: the transport's own refusal list. */
const BANNED_KEYS = Object.freeze(['forceRefund', 'bypassCredit'])
const BANNED_KEYS_DECLARED_IN = { file: TRANSPORT, name: 'BANNED_BODY_KEYS' }

// A literal whose text holds a /refund or /refunds PATH SEGMENT, in any case:
// followed by the end, a slash, a query or a fragment. '/refunded' and
// 'refund_request' are not paths.
const REFUND_PATH = /\/refunds?(?=$|[/?#])/i
const CREDITS_GRANT = /\/credits\/grant/
const PURCHASES_CHARGE = /\/purchases\/charge/

// Files outside un1t.online that name a refund endpoint, and why.
const REFUND_PATH_ALLOWED = Object.freeze({
  'src/lib/revolut.js': 'Revolut Merchant API order refund for the CRM shop (orders), not un1t.online.',
  'src/components/OrdersTable.jsx': 'Staff orders table calling the CRM\'s own /api/orders/[id]/refund route (Revolut), not un1t.online.',
})
// Paths that may never hold an allowlisted refund path: un1t.online, Mia and the purchase flow.
const NEVER_ALLOWLISTED = /un1t|\/agent\/|purchase|pay-done|mia/i

// Mia's agent modules may take only these from D's write ops (no charge, no client writes).
const AGENT_DIR = 'src/lib/agent/'
// moveBooking (UN1TMOVE.1): a reschedule in one call. It charges and refunds
// nothing: POST /bookings/{id}/move { eventId }, and un1t.online carries the credit over.
const AGENT_OPS_ALLOWED = Object.freeze(['book', 'cancel', 'moveBooking', 'createCheckoutLink', 'grantTrial'])
// UN1TCOMP.1 — staff's complimentary credits are never Mia's: no agent module
// names the primitive (anywhere in an identifier or a literal) or its op (as a
// whole word: the customer_agent setting comp_credits_confirmation_text is
// copy the card sends, not the op).
const AGENT_NEVER_NAMES = Object.freeze([
  Object.freeze({ name: 'grantCompCredits', re: /grantCompCredits/ }),
  Object.freeze({ name: 'comp_credits', re: /(^|[^A-Za-z0-9_])comp_credits(?![A-Za-z0-9_])/ }),
])

// ── Parsing ────────────────────────────────────────────────────────────────
const parse = (text, file = 'scan.jsx') => {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}
const isScanned = (file) => /\.(m?js|jsx|ts|tsx)$/.test(file) && !/\.d\.ts$/.test(file) && !/\.test\.|\.test-helpers?\./.test(file)
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/** A string, template (with `${}` for each hole) or regex literal's text; null for anything else. */
function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => '${}' + s.literal.text).join('')
  if (ts.isRegularExpressionLiteral(node)) return node.text.replace(/\\\//g, '/')
  return null
}

/** The variable names a node sits inside (the declaration a table is assigned to). */
function enclosingVariables(node) {
  const names = []
  for (let n = node.parent; n; n = n.parent) if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.push(n.name.text)
  return names
}

/** The function and variable names a node sits inside (innermost first). */
function enclosingNames(node) {
  const names = []
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) names.push(n.name.text)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.push(n.name.text)
  }
  return names
}

/** Literals whose text matches `re`: [{ line, text, names }]. */
export function literalHits(sf, re) {
  const out = []
  const visit = (node) => {
    const text = literalText(node)
    if (text != null && re.test(text)) out.push({ line: lineOf(sf, node), text, names: enclosingNames(node) })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Identifiers equal to, and literals containing, one of `names`: [{ line, name, vars }]. */
export function nameHits(sf, names) {
  const out = []
  const visit = (node) => {
    if (ts.isIdentifier(node) && names.includes(node.text)) out.push({ line: lineOf(sf, node), name: node.text, vars: enclosingVariables(node) })
    else {
      const text = literalText(node)
      if (text != null) for (const name of names) if (text.includes(name)) out.push({ line: lineOf(sf, node), name, vars: enclosingVariables(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Names a file imports from D's write ops: [{ line, name }] (a namespace import is '*'). */
export function opsImports(sf) {
  const out = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && /(^|\/)un1t-online-write-ops(\.js)?$/.test(node.moduleSpecifier.text)) {
      const clause = node.importClause
      if (clause?.name) out.push({ line: lineOf(sf, node), name: 'default' })
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) out.push({ line: lineOf(sf, node), name: '*' })
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) out.push({ line: lineOf(sf, node), name: (el.propertyName ?? el.name).text })
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && /un1t-online-write-ops/.test(node.arguments[0].text)) {
      out.push({ line: lineOf(sf, node), name: 'import()' })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ── The rules (pure: a parsed file in, violations out) ─────────────────────
export function bannedKeyViolations(key, sf) {
  return nameHits(sf, BANNED_KEYS)
    .filter((h) => !(key === BANNED_KEYS_DECLARED_IN.file && h.vars.includes(BANNED_KEYS_DECLARED_IN.name)))
    .map((h) => `${key}:${h.line} (${h.name})`)
}
// TRIALREGRANT.1 / UN1TCOMP.1 — /credits/grant only inside D's
// regrantTrialCredits and grantCompCredits, and in the transport's ENDPOINTS
// allowlist.
const CREDITS_GRANT_ALLOWED = Object.freeze({ [OPS]: Object.freeze(['regrantTrialCredits', 'grantCompCredits']), [TRANSPORT]: Object.freeze(['ENDPOINTS']) })
export function creditsGrantViolations(key, sf) {
  const within = Object.hasOwn(CREDITS_GRANT_ALLOWED, key) ? CREDITS_GRANT_ALLOWED[key] : []
  return literalHits(sf, CREDITS_GRANT)
    .filter((h) => !within.some((w) => h.names.includes(w)))
    .map((h) => `${key}:${h.line} (/credits/grant)`)
}
/** UN1TCOMP.1 — "line N" of each identifier or literal in an agent module naming staff's complimentary credits. */
export function agentCompViolations(key, sf) {
  if (!key.startsWith(AGENT_DIR)) return []
  const out = []
  const visit = (node) => {
    const text = ts.isIdentifier(node) ? node.text : literalText(node)
    if (text != null) for (const { name, re } of AGENT_NEVER_NAMES) if (re.test(text)) out.push(`${key}:${lineOf(sf, node)} (${name})`)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
export function refundPathViolations(key, sf) {
  if (Object.hasOwn(REFUND_PATH_ALLOWED, key)) return []
  return literalHits(sf, REFUND_PATH).map((h) => `${key}:${h.line} (refund endpoint)`)
}
export function chargeViolations(key, sf) {
  if (CHARGE_ALLOWED_IN.includes(key)) return []
  return literalHits(sf, PURCHASES_CHARGE).map((h) => `${key}:${h.line} (/purchases/charge)`)
}
export function agentOpsViolations(key, sf) {
  if (!key.startsWith(AGENT_DIR)) return []
  return opsImports(sf).filter((i) => !AGENT_OPS_ALLOWED.includes(i.name)).map((i) => `${key}:${i.line} (${i.name})`)
}

// ── The tree, read once ────────────────────────────────────────────────────
function sourceFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '__tests__', '.next', 'ios', 'android', 'dist'].includes(entry.name)) continue
      out.push(...sourceFiles(full))
    } else if (isScanned(entry.name)) out.push(full)
  }
  return out
}
let tree = null
function sources() {
  if (!tree) tree = SCAN_DIRS.flatMap((dir) => sourceFiles(dir)).map((file) => ({ key: rel(file), text: fs.readFileSync(file, 'utf8'), file }))
  return tree
}
const parsedCache = new Map()
/** Parse only files whose raw text mentions a needle (a file that never names it cannot hold it). */
function mentioning(re) {
  return sources().filter(({ text }) => re.test(text)).map((e) => {
    if (!parsedCache.has(e.key)) parsedCache.set(e.key, parse(e.text, e.file))
    return { ...e, sf: parsedCache.get(e.key) }
  })
}

// ── The rules on fixtures (each rule can fail) ─────────────────────────────
describe('the rules, on fixtures', () => {
  it('banned body keys: as a key, a name or inside a string; only the transport\'s BANNED_BODY_KEYS may hold them', () => {
    const sf = parse([
      "const body = { forceRefund: true }",
      "send({ bypassCredit: 1 })",
      "const k = 'forceRefund'",
      "const BANNED_BODY_KEYS = Object.freeze(['bypassCredit', 'forceRefund'])",
      "// a comment saying forceRefund is fine",
    ].join('\n'))
    expect(bannedKeyViolations('src/x.js', sf).map((v) => v.split(' ')[0])).toEqual(['src/x.js:1', 'src/x.js:2', 'src/x.js:3', 'src/x.js:4', 'src/x.js:4'])
    expect(bannedKeyViolations(TRANSPORT, sf).map((v) => v.split(' ')[0])).toEqual([`${TRANSPORT}:1`, `${TRANSPORT}:2`, `${TRANSPORT}:3`])
  })

  it('refund endpoint paths: a /refund or /refunds segment in a string, template or regex; names and kinds are not paths', () => {
    const sf = parse([
      "post('/refund', {})",
      "fetch(`/api/orders/${id}/refund`)",
      "const p = '/v1/refunds?x=1'",
      "const r = /\\/refunds\\//",
      "const kind = 'refund_request'",
      "fileRefundCard(db, { reason: 'double_payment' })",
      "const s = 'completed/refunded'",
      "// POST /refund in a comment",
      "const t = 'request_refund'",
      "post('/v1/Refunds/' + id)",
    ].join('\n'))
    expect(refundPathViolations('src/x.js', sf).map((v) => v.split(' ')[0])).toEqual(['src/x.js:1', 'src/x.js:2', 'src/x.js:3', 'src/x.js:4', 'src/x.js:10'])
    expect(refundPathViolations('src/lib/revolut.js', sf)).toEqual([])
  })

  it('/credits/grant outside D\'s regrantTrialCredits and grantCompCredits (and the transport allowlist), and /purchases/charge outside D\'s write modules', () => {
    const sf = parse("send('POST', '/credits/grant')\nsend('POST', '/purchases/charge')\nconst u = `/purchases/charge`")
    expect(creditsGrantViolations('src/x.js', sf)).toEqual(['src/x.js:1 (/credits/grant)'])
    const grant = parse([
      "async function regrantTrialCredits() { return send('POST', '/credits/grant') }",
      "async function grantTrial() { return send('POST', '/credits/grant') }",
      "const ENDPOINTS = [{ path: /^\\/credits\\/grant$/ }]",
      "export async function grantCompCredits() { return send('POST', '/credits/grant') }",
    ].join('\n'))
    expect(creditsGrantViolations(OPS, grant).map((v) => v.split(' ')[0])).toEqual([`${OPS}:2`, `${OPS}:3`])
    expect(creditsGrantViolations(TRANSPORT, grant).map((v) => v.split(' ')[0])).toEqual([`${TRANSPORT}:1`, `${TRANSPORT}:2`, `${TRANSPORT}:4`])
    expect(creditsGrantViolations('src/lib/agent/x.js', grant)).toHaveLength(4)
    expect(chargeViolations('src/lib/agent/x.js', sf).map((v) => v.split(' ')[0])).toEqual(['src/lib/agent/x.js:2', 'src/lib/agent/x.js:3'])
    expect(chargeViolations(OPS, sf)).toEqual([])
    expect(chargeViolations(TRANSPORT, sf)).toEqual([])
  })

  it('Mia\'s agent modules import only book, cancel, createCheckoutLink and grantTrial from D\'s write ops', () => {
    const sf = parse([
      "import { book, createClient as mk } from '@/lib/un1t-online-write-ops'",
      "import * as ops from '@/lib/un1t-online-write-ops'",
      "const m = await import('@/lib/un1t-online-write-ops')",
      "import { grantTrial } from '@/lib/un1t-online-write-ops'",
    ].join('\n'))
    expect(agentOpsViolations('src/lib/agent/x.js', sf)).toEqual(['src/lib/agent/x.js:1 (createClient)', 'src/lib/agent/x.js:2 (*)', 'src/lib/agent/x.js:3 (import())'])
    expect(agentOpsViolations('src/app/api/x/route.js', sf)).toEqual([])
    // UN1TCOMP.1: staff's complimentary credits are never on the agent's list.
    expect(AGENT_OPS_ALLOWED).not.toContain('grantCompCredits')
    const comp = parse("import { grantCompCredits } from '@/lib/un1t-online-write-ops'")
    expect(agentOpsViolations('src/lib/agent/x.js', comp)).toEqual(['src/lib/agent/x.js:1 (grantCompCredits)'])
  })

  it('UN1TCOMP.1: an agent module naming grantCompCredits or the comp_credits op, in code or a string', () => {
    const sf = parse([
      'const f = ops.grantCompCredits',
      "const op = 'comp_credits'",
      '// grantCompCredits in a comment',
      "const fine = 'book'",
      "const copy = 'comp_credits_confirmation_text'",
      "const q = `op = comp_credits`",
    ].join('\n'))
    expect(agentCompViolations('src/lib/agent/x.js', sf)).toEqual(['src/lib/agent/x.js:1 (grantCompCredits)', 'src/lib/agent/x.js:2 (comp_credits)', 'src/lib/agent/x.js:6 (comp_credits)'])
    expect(agentCompViolations('src/app/api/un1t-online/credits/comp/route.js', sf)).toEqual([])
  })

  it('the refund allowlist names only files outside un1t.online, Mia and the purchase flow', () => {
    for (const key of Object.keys(REFUND_PATH_ALLOWED)) expect(key).not.toMatch(NEVER_ALLOWLISTED)
  })
})

// ── The tree ───────────────────────────────────────────────────────────────
describe('src/, shared/ and supabase/functions/ (non-test)', { timeout: WHOLE_TREE_TIMEOUT_MS }, () => {
  it('reads all three trees', () => {
    for (const dir of ['src/', 'shared/', 'supabase/functions/']) expect(sources().some((e) => e.key.startsWith(dir)), dir).toBe(true)
  })

  it('no forceRefund or bypassCredit outside the transport\'s refusal list', () => {
    const bad = mentioning(/forceRefund|bypassCredit/).flatMap((e) => bannedKeyViolations(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('/credits/grant only inside D\'s regrantTrialCredits and grantCompCredits (and the transport allowlist)', () => {
    const bad = mentioning(/credits(\/|\\\/)grant/).flatMap((e) => creditsGrantViolations(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('UN1TCOMP.1: no agent module names grantCompCredits or the comp_credits op', () => {
    const bad = mentioning(/grantCompCredits|comp_credits/).flatMap((e) => agentCompViolations(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('no refund endpoint path (the CRM shop\'s Revolut order refund aside)', () => {
    const bad = mentioning(/refund/i).flatMap((e) => refundPathViolations(e.key, e.sf))
    expect(bad).toEqual([])
  })

  it('every refund allowlist entry still names a refund path (no stale entries)', () => {
    for (const key of Object.keys(REFUND_PATH_ALLOWED)) {
      const entry = sources().find((e) => e.key === key)
      expect(entry, `${key} is gone: drop it from REFUND_PATH_ALLOWED`).toBeTruthy()
      expect(literalHits(parse(entry.text, entry.file), REFUND_PATH).length, `${key} no longer names a refund path`).toBeGreaterThan(0)
    }
  })

  it('/purchases/charge only in D\'s write modules (grantTrial)', () => {
    const bad = mentioning(/purchases(\/|\\\/)charge/).flatMap((e) => chargeViolations(e.key, e.sf))
    expect(bad).toEqual([])
    // ...and it is there: the €0 trial's one charge path.
    const ops = sources().find((e) => e.key === OPS)
    expect(literalHits(parse(ops.text, ops.file), PURCHASES_CHARGE).length).toBeGreaterThan(0)
  })

  it('Mia\'s agent modules reach D\'s write ops only for book, cancel, createCheckoutLink and grantTrial', () => {
    const bad = mentioning(/un1t-online-write-ops/).flatMap((e) => agentOpsViolations(e.key, e.sf))
    expect(bad).toEqual([])
  })
})
