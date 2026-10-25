// MIAORG.1 guard — Mia's settings have ONE reader. A studio's effective
// settings are DEFAULTS <- org_settings.customer_agent <- the studio's own
// locations.settings.customer_agent, merged by resolveAgentSettings
// (src/lib/agent/settings-resolve.js), which also keeps the studio-only keys
// (enabled, test_mode, the booking/membership links …) from ever coming from
// the organisation. A module that reads `customer_agent` off a settings object
// itself skips the org layer (an org-wide value silently never reaches it) and
// the studio-only fence.
//
// This fails on any `customer_agent` property READ in non-test src/:
// `x.customer_agent`, `x?.customer_agent`, `x['customer_agent']`, and a
// destructuring of the key (any layout: `{ customer_agent } = x`, nested,
// defaulted, multi-line, a parameter, an assignment pattern). Allowed, by path:
//   - src/lib/agent/settings-resolve.js   (the resolver)
//   - src/lib/agent/settings-contract.js  (the contract: schema, DEFAULTS, the writer)
//   - src/app/api/settings/customer-agent/** (the settings editor's GET/PUT,
//     which read and write the stored layer itself)
// Read through resolveAgentSettings(db, locationId) or, holding a locations
// row with organization_id, resolveAgentSettingsForLocation(db, row, { orgCache }).
//
// A floor, not a proof: it walks the TypeScript AST (comments and strings are
// never code), but a read through a computed
// key held in a variable, or one in mobile/ or shared/, is invisible to it.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')

const ALLOWED = [
  'src/lib/agent/settings-resolve.js',
  'src/lib/agent/settings-contract.js',
]
const ALLOWED_DIRS = ['src/app/api/settings/customer-agent/']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|tsx?)$/.test(name) && !/\.test\.(m?js|jsx|tsx?)$|\.test-helpers\.(m?js|jsx|tsx?)$/.test(name)) out.push(full)
  }
  return out
}

// An AST walk (the TypeScript parser the shared comment stripper already
// uses), so comments and strings are never code, and a destructuring is seen
// whatever its layout: multi-line, nested, with a default, in a parameter or
// an assignment pattern.
const KEY = 'customer_agent'
const nameIs = (n) => !!n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isPrivateIdentifier(n)) && n.text === KEY

// An object literal that is (part of) the left side of `=`: `({ customer_agent } = x)`.
function isAssignmentTarget(node) {
  let child = node
  let p = node.parent
  while (p && (ts.isParenthesizedExpression(p) || ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
    || ts.isObjectLiteralExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p))) {
    child = p
    p = p.parent
  }
  return !!p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === child
}

export function customerAgentReads(src, file = 'scan.jsx') {
  const kind = /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.TSX
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
  const hits = []
  const hit = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    hits.push({ line: line + 1, text: node.getText(sf).split('\n')[0].trim() })
  }
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && nameIs(node.name)) hit(node)                 // x.customer_agent, x?.customer_agent
    else if (ts.isElementAccessExpression(node) && nameIs(node.argumentExpression)) hit(node) // x['customer_agent']
    else if (ts.isBindingElement(node) && (nameIs(node.propertyName) || (!node.propertyName && nameIs(node.name)))) hit(node) // const { customer_agent } = x
    else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && nameIs(node.name)
      && ts.isObjectLiteralExpression(node.parent) && isAssignmentTarget(node.parent)) hit(node) // ({ customer_agent } = x)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

describe('the matcher', () => {
  it('flags member, optional, bracket and destructuring reads', () => {
    expect(customerAgentReads('const s = loc.settings.customer_agent')).toHaveLength(1)
    expect(customerAgentReads('const s = loc?.settings?.customer_agent || null')).toHaveLength(1)
    expect(customerAgentReads("const s = settings['customer_agent']")).toHaveLength(1)
    expect(customerAgentReads('const { customer_agent } = loc.settings')).toHaveLength(1)
    expect(customerAgentReads('const { customer_agent: ca, other } = settings')).toHaveLength(1)
  })
  it('flags destructuring whatever its layout (multi-line, nested, defaulted, parameter, assignment)', () => {
    expect(customerAgentReads('const {\n  customer_agent,\n} = loc.settings')).toHaveLength(1)
    expect(customerAgentReads('const { settings: { customer_agent } } = loc')).toHaveLength(1)
    expect(customerAgentReads('const { customer_agent = {} } = s')).toHaveLength(1)
    expect(customerAgentReads('function f({ customer_agent }) { return customer_agent }')).toHaveLength(1)
    expect(customerAgentReads('let ca; ({ customer_agent: ca } = settings)')).toHaveLength(1)
    expect(customerAgentReads('const s = loc\n  .settings\n  .customer_agent')).toHaveLength(1)
  })
  it('ignores comments, select strings and object-literal keys', () => {
    expect(customerAgentReads('// reads settings.customer_agent.tone')).toEqual([])
    expect(customerAgentReads('/* settings.customer_agent */ const a = 1')).toEqual([])
    expect(customerAgentReads('const a = 1 // settings.customer_agent')).toEqual([])
    expect(customerAgentReads("db.from('org_settings').select('customer_agent')")).toEqual([])
    expect(customerAgentReads('const row = { settings: { customer_agent: blob } }')).toEqual([])
    expect(customerAgentReads("const url = 'https://x.test' ; const v = loc.settings.customer_agent")).toHaveLength(1)
    expect(customerAgentReads('const v = s.customer_agent_x; const { customer_agent_x } = s')).toEqual([])
    expect(customerAgentReads('const t = `settings.customer_agent`')).toEqual([])
    expect(customerAgentReads('const row = { customer_agent }; const other = { customer_agent: 1 } === x')).toEqual([])
  })
})

describe('Mia settings have one reader (MIAORG.1)', () => {
  it('no module outside the resolver, the contract and the settings routes reads customer_agent off a settings object', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      if (ALLOWED.includes(rel) || ALLOWED_DIRS.some((d) => rel.startsWith(d))) continue
      for (const hit of customerAgentReads(readFileSync(file, 'utf8'), file)) offenders.push(`${rel}:${hit.line}  ${hit.text}`)
    }
    expect(offenders, `read Mia's settings through resolveAgentSettings (src/lib/agent/settings-resolve.js):\n${offenders.join('\n')}`).toEqual([])
  }, 30_000) // parses every src file (~2s alone); a loaded runner passed 5s

  it('the allowlist is live: the resolver itself is a reader the scan would otherwise flag', () => {
    expect(customerAgentReads(readFileSync(path.join(ROOT, ALLOWED[0]), 'utf8')).length).toBeGreaterThan(0)
  })
})
