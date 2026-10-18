// HATCHINV.1 guard — every reader of the `invoices` membership capability is
// classified.
//
// un1t.online declares `invoices: true` (Task 17): its payments, subscriptions
// and past-due rows are read from `un1t_invoices` / `un1t_subscriptions`
// through `pastDue` / `paymentsFor`. Before that flip nothing could tell a
// reader which provider it was talking to, because no reader ever saw a second
// provider with the capability on. From now on a reader that asks "does this
// studio's provider have invoices?" gets `true` for Hatch Street too, so each
// one must be decided on purpose:
//
//  1. A non-test file under src/, shared/ or mobile/ that reads the capability
//     (`capabilities.invoices`, `capabilities?.invoices`, `capabilities['invoices']`,
//     `providesCapability(<x>, 'invoices')`, `locationIdsWithoutCapability(<x>, 'invoices')`,
//     `capability="invoices"` / `capability: 'invoices'`) and is not in MANIFEST
//     fails with its path: decide what a un1t.online `true` means for it, then list it.
//  2. A MANIFEST entry whose file no longer reads the capability fails as stale.
//  3. Every entry carries a reason.
//
// Code is read with comments blanked (tests/helpers/js-code.js), so prose that
// names the capability is not a reader. A floor, not a proof: a capability key
// read through a variable (`caps[name]`), an alias of `capabilities`, and the
// companion repos are invisible. The generic readers that take the key as a
// parameter (MembershipSourceGate, providesCapability, locationIdsWithoutCapability)
// are covered by the call-site patterns above.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { codeOf } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

/** path -> reason. The reason says what a un1t.online `invoices: true` means for the reader. */
const MANIFEST = Object.freeze({
  'src/lib/agent/account-tools.js': 'Glofox-only, gated on provider.key',
  'src/lib/contact-un1t-billing.js': 'un1t: paymentsFor',
})

const PATTERNS = Object.freeze([
  /capabilities\s*\??\.\s*invoices\b/,
  /capabilities\s*\??\.?\s*\[\s*['"`]invoices['"`]\s*\]/,
  /providesCapability\(\s*[^,()]+,\s*['"`]invoices['"`]\s*\)/,
  /locationIdsWithoutCapability\(\s*[^,()]+,\s*['"`]invoices['"`]\s*\)/,
  /capability\s*=\s*(?:["']invoices["']|\{\s*['"`]invoices['"`]\s*\})/,
  /capability\s*:\s*['"`]invoices['"`]/,
])

/** True when `code` (comments already blanked) reads the invoices capability. */
export function readsInvoicesCapability(code) {
  return PATTERNS.some((re) => re.test(code))
}

/** Compare the files found with a manifest: who is unclassified, which entries are stale, which lack a reason. */
export function classify(found, manifest) {
  const listed = Object.keys(manifest)
  return {
    unclassified: [...found].filter((f) => !(f in manifest)).sort(),
    stale: listed.filter((f) => !found.has(f)).sort(),
    unreasoned: listed.filter((f) => !String(manifest[f] || '').trim()).sort(),
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$|\.test\.(m?js|jsx|ts|tsx)$|\.test-helpers\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

function foundReaders() {
  const found = new Set()
  for (const f of SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
    const raw = readFileSync(f, 'utf8')
    if (!raw.includes('invoices')) continue
    if (readsInvoicesCapability(codeOf(raw, f))) found.add(rel(f))
  }
  return found
}

describe('invoices capability readers (HATCHINV.1)', () => {
  it('every reader of capabilities.invoices is classified', () => {
    const { unclassified, unreasoned } = classify(foundReaders(), MANIFEST)
    expect(unclassified, 'a new reader of the invoices capability: decide what un1t.online `true` means for it, then add it to MANIFEST').toEqual([])
    expect(unreasoned).toEqual([])
  })

  it('a manifest entry that no longer matches fails as stale', () => {
    // The real tree has no stale entry...
    expect(classify(foundReaders(), MANIFEST).stale).toEqual([])
    // ...and the check itself fires: an entry the scan did not find is stale,
    // a file the manifest does not list is unclassified, a blank reason is flagged.
    const verdict = classify(new Set(['a.js', 'c.js']), { 'a.js': 'ok', 'b.js': 'gone', 'c.js': '  ' })
    expect(verdict.stale).toEqual(['b.js'])
    expect(classify(new Set(['a.js', 'd.js']), { 'a.js': 'ok' }).unclassified).toEqual(['d.js'])
    expect(verdict.unreasoned).toEqual(['c.js'])
  })

  it('the patterns read each spelling the brief lists, and nothing else', () => {
    const reads = (s) => readsInvoicesCapability(codeOf(s, 'x.jsx'))
    expect(reads('if (r.capabilities.invoices) {}')).toBe(true)
    expect(reads('if (r.capabilities?.invoices !== true) {}')).toBe(true)
    expect(reads("const x = p.capabilities['invoices']")).toBe(true)
    expect(reads("providesCapability(membership, 'invoices')")).toBe(true)
    expect(reads("await locationIdsWithoutCapability(db, 'invoices')")).toBe(true)
    expect(reads('<MembershipSourceGate capability="invoices" />')).toBe(true)
    expect(reads("const g = { capability: 'invoices' }")).toBe(true)
    // not readers: the capability DECLARATION, another key, a comment
    expect(reads('capabilities: Object.freeze({ memberships: true, invoices: true })')).toBe(false)
    expect(reads("providesCapability(membership, 'memberships')")).toBe(false)
    expect(reads('// r.capabilities.invoices is read elsewhere')).toBe(false)
    expect(reads('data.invoices.length')).toBe(false)
  })
})
