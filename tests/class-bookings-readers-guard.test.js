// UN1TBOOK.2 guard — every reader of public.class_bookings is classified.
//
// From UN1TBOOK (mig 737) class_bookings holds un1t.online bookings as well as
// Glofox ones (source_platform 'un1t_online', ids namespaced 'un1t:'). Decision
// 1 (2026-10-17, binding): the CRM never sends a class reminder or credits
// attendance (sessions, points, achievement / goal / tier pushes) for a
// un1t.online booking or at a un1t.online studio; the un1t.online app does.
// The spec's reader audit (docs/superpowers/specs/2026-10-17-hatch-bookings-
// projection-design.md, "Every reader and writer of class_bookings", rows 1-11)
// is MANIFEST below, one entry per file that calls `.from('class_bookings')`
// and one per SQL function / view whose body reads the table. Kinds: display,
// data-writing, customer-messaging, reward, conversational-read (a reply the
// member asked for: not a reminder), staff-messaging, device. Pinned:
//
//  1. A new reader (a file, or a SQL object, not in MANIFEST) fails with its
//     path: decide what a un1t.online row means for it, then list it.
//  2. A listed reader that no longer reads the table fails as stale.
//  3. Every `customer-messaging` or `reward` file scopes EVERY class_bookings chain: it
//     carries `.eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)` (or the
//     literal 'glofox'), or is the argument of `scopeToCrmActionable(` (UN1TBOOK.7,
//     src/lib/class-booking-platform.js). The two that remind or credit
//     (HARD_OFF) decide through that module (UN1TBOOK.8): every chain is wrapped
//     in scopeToCrmActionable, the studios come from readUn1tOnlineLocationIds,
//     and every returned row goes through crmMayActOnClassBooking, never a
//     hard-coded 'glofox' or an inline un1t_online location read.
//  4. A `.update(` or `.delete(` chained on class_bookings fails unless the
//     chain names source_platform (nothing updates or deletes the table today;
//     a Glofox reconcile that did would reach un1t rows). The same holds for
//     an UPDATE / DELETE on it inside a SQL function body.
//  5. The class_bookings chains inside lookupBookedMember and
//     resolveBookedOccurrenceForMember (src/lib/class-bookings.js, kind
//     data-writing for the file as a whole) are scoped like a messaging read.
//  6. Every caller of getClassRoster( / lookupBookedMember( /
//     resolveBookedOccurrenceForMember( is in HELPER_CALLERS (display or
//     device); a new caller fails with its path. data-writing (D) and
//     conversational-read (E) register here when they land.
//  7. Nothing customer-facing reads the table: no file under src/app/tv/**,
//     src/app/api/public/**, src/lib/live-board.js or src/lib/tv-*.js names
//     class_bookings, imports fetchFloor, or calls the three helpers (spec G9:
//     no aggregate studio metric on a TV or other customer-facing screen).
//
// Code is read with tests/helpers/js-code.js codeOf (comments blanked) and SQL
// with tests/helpers/sql-code.js sqlCode. A floor, not a proof: `.from(<a
// variable>)`, a chain split across statements, an `.rpc()` into a function
// made by hand and the companion repos (champ-app, audit row 12) are invisible.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { codeOf, codeOfFile } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'
import { CRM_CLASS_MESSAGING_PLATFORM } from '../src/lib/class-bookings.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIG_DIR = path.join(ROOT, 'supabase/migrations')
const SCAN_DIRS = ['src', 'shared', 'mobile', 'supabase/functions']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

const KINDS = ['display', 'data-writing', 'customer-messaging', 'reward', 'conversational-read', 'staff-messaging', 'device']
/** The kinds whose every class_bookings chain must be scoped to the CRM-actionable rows. */
const SCOPED_KINDS = ['customer-messaging', 'reward']

/** kind: one of KINDS */
const MANIFEST = Object.freeze({
  'src/app/api/cron/send-class-booking-reminders/route.js': {
    kind: 'customer-messaging',
    reason: 'Audit row 1: the pre-class reminder push. Filters source_platform glofox and drops rows at un1t_online studios (skipped_un1t_online).',
  },
  'src/app/api/cron/credit-attendance/route.js': {
    kind: 'reward',
    reason: 'Audit row 2: credits attended classes (participation session, points; also data-writing) and the reward cascade pushes achievements / goals / tiers. Filters source_platform glofox and drops rows at un1t_online studios (skipped_un1t_online), whatever the provider capabilities say.',
  },
  'src/lib/onboarding-journey-data.js': {
    kind: 'customer-messaging',
    reason: 'Audit rows 3-5: loadJourneyLane feeds the notify-onboarding-pace push and the /pulse lane; loadContactJourney feeds the contact page and the member app /api/me/journey. Both reads filter source_platform glofox, so the push and the app agree.',
  },
  'src/lib/class-bookings.js': {
    kind: 'data-writing',
    reason: 'Audit rows 6-8 and 11: upsertClassBookings (Glofox writer, 24-hex ids; the mig 737 CHECK refuses a mis-tagged row), getClassRoster (staff /live display: a un1t row is meant to show), lookupBookedMember and resolveBookedOccurrenceForMember (device / HR linking, keyed on glofox_member_id, which un1t rows never carry).',
  },
  'shared/studio-kpis.js': {
    kind: 'display',
    reason: 'Audit row 9: fetchFloor for the staff /dashboard/studio no-show, attended and activation figures.',
  },
  'sql:public.campaign_outcome_stats': {
    kind: 'display',
    reason: 'Audit row 10: the campaign outcomes RPC (mig 513, re-created by mig 737 with a case-correct CANCELLED filter) behind the staff /api/campaigns/[id]/outcomes report.',
  },
})

/** The readers that remind or credit: Decision 1's hard-off lives in these. */
const HARD_OFF = Object.freeze([
  'src/app/api/cron/send-class-booking-reminders/route.js',
  'src/app/api/cron/credit-attendance/route.js',
])

/**
 * Every non-test file that calls one of the three class-bookings helpers
 * (getClassRoster, lookupBookedMember, resolveBookedOccurrenceForMember),
 * other than src/lib/class-bookings.js where they live. The helpers' own
 * chains are classified by MANIFEST; this classifies who may reach them.
 * kind: 'display' (staff screen) | 'device' (strap / wearable class linking,
 * keyed on glofox_member_id) | 'data-writing' | 'conversational-read'.
 */
const HELPER_NAMES = ['getClassRoster', 'lookupBookedMember', 'resolveBookedOccurrenceForMember']
const HELPER_CALLERS = Object.freeze({
  'src/app/api/live/[locationId]/route.js': {
    kind: 'display',
    reason: 'Staff /live board (studio_management): the roster merged with the HR sessions. A un1t row is meant to show.',
  },
  'src/app/api/live/[locationId]/contacts/route.js': {
    kind: 'display',
    reason: 'Staff /live contact picker: marks who is booked into the running class.',
  },
  'src/app/api/live/[locationId]/roster/route.js': {
    kind: 'display',
    reason: 'UN1TBOOK.12: the class_roster who-is-coming list; entries are { label, booked } only.',
  },
  'src/lib/bridge-samples.js': {
    kind: 'device',
    reason: 'Strap sample ingest: booked-vs-presence tag and booking-first class pick, keyed on glofox_member_id (un1t rows never carry one) and scoped to Glofox rows by the helpers.',
  },
  'src/lib/live-class.js': {
    kind: 'device',
    reason: 'Live-class session linking for a registered strap: same helpers, same Glofox-only scope.',
  },
  'src/app/api/wearables/apple-health/ingest/route.js': {
    kind: 'device',
    reason: 'Apple Health class linking (booked tag), keyed on glofox_member_id, Glofox rows only.',
  },
})
const HELPER_CALLER_KINDS = ['display', 'device', 'data-writing', 'conversational-read']
const HELPER_HOME = 'src/lib/class-bookings.js'

/** Customer-facing code: no TV board, public route or TV helper may read bookings (spec G9). */
const CUSTOMER_FACING_DIRS = ['src/app/tv', 'src/app/api/public']
const CUSTOMER_FACING_FILES = [/^src\/lib\/live-board\.js$/, /^src\/lib\/tv-[^/]*\.js$/]

const FROM_CLASS_BOOKINGS = /\.from\(\s*(['"`])class_bookings\1\s*\)/g
const SOURCE_FILTER = /\.eq\(\s*['"]source_platform['"]\s*,\s*(?:CRM_CLASS_MESSAGING_PLATFORM|['"]glofox['"])\s*\)/
// UN1TBOOK.8 — the other way a chain is scoped: it is the argument of
// scopeToCrmActionable(db.from('class_bookings')...), which classBookingsChains
// reads back to the wrapper's opening so the chain text starts with it.
const WRAPPED_SCOPE = /^scopeToCrmActionable\(/
const isScoped = (chain) => SOURCE_FILTER.test(chain) || WRAPPED_SCOPE.test(chain)

// ── JS: chains on class_bookings ─────────────────────────────────────────

/** Index just past the `(` … `)` group opening at `open`, quote-aware. */
function skipGroup(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i + 1 }
  }
  return code.length
}

/**
 * The text of every builder chain that starts at a `.from('class_bookings')`
 * in `code`: the `.from(...)` call and each `.method(...)` chained after it,
 * across lines.
 */
function classBookingsChains(code) {
  const chains = []
  for (const m of code.matchAll(FROM_CLASS_BOOKINGS)) {
    let start = m.index
    let i = start + m[0].length
    for (;;) {
      let j = i
      while (j < code.length && /\s/.test(code[j])) j++
      const call = /^\.\s*[A-Za-z_$][\w$]*\s*/.exec(code.slice(j, j + 200))
      if (!call) break
      j += call[0].length
      if (code[j] !== '(') break
      i = skipGroup(code, j)
    }
    // `scopeToCrmActionable(db.from('class_bookings')...)`: the chain is the
    // wrapper's whole argument (the receiver, then nothing but `)` / `,` after).
    const before = /scopeToCrmActionable\(\s*[\w$.]+\s*$/.exec(code.slice(0, start))
    if (before && /^\s*,?\s*\)/.test(code.slice(i))) start = before.index
    chains.push(code.slice(start, i))
  }
  return chains
}

/** The chains that write rows (update / delete) without naming source_platform. */
function unscopedWrites(chains) {
  return chains.filter((c) => /\.\s*(update|delete)\s*\(/.test(c) && !/source_platform/.test(c))
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

let JS_READERS = null
function jsReaders() {
  if (JS_READERS) return JS_READERS
  JS_READERS = new Map()
  for (const f of SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
    const raw = readFileSync(f, 'utf8')
    if (!raw.includes('class_bookings')) continue
    const code = codeOfFile(f)
    const chains = classBookingsChains(code)
    if (chains.length) JS_READERS.set(rel(f), { code, chains })
  }
  return JS_READERS
}

// ── SQL: function / view bodies that read class_bookings ─────────────────

const SQL_REF = /\b(from|join|update|into)\s+(?:public\s*\.\s*)?"?class_bookings"?\b/gi
const SQL_OBJECT = /\bcreate\s+(?:or\s+replace\s+)?(function|(?:materialized\s+)?view)\s+((?:"?[\w]+"?\s*\.\s*)?"?[\w]+"?)/gi

/** Every SQL object (function / view) whose body reads or writes class_bookings, from one migration. */
function sqlReaders(sql) {
  // Comments blanked by sqlCode, then string literals blanked here (same
  // length): a COMMENT ON '... projected into class_bookings ...' is prose,
  // not a read. Dynamic SQL in EXECUTE '...' is therefore invisible.
  const code = sqlCode(sql).replace(/'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, ' '))
  const extents = []
  for (const m of code.matchAll(SQL_OBJECT)) {
    const name = m[2].replace(/["\s]/g, '').toLowerCase()
    const qualified = name.includes('.') ? name : `public.${name}`
    const headerEnd = m.index + m[0].length
    let end
    if (/function/i.test(m[1])) {
      const as = /\bas\s+(\$[\w]*\$)/i.exec(code.slice(headerEnd))
      if (as) {
        const bodyStart = headerEnd + as.index + as[0].length
        const close = code.indexOf(as[1], bodyStart)
        end = close === -1 ? code.length : close + as[1].length
      } else {
        const semi = code.indexOf(';', headerEnd)
        end = semi === -1 ? code.length : semi
      }
    } else {
      const semi = code.indexOf(';', headerEnd)
      end = semi === -1 ? code.length : semi
    }
    extents.push({ name: qualified, start: m.index, end, body: code.slice(m.index, end) })
  }
  const out = []
  for (const r of code.matchAll(SQL_REF)) {
    const ext = extents.find((e) => r.index >= e.start && r.index < e.end)
    out.push({
      key: ext ? `sql:${ext.name}` : 'sql:<top-level statement>',
      write: /^(update)$/i.test(r[1]) || /\bdelete\s+$/i.test(code.slice(Math.max(0, r.index - 12), r.index)),
      scoped: ext ? /source_platform/.test(ext.body) : false,
    })
  }
  return out
}

let SQL_READERS = null
function sqlReadersAll() {
  if (SQL_READERS) return SQL_READERS
  SQL_READERS = new Map()
  for (const name of readdirSync(MIG_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIG_DIR, name), 'utf8')
    if (!sql.includes('class_bookings')) continue
    for (const r of sqlReaders(sql)) {
      const entry = SQL_READERS.get(r.key) || { files: new Set(), unscopedWrite: [] }
      entry.files.add(`supabase/migrations/${name}`)
      if (r.write && !r.scoped) entry.unscopedWrite.push(`supabase/migrations/${name}`)
      SQL_READERS.set(r.key, entry)
    }
  }
  return SQL_READERS
}

// ── JS: callers of the class-bookings helpers, and the customer-facing scan ──

/** The text of `export async function <name>(...) { ... }` in `code`, or null. */
function functionBody(code, name) {
  const head = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(code)
  if (!head) return null
  const params = code.indexOf('(', head.index)
  const open = code.indexOf('{', skipGroup(code, params))
  if (open === -1) return null
  return code.slice(head.index, skipGroup(code, open))
}

const HELPER_CALL = new RegExp(`\\b(?:${HELPER_NAMES.join('|')})\\s*\\(`)

let HELPER_CALLER_FILES = null
/** path -> the helper names it calls, for every scanned non-test file but the helpers' home. */
function helperCallers() {
  if (HELPER_CALLER_FILES) return HELPER_CALLER_FILES
  HELPER_CALLER_FILES = new Map()
  for (const f of SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
    if (rel(f) === HELPER_HOME) continue
    const raw = readFileSync(f, 'utf8')
    if (!HELPER_NAMES.some((n) => raw.includes(n))) continue
    const code = codeOfFile(f)
    const used = HELPER_NAMES.filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(code))
    if (used.length) HELPER_CALLER_FILES.set(rel(f), used)
  }
  return HELPER_CALLER_FILES
}

const isCustomerFacing = (r) => CUSTOMER_FACING_DIRS.some((d) => r.startsWith(`${d}/`)) || CUSTOMER_FACING_FILES.some((re) => re.test(r))

/** Every customer-facing file under ROOT, comments blanked, as rel path -> code. */
function customerFacingFiles() {
  const out = new Map()
  for (const f of SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
    const r = rel(f)
    if (isCustomerFacing(r)) out.set(r, codeOfFile(f))
  }
  return out
}

/** What a customer-facing file must not do: name the table, import fetchFloor, call a helper. */
function bookingReadsIn(code) {
  const found = []
  if (/class_bookings/.test(code)) found.push('names class_bookings')
  if (/\bfetchFloor\b/.test(code)) found.push('uses fetchFloor')
  if (HELPER_CALL.test(code)) found.push('calls a class-bookings helper')
  return found
}

// ── the guard ────────────────────────────────────────────────────────────

describe('class_bookings reader manifest (UN1TBOOK.2, Decision 1)', () => {
  it('the CRM class-messaging platform is glofox', () => {
    expect(CRM_CLASS_MESSAGING_PLATFORM).toBe('glofox')
  })

  it('every manifest entry has a known kind and a reason; every HARD_OFF reader is customer-messaging or reward', () => {
    for (const [p, e] of Object.entries(MANIFEST)) {
      expect(KINDS, p).toContain(e.kind)
      expect(e.reason?.length, p).toBeGreaterThan(20)
    }
    for (const p of HARD_OFF) expect(SCOPED_KINDS, p).toContain(MANIFEST[p]?.kind)
  })

  it('credit-attendance, which credits sessions and fires the reward cascade, is a reward reader', () => {
    expect(MANIFEST['src/app/api/cron/credit-attendance/route.js']?.kind).toBe('reward')
    expect(MANIFEST['src/app/api/cron/send-class-booking-reminders/route.js']?.kind).toBe('customer-messaging')
  })

  it('every file that calls .from(\'class_bookings\') is in the manifest', () => {
    const unlisted = [...jsReaders().keys()].filter((p) => !MANIFEST[p])
    expect(unlisted, `New class_bookings reader(s): ${unlisted.join(', ')}. Since mig 737 the table holds un1t.online bookings too (source_platform 'un1t_online'). Decide what such a row means for this reader (a customer message or an attendance credit must filter .eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)) and add it to MANIFEST in tests/class-bookings-readers-guard.test.js.`).toEqual([])
  })

  it('every SQL function / view that reads class_bookings is in the manifest', () => {
    const unlisted = [...sqlReadersAll().entries()].filter(([k]) => !MANIFEST[k]).map(([k, e]) => `${k} (${[...e.files].join(', ')})`)
    expect(unlisted, `New SQL reader(s) of class_bookings: ${unlisted.join('; ')}. Classify it in MANIFEST.`).toEqual([])
  })

  it('no listed reader is stale', () => {
    const live = new Set([...jsReaders().keys(), ...sqlReadersAll().keys()])
    const stale = Object.keys(MANIFEST).filter((p) => !live.has(p))
    expect(stale, `Listed in MANIFEST but no longer reads class_bookings: ${stale.join(', ')}. Remove the entry.`).toEqual([])
  })

  it('every chain in a customer-messaging or reward file is scoped (filters source_platform glofox or is wrapped in scopeToCrmActionable)', () => {
    const missing = []
    for (const [p, e] of Object.entries(MANIFEST)) {
      if (!SCOPED_KINDS.includes(e.kind)) continue
      const reader = jsReaders().get(p)
      if (!reader) continue // the stale test reports it
      reader.chains.forEach((c, i) => { if (!isScoped(c)) missing.push(`${p} (chain ${i + 1})`) })
    }
    expect(missing, `Customer-messaging or reward class_bookings reads neither carrying .eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM) nor wrapped in scopeToCrmActionable(: ${missing.join(', ')}`).toEqual([])
  })

  it('the reminder and crediting crons decide through the class-booking-platform predicate', () => {
    for (const p of HARD_OFF) {
      const reader = jsReaders().get(p)
      expect(reader, `${p} no longer reads class_bookings`).toBeTruthy()
      expect(reader.code, `${p} must read the un1t_online studios with readUn1tOnlineLocationIds(`).toMatch(/\breadUn1tOnlineLocationIds\(/)
      expect(reader.code, `${p} must judge every returned row with crmMayActOnClassBooking(`).toMatch(/\bcrmMayActOnClassBooking\(/)
      for (const c of reader.chains) expect(c, `${p} must wrap every class_bookings chain in scopeToCrmActionable(, never a hard-coded 'glofox'`).toMatch(WRAPPED_SCOPE)
      for (const name of ['scopeToCrmActionable', 'crmMayActOnClassBooking', 'readUn1tOnlineLocationIds']) {
        expect(reader.code, `${p} must import ${name} from @/lib/class-booking-platform`).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]@/lib/class-booking-platform['"]`))
      }
    }
  })

  it('no .update( / .delete( on class_bookings without a source_platform filter', () => {
    const bad = []
    for (const [p, { chains }] of jsReaders()) for (const c of unscopedWrites(chains)) bad.push(`${p}: ${c.replace(/\s+/g, ' ').slice(0, 120)}`)
    for (const [k, e] of sqlReadersAll()) for (const f of e.unscopedWrite) bad.push(`${k} (${f})`)
    expect(bad, `class_bookings holds un1t.online rows since mig 737: an update or delete must filter source_platform. ${bad.join('; ')}`).toEqual([])
  })

  it('the class_bookings chains inside lookupBookedMember and resolveBookedOccurrenceForMember are scoped', () => {
    const reader = jsReaders().get(HELPER_HOME)
    expect(reader, `${HELPER_HOME} no longer reads class_bookings`).toBeTruthy()
    for (const name of ['lookupBookedMember', 'resolveBookedOccurrenceForMember']) {
      const body = functionBody(reader.code, name)
      expect(body, `${name} not found in ${HELPER_HOME}`).toBeTruthy()
      const chains = classBookingsChains(body)
      expect(chains.length, `${name} must read class_bookings`).toBeGreaterThan(0)
      for (const c of chains) expect(isScoped(c), `${name}: a class_bookings chain is not scoped to the CRM-actionable rows: ${c.replace(/\s+/g, ' ').slice(0, 120)}`).toBe(true)
    }
  })

  it('every manifest entry in HELPER_CALLERS has a known kind and a reason', () => {
    for (const [p, e] of Object.entries(HELPER_CALLERS)) {
      expect(HELPER_CALLER_KINDS, p).toContain(e.kind)
      expect(e.reason?.length, p).toBeGreaterThan(20)
    }
  })

  it('every caller of getClassRoster, lookupBookedMember and resolveBookedOccurrenceForMember is in HELPER_CALLERS', () => {
    const unlisted = [...helperCallers()].filter(([p]) => !HELPER_CALLERS[p]).map(([p, used]) => `${p} (${used.join(', ')})`)
    expect(unlisted, `New caller(s) of the class-bookings helpers: ${unlisted.join('; ')}. They read class_bookings, which holds un1t.online rows. Classify each in HELPER_CALLERS in tests/class-bookings-readers-guard.test.js (display, device, data-writing or conversational-read); a customer message or reward must not come from them.`).toEqual([])
  })

  it('no HELPER_CALLERS entry is stale', () => {
    const live = new Set(helperCallers().keys())
    const stale = Object.keys(HELPER_CALLERS).filter((p) => !live.has(p))
    expect(stale, `Listed in HELPER_CALLERS but no longer calling a class-bookings helper: ${stale.join(', ')}. Remove the entry.`).toEqual([])
  })

  it('no TV or public file reads class_bookings, imports fetchFloor or calls a class-bookings helper', () => {
    const files = customerFacingFiles()
    // Non-vacuous: the scan must actually reach the TV boards and the public API.
    expect([...files.keys()].some((p) => p.startsWith('src/app/tv/')), 'the scan found no file under src/app/tv').toBe(true)
    expect([...files.keys()].some((p) => p.startsWith('src/app/api/public/')), 'the scan found no file under src/app/api/public').toBe(true)
    expect(files.has('src/lib/live-board.js'), 'src/lib/live-board.js not scanned').toBe(true)
    expect([...files.keys()].some((p) => /^src\/lib\/tv-/.test(p)), 'no src/lib/tv-*.js scanned').toBe(true)
    const bad = []
    for (const [p, code] of files) for (const why of bookingReadsIn(code)) bad.push(`${p} ${why}`)
    expect(bad, `Customer-facing code must not read bookings (spec G9: no fill, no-show or aggregate studio metric on a TV or public screen): ${bad.join('; ')}`).toEqual([])
  })
})

describe('class_bookings guard detectors', () => {
  it('reads a multi-line chain to its end, and only the chain', () => {
    const code = codeOf(`
      const { data } = await db
        .from('class_bookings')
        .select('id, contact_id')
        .eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)
        .not('status', 'eq', 'CANCELLED')
        .range(from, from + PAGE - 1)
      const other = x.eq('source_platform', 'glofox')
    `)
    const [chain] = classBookingsChains(code)
    expect(chain).toMatch(SOURCE_FILTER)
    expect(chain).toMatch(/\.range\(from, from \+ PAGE - 1\)$/)
    expect(chain).not.toMatch(/other/)
  })

  it('a chain without the filter is caught; a commented-out filter does not count', () => {
    const code = codeOf(`
      await db.from('class_bookings').select('id') // .eq('source_platform', 'glofox')
        .eq('attended', true)
    `)
    expect(classBookingsChains(code).every((c) => SOURCE_FILTER.test(c))).toBe(false)
  })

  it('a chain wrapped as scopeToCrmActionable(db.from(\'class_bookings\')…) counts as scoped; an unwrapped one does not', () => {
    const chains = classBookingsChains(codeOf(`
      const a = await scopeToCrmActionable(
        db.from('class_bookings').select('id, source_platform'),
      )
        .eq('attended', true)
        .range(from, from + PAGE - 1)
      const b = await db
        .from('class_bookings')
        .select('id')
        .eq('attended', true)
      const c = await other(db.from('class_bookings').select('id'))
      const d = await scopeToCrmActionable(db.from('class_bookings').select('id'))
      const e = await scopeToCrmActionable(x).from('class_bookings').select('id')
    `))
    expect(chains).toHaveLength(5)
    expect(chains.map(isScoped)).toEqual([true, false, false, true, false])
    // The wrapped chain still reads as one chain (the .eq beyond the wrapper is not part of it).
    expect(chains[0]).toMatch(/^scopeToCrmActionable\(\s*db\s*\.from\('class_bookings'\)\.select\('id, source_platform'\)$/)
  })

  it('flags an unscoped update / delete and passes a scoped one', () => {
    const chains = classBookingsChains(codeOf(`
      await db.from('class_bookings').update({ status: 'CANCELLED' }).eq('glofox_event_id', id)
      await db.from("class_bookings").delete().in('id', ids)
      await db.from('class_bookings').update({ status: 'CANCELLED' }).eq('source_platform', 'glofox').eq('id', id)
      await db.from('class_bookings').select('id').eq('id', id)
    `))
    expect(chains).toHaveLength(4)
    expect(unscopedWrites(chains)).toHaveLength(2)
  })

  it('attributes a SQL read to its function, a top-level DML to no object, and spots an unscoped SQL write', () => {
    const sql = `
      -- select * from public.class_bookings in a comment is not a read
      comment on table public.un1t_bookings is 'projected into class_bookings; not a read';
      create or replace function public.f_read() returns int language sql as $fn$
        select count(*)::int from public.class_bookings where attended
      $fn$;
      create view public.v_b with (security_invoker = on) as select b.id from x join class_bookings b on true;
      create function public.f_write() returns void language sql as $$
        delete from public.class_bookings where glofox_event_id = 'x'
      $$;
      update public.class_bookings set attended = false;
    `
    const found = sqlReaders(sql)
    expect(found.map((r) => r.key)).toEqual(['sql:public.f_read', 'sql:public.v_b', 'sql:public.f_write', 'sql:<top-level statement>'])
    expect(found.filter((r) => r.write).map((r) => r.key)).toEqual(['sql:public.f_write', 'sql:<top-level statement>'])
    expect(found.find((r) => r.key === 'sql:public.f_write').scoped).toBe(false)
  })

  it('reads one function\'s body to its closing brace, and only that function', () => {
    const code = codeOf(`
      export async function a(db, { x } = {}) {
        const { data } = await db.from('class_bookings').select('id').eq('x', x)
        return data
      }
      export async function b(db) {
        return scopeToCrmActionable(db.from('class_bookings').select('id'))
      }
    `)
    const a = functionBody(code, 'a')
    expect(classBookingsChains(a).map(isScoped)).toEqual([false])
    expect(classBookingsChains(functionBody(code, 'b')).map(isScoped)).toEqual([true])
    expect(functionBody(code, 'missing')).toBeNull()
  })

  it('flags a customer-facing read of the table, fetchFloor or a helper; passes comments and unrelated code', () => {
    expect(bookingReadsIn(codeOf(`const r = await db.from('class_bookings').select('id')`))).toEqual(['names class_bookings'])
    expect(bookingReadsIn(codeOf(`import { fetchFloor } from 'shared/studio-kpis'`))).toEqual(['uses fetchFloor'])
    expect(bookingReadsIn(codeOf(`const r = await getClassRoster(db, { locationId })`))).toEqual(['calls a class-bookings helper'])
    expect(bookingReadsIn(codeOf(`// class_bookings fetchFloor getClassRoster(\nconst x = 1`))).toEqual([])
    expect(isCustomerFacing('src/app/tv/[slug]/page.js')).toBe(true)
    expect(isCustomerFacing('src/lib/tv-class-intro.js')).toBe(true)
    expect(isCustomerFacing('src/lib/live-board.js')).toBe(true)
    expect(isCustomerFacing('src/lib/live-class.js')).toBe(false)
    expect(isCustomerFacing('src/lib/tv-admin/x.js')).toBe(false)
  })
})
