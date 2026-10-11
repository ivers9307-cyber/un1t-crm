// TZ.16 — every caller of src/lib/dates.js's `*InTZ` formatters passes the zone.
// Each takes `timeZone` as an OPTIONAL second argument defaulting to
// DEFAULT_EMAIL_TZ (the Dublin floor), so a call with one argument renders a
// New York contract or invoice email on Dublin's clock without a word. This
// scans every non-test file under src/ and shared/ and fails on a one-argument
// call.
//
// PENDING lists the one-argument calls that exist on main today and belong to
// sweeps still in flight (each names its owner). It may only shrink: a file not
// listed, or more one-argument calls in a listed file than it allows, fails.
// TZ.18b empties it.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const NAMES = ['formatWeekdayShortDateTimeInTZ', 'formatWeekdayLongDateInTZ', 'formatFullDateTimeInTZ']

// TZ.8b (#2040) passed the record's zone at its three calls; nothing is pending.
const PENDING = {}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(m?js|jsx)$/.test(ent.name) && !/\.test\.|test-helpers/.test(ent.name)) out.push(p)
  }
  return out
}

// A call's arguments split at top-level commas (strings, templates and nested
// brackets respected).
function topLevelArgs(src, openIdx) {
  const args = []
  let depth = 0
  let cur = ''
  let quote = null
  for (let i = openIdx + 1; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      cur += c
      if (c === '\\') { cur += src[++i]; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; cur += c; continue }
    if ('([{'.includes(c)) depth++
    if (')]}'.includes(c)) {
      if (depth === 0) { if (cur.trim()) args.push(cur.trim()); return args }
      depth--
    }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  return args
}

function scan() {
  const oneArg = new Map() // file → [line text]
  let calls = 0
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'shared'))]) {
    const rel = path.relative(ROOT, file)
    if (rel === 'src/lib/dates.js') continue // the definitions
    const src = fs.readFileSync(file, 'utf8')
    const re = new RegExp(`(^|[^\\w.$])(${NAMES.join('|')})\\(`, 'g')
    let m
    while ((m = re.exec(src))) {
      const at = m.index + m[1].length
      const lineNo = src.slice(0, at).split('\n').length
      const lineText = src.split('\n')[lineNo - 1]
      if (/^\s*(\/\/|\*)/.test(lineText)) continue // a comment
      calls++
      const args = topLevelArgs(src, at + m[2].length)
      if (args.length < 2 || args[1] === 'undefined') {
        if (!oneArg.has(rel)) oneArg.set(rel, [])
        oneArg.get(rel).push(`${rel}:${lineNo} ${m[2]}(${args.join(', ')})`)
      }
    }
  }
  return { oneArg, calls }
}

describe('TZ.16 every *InTZ caller names the record\'s zone', () => {
  it('finds the call sites it guards (the scan is armed)', () => {
    expect(scan().calls).toBeGreaterThanOrEqual(5)
  })
  it('no NEW one-argument call (the Dublin default) outside the pending list', () => {
    const offences = []
    for (const [rel, sites] of scan().oneArg) {
      const allowed = PENDING[rel]?.calls ?? 0
      if (sites.length > allowed) offences.push(...sites)
    }
    expect(offences).toEqual([])
  })
})
