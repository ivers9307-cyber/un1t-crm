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
// destructuring `{ customer_agent } = x`. Allowed, by path:
//   - src/lib/agent/settings-resolve.js   (the resolver)
//   - src/lib/agent/settings-contract.js  (the contract: schema, DEFAULTS, the writer)
//   - src/app/api/settings/customer-agent/** (the settings editor's GET/PUT,
//     which read and write the stored layer itself)
// Read through resolveAgentSettings(db, locationId) or, holding a locations
// row with organization_id, resolveAgentSettingsForLocation(db, row, { orgCache }).
//
// A floor, not a proof: comments are blanked (tests/helpers/js-code.js), but a read through a computed
// key held in a variable, or one in mobile/ or shared/, is invisible to it.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'

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

const READ_PATTERNS = [
  /\??\.\s*customer_agent\b/,                       // x.customer_agent / x?.customer_agent
  /\[\s*['"`]customer_agent['"`]\s*\]/,             // x['customer_agent']
  /\{[^{}]*\bcustomer_agent\b[^{}]*\}\s*=(?!=)/,    // const { customer_agent } = x
]

// Comments are blanked by the shared stripper (GUARDSTRIP.1: never a regex).
export function customerAgentReads(src, file = 'scan.jsx') {
  const hits = []
  const lines = stripComments(src, file).split('\n')
  lines.forEach((line, i) => {
    if (READ_PATTERNS.some((re) => re.test(line))) hits.push({ line: i + 1, text: line.trim() })
  })
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
  it('ignores comments, select strings and object-literal keys', () => {
    expect(customerAgentReads('// reads settings.customer_agent.tone')).toEqual([])
    expect(customerAgentReads('/* settings.customer_agent */ const a = 1')).toEqual([])
    expect(customerAgentReads('const a = 1 // settings.customer_agent')).toEqual([])
    expect(customerAgentReads("db.from('org_settings').select('customer_agent')")).toEqual([])
    expect(customerAgentReads('const row = { settings: { customer_agent: blob } }')).toEqual([])
    expect(customerAgentReads("const url = 'https://x.test' ; const v = loc.settings.customer_agent")).toHaveLength(1)
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
  })

  it('the allowlist is live: the resolver itself is a reader the scan would otherwise flag', () => {
    expect(customerAgentReads(readFileSync(path.join(ROOT, ALLOWED[0]), 'utf8')).length).toBeGreaterThan(0)
  })
})
