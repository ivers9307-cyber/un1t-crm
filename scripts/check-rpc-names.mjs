#!/usr/bin/env node
// Phantom-RPC lint (STEPSENTRPC.1): a name passed to supabase-js `.rpc()` is
// a CLAIM ABOUT THE SCHEMA, exactly like a column in `.select()`, and until
// this script nothing checked it.
//
// The incidents it exists to prevent (C61 SEQCOUNTERS.1 and C71
// STEPSENTRPC.1, found 29 Sep 2026): `db.rpc('increment_step_sent')`
// (src/lib/sequences/steps.js ×2), `increment_sequence_enrolled` (enrol.js)
// and `increment_sequence_completed` (scheduler.js ×2) called functions that
// no migration ever created and prod has never had. PostgREST answers 404
// (PGRST202); supabase-js RESOLVES with `{ error }` rather than throwing; each
// call sat in `try { await … } catch {}`, so the error went in the bin and the
// counters never moved, for months, through green tests (a mocked `db.rpc`
// accepts any name whatsoever). ~11 404s a day in the edge logs, unread.
//
// Model (the check:select-columns idea, for functions):
//   1. Derive the callable functions by REPLAYING supabase/migrations in
//      filename order: CREATE [OR REPLACE] FUNCTION, DROP FUNCTION (with or
//      without an argument list, several per statement), ALTER FUNCTION …
//      RENAME TO / SET SCHEMA. Tracked per SIGNATURE (schema, name, input arg
//      types), so dropping one overload never deletes another. Only schema
//      `public` is reachable through `.rpc()` (PostgREST's exposed schema); a
//      function moved to `private` is gone as far as `.rpc()` is concerned.
//      A CREATE FUNCTION inside a DO block (dynamic SQL) is not replayed; it
//      is printed as a replay note instead.
//   2. Scan src/, mobile/, shared/ and supabase/functions (non-test JS/TS)
//      for `.rpc('<name>'` with a string-literal first argument, plus the
//      declared indirections in RPC_INDIRECT (a wrapper that takes the name
//      as an argument, or a table of names handed to `.rpc(x.fn)`).
//   3. A `.rpc(<not a literal>)` that no RPC_INDIRECT entry covers FAILS, and
//      so does an RPC_INDIRECT entry that no longer matches anything: the gate
//      says what it cannot read, instead of skipping it in silence.
//
// A FLOOR, NOT A PROOF. It proves a function of that NAME exists in public.
// It does not check argument names (PostgREST also 404s a name whose
// parameters do not match), EXECUTE grants (C67's guard owns those), or a
// call built across statements. A function made by hand outside the
// migrations FAILS here, correctly: prod must be reproducible from the files.
// Comments are masked with check-select-columns' maskComments (same known
// limits; C74 GUARDSTRIP.1 owns replacing it everywhere).
//
// Exceptions go in `.rpc-names-allowlist.json` with a reason and an expiry;
// an expired entry fails exactly like an unlisted name (entries cannot rot).

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { splitSqlStatements, splitTopLevel, maskComments, lineOf } from './check-select-columns.mjs'

const MIGRATIONS_ROOT = 'supabase/migrations'
export const SOURCE_ROOTS = Object.freeze(['src', 'mobile', 'shared', 'supabase/functions'])
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])
const SOURCE_RE = /\.(?:m?js|jsx|ts|tsx)$/
const TEST_RE = /\.test\.(?:m?js|jsx|ts|tsx)$/
const ALLOWLIST_PATH = '.rpc-names-allowlist.json'
// PostgREST's exposed schema (the hosted default; supabase-js `.rpc()` never
// schema-qualifies). `.rpc()` can reach nothing else.
export const RPC_SCHEMA = 'public'

// Non-literal `.rpc()` call sites, and where their names come from. Each entry
// is checked both ways: its call site must still hold a non-literal `.rpc(`,
// and its source must still yield names (else the entry is STALE and fails).
//   callee:   calls of `callee(` in `file` whose argument `arg` (0-based) is
//             the function name, as a string literal;
//   property: `property: '<name>'` literals in `file` (a table of names).
export const RPC_INDIRECT = Object.freeze([
  {
    site: 'src/lib/postmark-webhook-processor.js',
    source: { file: 'src/lib/postmark-webhook-processor.js', callee: 'reportRpc', arg: 1 },
    why: 'COMMSFIX.C.3: the best-effort counter wrapper reportRpc(db, fn, args)',
  },
  {
    site: 'src/app/api/schedule/swaps/[id]/route.js',
    source: { file: 'src/lib/swap-lifecycle.js', property: 'fn' },
    why: 'SWAPS.2: swapApprovalRpc(effect) returns { fn, args }',
  },
])

// ---------------------------------------------------------------------------
// Migration replay
// ---------------------------------------------------------------------------

const unquote = (s) => String(s || '').replace(/^"(.*)"$/, '$1')
const fold = (s) => (s && s.startsWith('"') ? unquote(s) : String(s || '').toLowerCase())

/** `public.foo` / `"public"."foo"` / `foo` → { schema, name }. */
export function parseFunctionName(raw) {
  const m = String(raw).match(/^\s*(?:("[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)\s*$/)
  if (!m) return null
  return { schema: m[1] ? fold(m[1]) : 'public', name: fold(m[2]) }
}

const TYPE_ALIASES = new Map([
  ['int', 'integer'], ['int4', 'integer'], ['int8', 'bigint'], ['int2', 'smallint'],
  ['bool', 'boolean'], ['float8', 'double precision'], ['float4', 'real'],
  ['decimal', 'numeric'], ['varchar', 'character varying'], ['char', 'character'],
  ['timestamptz', 'timestamp with time zone'], ['timestamp', 'timestamp without time zone'],
  ['timetz', 'time with time zone'], ['time', 'time without time zone'],
])
// First words of multi-word type names: such a leading word belongs to the
// TYPE, so it is not taken for a parameter name.
const TYPE_STARTERS = new Set(['double', 'character', 'timestamp', 'time', 'bit', 'interval', 'national'])

/**
 * One argument declaration → its normalised input TYPE, or null for an OUT
 * argument (not part of the signature). Drops the mode, the parameter name,
 * a DEFAULT / `=` expression, typmods and a public./pg_catalog. prefix.
 */
export function normaliseArgType(decl) {
  let s = String(decl).replace(/\s+/g, ' ').trim()
  s = s.replace(/\s+(?:DEFAULT\b|=)[\s\S]*$/i, '').trim()
  const mode = s.match(/^(IN|OUT|INOUT|VARIADIC)\s+/i)
  if (mode) {
    if (mode[1].toUpperCase() === 'OUT') return null
    s = s.slice(mode[0].length)
  }
  let words = s.split(' ')
  if (words.length > 1 && !TYPE_STARTERS.has(words[0].toLowerCase().replace(/"/g, ''))) words = words.slice(1)
  let t = words.join(' ').toLowerCase().replace(/"/g, '')
  t = t.replace(/\s*\([^)]*\)/g, '')
  t = t.replace(/^(?:public|pg_catalog)\./, '')
  const arr = t.match(/(\[\])+$/)
  let base = arr ? t.slice(0, -arr[0].length) : t
  base = TYPE_ALIASES.get(base) || base
  return base + (arr ? arr[0] : '')
}

/** An argument list's text → a signature key ("uuid,integer"). */
export function signatureOf(argsText) {
  if (!argsText || !argsText.trim()) return ''
  return splitTopLevel(argsText).map(normaliseArgType).filter((t) => t !== null).join(',')
}

/** The text inside the balanced parens that open at openIdx, or null. */
function innerParens(text, openIdx) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return text.slice(openIdx + 1, i) }
  }
  return null
}

const FN_NAME = '((?:"[^"]+"|\\w+)\\s*\\.\\s*)?("[^"]+"|\\w+)'
const CREATE_RE = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${FN_NAME}\\s*\\(`, 'i')
const DROP_RE = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i
const DROP_ITEM_RE = new RegExp(`^${FN_NAME}\\s*(\\(([\\s\\S]*)\\))?$`, 'i')
const ALTER_RE = new RegExp(
  `^ALTER\\s+FUNCTION\\s+${FN_NAME}\\s*(\\(([\\s\\S]*?)\\))?\\s+(?:RENAME\\s+TO\\s+("[^"]+"|\\w+)|SET\\s+SCHEMA\\s+("[^"]+"|\\w+))`, 'i')

const DYNAMIC_DDL = [
  ['dynamic-create', /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i],
  ['dynamic-drop', /\bDROP\s+FUNCTION\b/i],
  ['dynamic-alter', /\bALTER\s+FUNCTION\b/i],
]

/**
 * Apply one migration's function DDL. `functions`: Map<"schema.name",
 * Set<signature>>. `notes` collects what the replay could not apply exactly.
 */
export function applyFunctionDdl(sqlText, functions = new Map(), notes = []) {
  const keyOf = (q) => `${q.schema}.${q.name}`
  const add = (q, sig) => {
    if (!functions.has(keyOf(q))) functions.set(keyOf(q), new Set())
    functions.get(keyOf(q)).add(sig)
  }
  const remove = (q, sig) => {
    const k = keyOf(q)
    if (!functions.has(k)) return false
    if (sig === undefined) { functions.delete(k); return true }
    const set = functions.get(k)
    const had = set.delete(sig)
    if (set.size === 0) functions.delete(k)
    return had
  }

  for (const stmt of splitSqlStatements(sqlText)) {
    const flat = stmt.replace(/\s+/g, ' ').trim()

    // Dynamic SQL is never executed or guessed at: a DO block's function DDL
    // (CREATE, DROP or ALTER, one note per kind) is printed as a replay note,
    // so whoever reads the gate's output knows the replay may be off there.
    if (/^DO\b/i.test(flat)) {
      for (const [kind, re] of DYNAMIC_DDL) {
        if (re.test(flat)) notes.push({ kind, text: flat.slice(0, 100) })
      }
      continue
    }

    const create = flat.match(CREATE_RE)
    if (create) {
      const q = parseFunctionName(`${create[1] || ''}${create[2]}`)
      const args = innerParens(flat, create[0].length - 1)
      if (q && args !== null) add(q, signatureOf(args))
      else notes.push({ kind: 'unparsed-create', text: flat.slice(0, 100) })
      continue
    }

    const drop = flat.match(DROP_RE)
    if (drop) {
      for (const item of splitTopLevel(drop[1])) {
        const m = item.trim().match(DROP_ITEM_RE)
        if (!m) { notes.push({ kind: 'unparsed-drop', text: item }); continue }
        const q = parseFunctionName(`${m[1] || ''}${m[2]}`)
        const sig = m[3] === undefined ? undefined : signatureOf(m[4])
        // A DROP … IF EXISTS of something never created is normal; a DROP of
        // a KNOWN name whose signature did not match is a replay miss: say so.
        if (!remove(q, sig) && functions.has(keyOf(q))) notes.push({ kind: 'unmatched-drop', text: item })
      }
      continue
    }

    const alter = flat.match(ALTER_RE)
    if (alter) {
      const q = parseFunctionName(`${alter[1] || ''}${alter[2]}`)
      const k = keyOf(q)
      if (!functions.has(k)) { notes.push({ kind: 'alter-unknown', text: flat.slice(0, 100) }); continue }
      const sigs = alter[3] === undefined ? [...functions.get(k)] : [signatureOf(alter[4])]
      const target = alter[5]
        ? { schema: q.schema, name: fold(alter[5]) }
        : { schema: fold(alter[6]), name: q.name }
      for (const sig of sigs) {
        if (remove(q, sig)) add(target, sig)
        else notes.push({ kind: 'unmatched-alter', text: flat.slice(0, 100) })
      }
    }
  }
  return { functions, notes }
}

/** Replay every .sql migration in filename order → { functions, notes }. */
export function collectFunctions(migrationsDir) {
  const functions = new Map()
  const notes = []
  for (const f of fs.readdirSync(migrationsDir).sort()) {
    if (!f.endsWith('.sql')) continue
    const before = notes.length
    applyFunctionDdl(fs.readFileSync(path.join(migrationsDir, f), 'utf8'), functions, notes)
    for (let i = before; i < notes.length; i++) notes[i].file = f
  }
  return { functions, notes }
}

/** Is `name` reachable through `.rpc()` (any overload in the exposed schema)? */
export function isCallable(functions, name) {
  return functions.has(`${RPC_SCHEMA}.${name}`)
}

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

// A plain string literal: '…', "…" or a `…` with no ${}. Anything else is
// "not a literal" (a variable, a template with ${}, a call).
const LITERAL_ARG_RE = /^\s*(['"`])([^'"`$\\\n]*)\1\s*[,)]/

/** `.rpc(` call sites in one file (comments masked): [{ name|null, offset }]. */
export function collectRpcCalls(src) {
  const masked = maskComments(src)
  const out = []
  for (const m of masked.matchAll(/\.\s*rpc\s*\(/g)) {
    const lit = masked.slice(m.index + m[0].length).match(LITERAL_ARG_RE)
    out.push({ name: lit ? lit[2] : null, offset: m.index })
  }
  return out
}

/** The names one RPC_INDIRECT source yields: [{ name|null, offset }]. */
export function collectIndirectNames(src, source) {
  const masked = maskComments(src)
  const out = []
  if (source.callee) {
    for (const m of masked.matchAll(new RegExp(`(?<![\\w.$])${source.callee}\\s*\\(`, 'g'))) {
      // The wrapper's own declaration is not a call.
      if (/\bfunction\s+$/.test(masked.slice(Math.max(0, m.index - 20), m.index))) continue
      const inner = innerParens(masked, m.index + m[0].length - 1)
      if (inner === null) continue
      const arg = splitTopLevel(inner)[source.arg]
      const lit = arg && arg.trim().match(/^(['"`])(\w+)\1$/)
      out.push({ name: lit ? lit[2] : null, offset: m.index })
    }
  }
  if (source.property) {
    for (const m of masked.matchAll(new RegExp(`\\b${source.property}\\s*:\\s*(['"\`])(\\w+)\\1`, 'g'))) {
      out.push({ name: m[2], offset: m.index })
    }
  }
  return out
}

export function walkSources(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) walkSources(p, out)
    } else if (SOURCE_RE.test(entry.name) && !TEST_RE.test(entry.name)) out.push(p)
  }
  return out
}

/**
 * Check every name the tree hands to `.rpc()`. Pure over `readFile` (tests
 * pass an in-memory tree). `files` are repo-relative paths.
 */
export function scanTree(files, readFile, functions, indirect = RPC_INDIRECT) {
  const hits = []
  const unreadable = []
  const staleIndirect = []
  let resolved = 0
  const rel = (f) => f.split(path.sep).join('/')
  const coverage = new Map(indirect.map((e) => [e.site, 0]))
  for (const file of files) {
    const r = rel(file)
    const src = readFile(file)
    for (const call of collectRpcCalls(src)) {
      if (call.name === null) {
        if (coverage.has(r)) coverage.set(r, coverage.get(r) + 1)
        else unreadable.push({ file: r, line: lineOf(src, call.offset) })
        continue
      }
      if (isCallable(functions, call.name)) { resolved++; continue }
      hits.push({ file: r, line: lineOf(src, call.offset), name: call.name, via: '.rpc()' })
    }
  }
  for (const e of indirect) {
    if (!coverage.get(e.site)) { staleIndirect.push(e); continue }
    const src = readFile(e.source.file)
    const names = collectIndirectNames(src, e.source)
    if (names.length === 0) { staleIndirect.push(e); continue }
    for (const n of names) {
      if (n.name === null) { unreadable.push({ file: e.source.file, line: lineOf(src, n.offset) }); continue }
      if (isCallable(functions, n.name)) { resolved++; continue }
      hits.push({
        file: e.source.file, line: lineOf(src, n.offset), name: n.name,
        via: e.source.callee ? `${e.source.callee}()` : `${e.source.property}:`,
      })
    }
  }
  return { hits, unreadable, staleIndirect, resolved }
}

// ---------------------------------------------------------------------------
// Allowlist (the .select-columns-allowlist.json semantics)
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = ['file', 'name', 'reason', 'expires']

export function validateAllowlist(entries) {
  const problems = []
  for (const entry of entries || []) {
    for (const field of REQUIRED_FIELDS) {
      if (!entry?.[field]) problems.push(`entry ${JSON.stringify(entry)} is missing "${field}"`)
    }
    if (entry?.expires && !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      problems.push(`${entry.file}:${entry.name} has expires="${entry.expires}" (want YYYY-MM-DD)`)
    }
  }
  return problems
}

/** `today` is passed in (never read from the clock here): expiry is testable. */
export function classifyHits(hits, entries, today) {
  const byKey = new Map((entries || []).map((e) => [`${e.file}|${e.name}`, e]))
  const failures = []
  const allowed = []
  const expired = []
  const used = new Set()
  for (const hit of hits) {
    const k = `${hit.file}|${hit.name}`
    const entry = byKey.get(k)
    if (!entry) { failures.push(hit); continue }
    used.add(k)
    if (entry.expires < today) { expired.push({ ...hit, entry }); failures.push(hit) }
    else allowed.push({ ...hit, entry })
  }
  const stale = (entries || []).filter((e) => !used.has(`${e.file}|${e.name}`))
  return { failures, allowed, expired, stale }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function readAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return []
  try {
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')).entries || []
  } catch (err) {
    console.error(`✗ ${ALLOWLIST_PATH} is not valid JSON: ${err.message}`)
    process.exit(1)
  }
}

function main() {
  const { functions, notes } = collectFunctions(MIGRATIONS_ROOT)
  const entries = readAllowlist()
  const problems = validateAllowlist(entries)
  if (problems.length) {
    console.error(`✗ ${ALLOWLIST_PATH} is malformed:`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\n  Every entry needs file, name, reason and expires (YYYY-MM-DD).\n')
    process.exit(1)
  }

  const files = SOURCE_ROOTS.flatMap((root) => walkSources(root))
  const { hits, unreadable, staleIndirect, resolved } =
    scanTree(files, (f) => fs.readFileSync(f, 'utf8'), functions)
  const today = new Date().toISOString().slice(0, 10)
  const { failures, allowed, expired, stale } = classifyHits(hits, entries, today)

  for (const a of allowed) console.log(`✓ ALLOWED  ${a.file}  ${a.name}  (expires ${a.entry.expires}): ${a.entry.reason}`)
  for (const s of stale) console.log(`  ⚠ stale allowlist entry (no longer hit): ${s.file} ${s.name}`)
  for (const n of notes) console.log(`  · replay note (${n.kind}) ${n.file}: ${n.text}`)

  if (failures.length === 0 && unreadable.length === 0 && staleIndirect.length === 0) {
    const pub = [...functions.keys()].filter((k) => k.startsWith(`${RPC_SCHEMA}.`)).length
    console.log(
      `✓ rpc names: ${pub} ${RPC_SCHEMA} functions (replayed from ${MIGRATIONS_ROOT}), ` +
      `${files.length} source files, ${resolved} rpc name use(s) resolved, ${allowed.length} allowlisted`,
    )
    process.exit(0)
  }

  for (const e of expired) console.error(`✗ EXPIRED ALLOWLIST ENTRY: ${e.file} ${e.name} (expired ${e.entry.expires})`)
  for (const f of failures) console.error(`✗ PHANTOM RPC: ${f.file}:${f.line}  ${f.name}  (via ${f.via})`)
  for (const u of unreadable) console.error(`✗ UNREADABLE RPC NAME: ${u.file}:${u.line}  (declare where the name comes from in RPC_INDIRECT)`)
  for (const s of staleIndirect) console.error(`✗ STALE RPC_INDIRECT ENTRY: ${s.site} (no non-literal .rpc() there, or ${s.source.file} yields no names)`)
  console.error(`
A name passed to .rpc() must be a function the migrations create in schema
${RPC_SCHEMA}. PostgREST answers anything else with a 404, and supabase-js
RESOLVES with { error } instead of throwing, so a best-effort call turns it
into a feature that silently never works (C61/C71: counters that never moved).
Fix by either:
  1. Correcting the name (supabase/migrations, or pg_proc via the Supabase MCP).
  2. Creating the function in a forward-only migration.
  3. Deleting the call, if nothing needs what it did.
  4. Only when the function genuinely exists in prod and this replay cannot
     read its DDL: an entry in ${ALLOWLIST_PATH} naming the file, the name,
     HOW you verified it (pg_proc on the live project), and a short \`expires\`.
`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
