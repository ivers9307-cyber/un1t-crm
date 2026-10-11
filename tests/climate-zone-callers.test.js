// TZ.10 — no caller of the schedule engine or the climate slot key may omit
// the zone. Each of these takes the location's IANA zone as an OPTIONAL
// argument whose default is the platform zone (Europe/Dublin), so a caller
// that forgets it silently runs a studio on Dublin's clock: exactly how the
// Sonos planner ran every studio on Dublin time until TZ.10 (sonos/groups.js
// called resolveServeWindows without a zone). This scans every non-test file
// under src/ that imports one of them from its module and fails on a call
// that does not pass the zone.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')

// name → { from: the module it must be imported from, arg: 0-based index of the
// zone argument, or 'zoneKey' for an options object that must name `zone` }
const ZONED = {
  resolveDayWindows: { from: '@/lib/schedule/desired-state', arg: 3 },
  resolveServeWindows: { from: '@/lib/schedule/desired-state', arg: 3 },
  desiredState: { from: '@/lib/schedule/desired-state', arg: 4 },
  planDeviceAction: { from: '@/lib/shelly/plan', arg: 4 },
  planAction: { from: '@/lib/sonos/groups', arg: 3 },
  slotKey: { from: '@/lib/class-climate', arg: 1 },
  planClassClimate: { from: '@/lib/class-climate', arg: 'zoneKey' },
  planBathroomClimate: { from: '@/lib/bathroom-climate', arg: 'zoneKey' },
}
// A module's own internal calls count too: resolve its relative imports.
const MODULE_FILES = {
  'src/lib/schedule/desired-state.js': '@/lib/schedule/desired-state',
  'src/lib/shelly/plan.js': '@/lib/shelly/plan',
  'src/lib/sonos/groups.js': '@/lib/sonos/groups',
  'src/lib/class-climate.js': '@/lib/class-climate',
  'src/lib/bathroom-climate.js': '@/lib/bathroom-climate',
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(m?js|jsx)$/.test(ent.name) && !/\.test\.|test-helpers/.test(ent.name)) out.push(p)
  }
  return out
}

// Split a call's argument text at top-level commas (strings, templates and
// nested brackets respected; good enough for this repo's call sites).
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
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
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

function importedNames(src, rel) {
  const names = new Set()
  const self = MODULE_FILES[rel]
  for (const [name, spec] of Object.entries(ZONED)) {
    if (self && spec.from === self && new RegExp(`function ${name}\\(`).test(src)) names.add(name)
  }
  const re = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) {
    // './groups' from src/lib/sonos/reconcile.js is '@/lib/sonos/groups'.
    const from = m[2].startsWith('.')
      ? '@/' + path.posix.join(path.posix.dirname(rel), m[2]).replace(/^src\//, '').replace(/\.(m?js|jsx)$/, '')
      : m[2]
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/)
      if (!orig) continue
      if (ZONED[orig] && ZONED[orig].from === from) names.add(`${orig}${alias ? `:${alias}` : ''}`)
    }
  }
  return names
}

function offences() {
  const out = []
  let calls = 0
  const files = new Set()
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file)
    const src = fs.readFileSync(file, 'utf8')
    for (const entry of importedNames(src, rel)) {
      const [name, alias] = entry.split(':')
      const local = alias || name
      const spec = ZONED[name]
      const re = new RegExp(`(^|[^\\w.$])${local}\\(`, 'g')
      let m
      while ((m = re.exec(src))) {
        const at = m.index + m[1].length
        const before = src.slice(Math.max(0, at - 9), at)
        if (/function\s*$/.test(before)) continue // the definition itself
        const line = src.slice(0, at).split('\n').length
        const lineText = src.split('\n')[line - 1]
        if (/^\s*(\/\/|\*)/.test(lineText)) continue // a comment
        calls++
        files.add(rel)
        const args = topLevelArgs(src, at + local.length)
        const ok = spec.arg === 'zoneKey'
          ? /[{,]\s*zone\b/.test(args[0] || '')
          : args.length > spec.arg && args[spec.arg] !== 'undefined'
        if (!ok) out.push(`${rel}:${line} ${local}(${args.join(', ')})`)
      }
    }
  }
  return { out, calls, files: [...files].sort() }
}

describe('TZ.10 every schedule-engine and climate-slot caller passes the zone', () => {
  it('finds the call sites it guards (the scan is armed)', () => {
    const { calls, files } = offences()
    expect(calls).toBeGreaterThanOrEqual(15)
    expect(files).toEqual(expect.arrayContaining([
      'src/app/api/sonos/schedules/[id]/run-now/route.js',
      'src/components/automations/BathroomClimateCard.jsx',
      'src/components/automations/ClassClimateCard.jsx',
      'src/components/automations/SonosScheduleClient.jsx',
      'src/lib/bathroom-climate-runner.js',
      'src/lib/bathroom-climate.js',
      'src/lib/class-climate-runner.js',
      'src/lib/class-climate.js',
      'src/lib/schedule/desired-state.js',
      'src/lib/shelly/plan.js',
      'src/lib/shelly/reconcile.js',
      'src/lib/sonos/groups.js',
      'src/lib/sonos/reconcile.js',
    ]))
  })

  it('no call omits the zone', () => {
    expect(offences().out).toEqual([])
  })
})
