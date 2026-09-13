#!/usr/bin/env node
// Phantom-column lint (SELECTCOLS.1) — a column named in a supabase-js
// `.select()` / `.eq()` / `.order()` is a CLAIM ABOUT THE SCHEMA, and until
// this script nothing in CI ever checked it.
//
// The incident it exists to prevent (ENROLFIX.1, #1685, 2026-09-13):
// `src/lib/sequences/enrol.js` selected `created_at` on
// `sequence_enrollments` — a column that has never existed (mig 005 names
// the row's timestamp `enrolled_at`) — since the 2026-05-08 sequences.js
// split. PostgREST 400s that select on EVERY call. The error was DISCARDED
// until ENROLDEDUP.1 (#1480, 20 Aug) correctly made it throw, and from 21
// Aug **every sequence enrolment in the estate failed silently for 24
// days**: 63 contacts enrolled in the 30 days before, 0 after. Four months
// of green tests never noticed, because the mocked `.select()` accepts any
// column string whatsoever. CLAUDE.md already said "check `information_schema`
// before driving a dormant column"; nothing enforced it. This does.
//
// Model:
//   1. Derive the schema by REPLAYING supabase/migrations in filename order
//      — CREATE TABLE (incl. IF NOT EXISTS), ALTER TABLE ADD COLUMN /
//      DROP COLUMN / RENAME COLUMN / RENAME TO, DROP TABLE — so a column
//      that was added and later dropped is correctly absent. A grep for
//      CREATE TABLE would be wrong for exactly the same reason it is wrong
//      in check-rls-restrictive.mjs. Migrations are forward-only and applied
//      exclusively via Supabase MCP, which is the only reason the files are
//      authoritative at all.
//   2. Views count as tables when their select list is resolvable: bare
//      columns, `expr AS alias`, `t.col`, and `alias.*` / `*` expanded
//      against the view's own FROM/JOIN aliases. A view whose list cannot
//      be resolved is skipped BY NAME and the name is printed, so nobody
//      has to guess what the checker declined to read.
//   3. Scan src/**/*.{js,jsx} for `.from('<table>')…` chains and check every
//      PLAIN STRING LITERAL column name on the chain: the PostgREST select
//      grammar (`a,b`, `alias:col`, `rel(...)`, `rel!fk(...)`, `*`,
//      `col->>'k'`, casts, aggregates) plus the first argument of
//      `.order/.eq/.neq/.in/.is/.gt/.gte/.lt/.lte/.like/.ilike`.
//
// THIS IS A FLOOR, NOT A PROOF — same posture as check-location-scoping and
// check-rls-restrictive. Everything it cannot READ, it SKIPS in silence:
//   - a select string built from a variable, a template with `${}`, or a
//     constant imported from elsewhere (very common for shared column lists);
//   - a chain built across statements (`let q = db.from(t); q = q.eq(…)`) —
//     only the links syntactically attached to `.from()` are walked;
//   - `.from(someVar)`, `.rpc()`, and any table the migrations don't define
//     (a skipped view, a `private.` table, a table made by hand);
//   - an embed whose relation name is a FK constraint rather than a table;
//   - `mobile/**` and `tests/**`, which are outside the scan entirely.
// A clean run therefore means "no phantom column among the ones I could
// read", never "every column in the repo exists". Widening what it can read
// is always worth more than tightening what it does with what it reads.
//
// False positives go in `.select-columns-allowlist.json` with a reason and
// an expiry (same semantics as `.audit-allowlist.json`: an expired entry
// FAILS exactly like an unlisted column, so an accept is always a dated
// decision to revisit, never a permanent mute).

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// scripts/lib/strip-comments.mjs is the house comment stripper (EMAIL-MOPUP.5
// — a guard token matched in PROSE once passed check:route-guards). It is not
// reusable *verbatim* here for one reason: it collapses a block comment to a
// single space, which shifts every character offset after it, and this
// checker's whole output is `file:line`. So the same state machine runs in
// LENGTH-PRESERVING mode in maskComments() below — comment bytes become
// spaces, newlines survive — and offsets stay 1:1 with the file on disk.
// Everything else about the original (string- and template-literal handling,
// the deliberate lack of regex-literal awareness) is
// kept verbatim, right down to the `${}` re-entry.

const MIGRATIONS_ROOT = 'supabase/migrations'
const SRC_ROOT = 'src'
const ALLOWLIST_PATH = '.select-columns-allowlist.json'

// Filter methods whose FIRST argument is a column name.
const FILTER_METHODS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'order',
])

// PostgREST aggregate suffixes — `amount.sum()` is not a column reference.
const AGGREGATE_RE = /\.(?:sum|avg|count|max|min)\(\)$/i

// ---------------------------------------------------------------------------
// SQL statement splitting
// ---------------------------------------------------------------------------

/**
 * Split a migration file into top-level statements, correctly skipping
 * `-- …` and `/* … *\/` comments, '…' / "…" literals, and $tag$…$tag$
 * dollar-quoted bodies (146 migrations carry a `do $$ … $$;` block whose
 * inner semicolons would otherwise shred every statement after it).
 * Comments are dropped from the returned text.
 */
export function splitSqlStatements(sql) {
  const out = []
  let cur = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1] || ''
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++
      cur += ' '
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      cur += ' '
      continue
    }
    if (c === "'" || c === '"') {
      cur += c
      i++
      while (i < n && sql[i] !== c) {
        // Standard SQL doubles the quote to escape it; consuming one char at
        // a time handles that naturally (the pair closes then reopens).
        cur += sql[i]
        i++
      }
      if (i < n) { cur += sql[i]; i++ }
      continue
    }
    if (c === '$') {
      const tag = /^\$[a-zA-Z_]\w*\$|^\$\$/.exec(sql.slice(i))
      if (tag) {
        const marker = tag[0]
        const end = sql.indexOf(marker, i + marker.length)
        const stop = end === -1 ? n : end + marker.length
        cur += sql.slice(i, stop)
        i = stop
        continue
      }
    }
    if (c === ';') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur.trim()) out.push(cur)
  return out.filter((s) => s.trim())
}

/** Split on top-level commas, respecting parens and quotes. */
export function splitTopLevel(text, sep = ',') {
  const parts = []
  let cur = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

const unquote = (s) => String(s || '').replace(/^"(.*)"$/, '$1')

/** `public.foo` / `"public"."foo"` / `foo` → { schema, name }. */
function parseQualifiedName(raw) {
  const m = /^(?:("?[\w]+"?)\s*\.\s*)?("?[\w]+"?)$/.exec(String(raw).trim())
  if (!m) return null
  return { schema: unquote(m[1] || 'public').toLowerCase(), name: unquote(m[2]) }
}

// Words that start a TABLE constraint rather than a column definition.
const CONSTRAINT_STARTERS = new Set([
  'constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like',
])

/** Column names from a CREATE TABLE body (the text inside the outer parens). */
export function parseCreateTableBody(body) {
  const cols = []
  for (const item of splitTopLevel(body)) {
    const first = /^("[^"]+"|[\w]+)/.exec(item)
    if (!first) continue
    const name = unquote(first[1])
    if (CONSTRAINT_STARTERS.has(name.toLowerCase())) continue
    cols.push(name)
  }
  return cols
}

// ---------------------------------------------------------------------------
// View select-list resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the output column names of a simple `CREATE VIEW v AS SELECT … FROM …`.
 * Returns null when the list cannot be resolved (the caller then skips the
 * view by name rather than inventing a column set).
 */
export function resolveViewColumns(selectBody, schema) {
  const fromIdx = findTopLevelKeyword(selectBody, 'from')
  if (fromIdx === -1) return null
  const listText = selectBody.slice(0, fromIdx)
  // Keep the FROM keyword: parseFromAliases anchors each source on `from`/`join`.
  const aliases = parseFromAliases(selectBody.slice(fromIdx))
  const cols = []
  for (const rawItem of splitTopLevel(listText)) {
    const item = rawItem.replace(/\s+/g, ' ').trim()
    // `expr AS alias` — the alias IS the output name, whatever the expr is.
    const asMatch = /\s+as\s+("[^"]+"|[\w]+)$/i.exec(item)
    if (asMatch) { cols.push(unquote(asMatch[1])); continue }
    // `c.*` / `*` — expand against the FROM aliases.
    const starMatch = /^(?:([\w"]+)\s*\.\s*)?\*$/.exec(item)
    if (starMatch) {
      const target = starMatch[1] ? aliases.get(unquote(starMatch[1]).toLowerCase()) : aliases.get('*single*')
      if (!target) return null
      const known = schema.get(target)
      if (!known) return null
      for (const c of known) cols.push(c)
      continue
    }
    // A bare column, optionally table-qualified, optionally cast.
    const plain = /^(?:([\w"]+)\s*\.\s*)?("[^"]+"|[\w]+)(?:::[\w\s[\]]+)?$/.exec(item)
    if (plain) { cols.push(unquote(plain[2])); continue }
    return null // an expression with no alias — Postgres names it, we won't guess
  }
  return cols.length ? cols : null
}

/** alias → table name for a view's FROM/JOIN clause; '*single*' = the sole source. */
function parseFromAliases(fromText) {
  const aliases = new Map()
  const cleaned = fromText.replace(/\s+/g, ' ')
  const re = /(?:^|\s)(?:from|join)\s+(?:"?public"?\s*\.\s*)?("[^"]+"|[\w]+)(?:\s+(?:as\s+)?("[^"]+"|[\w]+))?/gi
  const sources = []
  for (const m of cleaned.matchAll(re)) {
    const table = unquote(m[1])
    let alias = m[2] ? unquote(m[2]) : null
    // Don't mistake a following keyword for an alias.
    if (alias && /^(on|where|join|left|right|inner|outer|full|cross|group|order|limit|using|with)$/i.test(alias)) alias = null
    sources.push(table)
    aliases.set((alias || table).toLowerCase(), table)
  }
  if (sources.length === 1) aliases.set('*single*', sources[0])
  return aliases
}

/** Index of a top-level keyword (paren- and quote-aware), or -1. */
function findTopLevelKeyword(text, keyword) {
  let depth = 0
  let quote = null
  const kw = keyword.toLowerCase()
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '(') { depth++; continue }
    if (c === ')') { depth--; continue }
    if (depth !== 0) continue
    if (!/\s/.test(text[i - 1] ?? ' ')) continue
    if (text.slice(i, i + kw.length).toLowerCase() !== kw) continue
    if (/[\w]/.test(text[i + kw.length] || ' ')) continue
    return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Schema replay
// ---------------------------------------------------------------------------

/**
 * Apply one migration file's DDL to a `Map<table, Set<column>>`, in place.
 * `skippedViews` collects view names whose select list we could not resolve.
 */
export function applyMigrationSql(sqlText, schema, skippedViews = new Set()) {
  for (const stmt of splitSqlStatements(sqlText)) {
    const flat = stmt.replace(/\s+/g, ' ').trim()

    const create = /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)\s*\(/i.exec(flat)
    if (create) {
      const q = parseQualifiedName(create[1])
      if (!q || q.schema !== 'public') continue
      // create[0] ends at the table's own open paren, so the body is the
      // balanced slice from exactly there — no re-searching for a '(' that a
      // default expression or a schema-qualified name might have supplied first.
      const body = balancedSlice(flat, create.index + create[0].length - 1)
      if (body === null) continue
      const cols = parseCreateTableBody(body)
      if (!schema.has(q.name)) schema.set(q.name, new Set())
      for (const c of cols) schema.get(q.name).add(c)
      continue
    }

    const dropTable = /^DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)/i.exec(flat)
    if (dropTable) {
      const q = parseQualifiedName(dropTable[1])
      if (q && q.schema === 'public') schema.delete(q.name)
      continue
    }

    const dropView = /^DROP\s+(?:MATERIALIZED\s+)?VIEW(?:\s+IF\s+EXISTS)?\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)/i.exec(flat)
    if (dropView) {
      const q = parseQualifiedName(dropView[1])
      if (q && q.schema === 'public') { schema.delete(q.name); skippedViews.delete(q.name) }
      continue
    }

    const createView = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)/i.exec(flat)
    if (createView) {
      const q = parseQualifiedName(createView[1])
      if (!q || q.schema !== 'public') continue
      const asIdx = findTopLevelKeyword(flat, 'as')
      if (asIdx === -1) { skippedViews.add(q.name); schema.delete(q.name); continue }
      const cols = resolveViewColumns(flat.slice(asIdx + 2).replace(/^\s*select\s+/i, ''), schema)
      if (!cols) { skippedViews.add(q.name); schema.delete(q.name); continue }
      skippedViews.delete(q.name)
      schema.set(q.name, new Set(cols))
      continue
    }

    const alter = /^ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)\s+([\s\S]+)$/i.exec(flat)
    if (alter) {
      const q = parseQualifiedName(alter[1])
      if (!q || q.schema !== 'public') continue
      applyAlterActions(q.name, alter[2], schema)
    }
  }
  return schema
}

/** ADD/DROP/RENAME COLUMN + RENAME TO actions of one ALTER TABLE. */
function applyAlterActions(table, actionsText, schema) {
  // A table rename is a whole-statement action, never comma-listed.
  const renameTable = /^RENAME\s+TO\s+("?\w+"?)$/i.exec(actionsText.trim())
  if (renameTable) {
    const to = unquote(renameTable[1])
    if (schema.has(table)) { schema.set(to, schema.get(table)); schema.delete(table) }
    return
  }
  const renameCol = /^RENAME\s+COLUMN\s+("?\w+"?)\s+TO\s+("?\w+"?)$/i.exec(actionsText.trim())
  if (renameCol) {
    const cols = schema.get(table)
    if (cols) { cols.delete(unquote(renameCol[1])); cols.add(unquote(renameCol[2])) }
    return
  }

  for (const action of splitTopLevel(actionsText)) {
    const add = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/i.exec(action)
    if (add) {
      if (!schema.has(table)) schema.set(table, new Set())
      schema.get(table).add(unquote(add[1]))
      continue
    }
    const drop = /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("?\w+"?)/i.exec(action)
    if (drop) {
      schema.get(table)?.delete(unquote(drop[1]))
      continue
    }
  }
}

/** Text from `text[openIdx]` ('(') to its matching ')', exclusive of both. */
function balancedSlice(text, openIdx, jsMode = false) {
  if (openIdx < 0 || text[openIdx] !== '(') return null
  let depth = 0
  let quote = null
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (jsMode && c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || (jsMode && c === '`')) { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return text.slice(openIdx + 1, i) }
  }
  return null
}

/** Offset just past the ')' that closes the '(' at `openIdx`, JS-literal aware. */
function endOfCall(text, openIdx) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return i + 1 }
  }
  return text.length
}

/** Replay every .sql migration in filename order → { schema, skippedViews }. */
export function collectSchema(migrationsDir) {
  const schema = new Map()
  const skippedViews = new Set()
  for (const f of fs.readdirSync(migrationsDir).sort()) {
    if (!f.endsWith('.sql')) continue
    applyMigrationSql(fs.readFileSync(path.join(migrationsDir, f), 'utf8'), schema, skippedViews)
  }
  return { schema, skippedViews }
}

// ---------------------------------------------------------------------------
// PostgREST select-string parsing
// ---------------------------------------------------------------------------

/** Strip whitespace outside double quotes, the way supabase-js does. */
export function cleanSelectString(sel) {
  let out = ''
  let quoted = false
  for (const c of sel) {
    if (c === '"') quoted = !quoted
    if (!quoted && /\s/.test(c)) continue
    out += c
  }
  return out
}

/**
 * Parse a PostgREST select string against `table`, returning
 * [{ table, column }] for every resolvable column reference. Embedded
 * resources are descended into only when the relation name is a known
 * table; everything else is dropped in silence.
 */
export function parseSelect(sel, table, schema) {
  const refs = []
  walkSelect(cleanSelectString(sel), table, schema, refs)
  return refs
}

function walkSelect(sel, table, schema, refs) {
  for (let item of splitTopLevel(sel)) {
    if (item.startsWith('...')) item = item.slice(3) // spread embed
    if (!item) continue

    const parenIdx = item.indexOf('(')
    if (parenIdx !== -1) {
      // Aggregate on a column: `amount.sum()`.
      if (AGGREGATE_RE.test(item)) {
        const root = item.slice(0, item.lastIndexOf('.'))
        pushColumn(root, table, schema, refs)
        continue
      }
      const head = item.slice(0, parenIdx)
      const inner = balancedSlice(item, parenIdx)
      // `alias:rel!fk` / `rel!inner` / `rel`
      const relRaw = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head
      const rel = unquote(relRaw.split('!')[0])
      if (inner !== null && schema.has(rel)) walkSelect(inner, rel, schema, refs)
      continue
    }
    pushColumn(item, table, schema, refs)
  }
}

function pushColumn(item, table, schema, refs) {
  // ORDER MATTERS: the cast goes first, because `id::text` contains a ':'
  // and would otherwise be read as the alias `id` on a column named ':text'.
  let col = item.split('::')[0] // ::cast
  if (col.includes(':')) col = col.slice(col.indexOf(':') + 1) // alias:column
  col = col.split('!')[0] // column!hint
  col = col.split('->')[0] // JSON path → root column
  col = unquote(col.trim())
  if (!col || col === '*' || col === 'count') return
  if (!/^[A-Za-z_]\w*$/.test(col)) return
  refs.push({ table, column: col })
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

const LITERAL_RE = /^\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1\s*(?:,[\s\S]*)?$/

/** A plain string literal first argument, or null. Template literals with
 *  `${}` and any expression are deliberately unreadable → null → skipped. */
export function firstStringArg(argsText) {
  const m = LITERAL_RE.exec(argsText)
  if (m) return m[2].replace(/\\(['"\\])/g, '$1')
  const tpl = /^\s*`([^`$\\]*)`\s*(?:,[\s\S]*)?$/.exec(argsText)
  return tpl ? tpl[1] : null
}

/**
 * Walk every `.from('<t>')` chain in a source file, yielding
 * [{ table, method, args, index }] for each `.method(args)` link attached
 * to it. `index` is the character offset of the method name (for line
 * numbers). A chain broken across statements simply ends early.
 */
export function extractChainLinks(src) {
  const found = []
  const fromRe = /\.from\(\s*(['"`])([A-Za-z_]\w*)\1\s*\)/g
  for (const m of src.matchAll(fromRe)) {
    const table = m[2]
    let i = m.index + m[0].length
    for (;;) {
      let j = i
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] !== '.') break
      j++
      while (j < src.length && /\s/.test(src[j])) j++
      const nameStart = j
      let name = ''
      while (j < src.length && /[\w$]/.test(src[j])) { name += src[j]; j++ }
      while (j < src.length && /\s/.test(src[j])) j++
      if (!name || src[j] !== '(') break
      const args = balancedSlice(src, j, true)
      if (args === null) break
      found.push({ table, method: name, args, index: nameStart })
      i = endOfCall(src, j)
    }
  }
  return found
}

/**
 * Column references made by one source file, as
 * [{ table, column, offset, via }]. Only known tables and plain string
 * literals produce references; everything else is skipped.
 */
export function maskComments(src) {
  const out = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  const n = src.length
  let state = 'code'
  let braceDepth = 0
  const stack = []
  while (i < n) {
    const c = src[i]
    const d = src[i + 1] || ''
    if (state === 'code') {
      if (c === '/' && d === '/') {
        const start = i
        while (i < n && src[i] !== '\n') i++
        blank(start, i)
        continue
      }
      if (c === '/' && d === '*') {
        const start = i
        i += 2
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
        i = Math.min(i + 2, n)
        blank(start, i)
        continue
      }
      if (c === "'" || c === '"') {
        i++
        while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++ }
        i++
        continue
      }
      if (c === '`') { i++; state = 'tpl'; continue }
      if (stack.length) {
        if (c === '{') { braceDepth++; i++; continue }
        if (c === '}') {
          if (braceDepth === 0) { braceDepth = stack.pop(); state = 'tpl' } else braceDepth--
          i++
          continue
        }
      }
      i++
      continue
    }
    if (c === '\\' && d) { i += 2; continue }
    if (c === '`') { i++; state = 'code'; continue }
    if (c === '$' && d === '{') { i += 2; stack.push(braceDepth); braceDepth = 0; state = 'code'; continue }
    i++
  }
  return out.join('')
}

export function collectFileRefs(src, schema) {
  const refs = []
  for (const link of extractChainLinks(maskComments(src))) {
    if (!schema.has(link.table)) continue
    if (link.method === 'select') {
      const sel = firstStringArg(link.args)
      if (sel === null) continue
      for (const r of parseSelect(sel, link.table, schema)) {
        refs.push({ ...r, offset: link.index, via: 'select' })
      }
      continue
    }
    if (!FILTER_METHODS.has(link.method)) continue
    // An embedded-resource filter ('parent.location_id') or a foreignTable
    // option retargets the column at another relation — not ours to judge.
    if (/\b(?:foreignTable|referencedTable)\b/.test(link.args)) continue
    const raw = firstStringArg(link.args)
    if (raw === null) continue
    if (raw.includes('.')) continue
    const col = raw.split('->')[0].trim()
    if (!/^[A-Za-z_]\w*$/.test(col)) continue
    refs.push({ table: link.table, column: col, offset: link.index, via: link.method })
  }
  return refs
}

/** Character offset → 1-based line number. */
export function lineOf(src, offset) {
  let line = 1
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++
  return line
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = ['file', 'table', 'column', 'reason', 'expires']

export function validateAllowlist(entries) {
  const problems = []
  for (const entry of entries || []) {
    for (const field of REQUIRED_FIELDS) {
      if (!entry?.[field]) problems.push(`entry ${JSON.stringify(entry)} is missing "${field}"`)
    }
    if (entry?.expires && !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      problems.push(`${entry.file}:${entry.table}.${entry.column} has expires="${entry.expires}" (want YYYY-MM-DD)`)
    }
  }
  return problems
}

/**
 * Split raw hits against the allowlist. `today` is passed in (never read
 * from the clock here) so expiry behaviour is deterministic under test.
 * An EXPIRED entry does not suppress — it fails like an unlisted column,
 * plus its own louder message. Entries cannot rot.
 */
export function classifyHits(hits, entries, today) {
  const byKey = new Map((entries || []).map((e) => [`${e.file}|${e.table}|${e.column}`, e]))
  const failures = []
  const allowed = []
  const expired = []
  const usedKeys = new Set()

  for (const hit of hits) {
    const key = `${hit.file}|${hit.table}|${hit.column}`
    const entry = byKey.get(key)
    if (!entry) { failures.push(hit); continue }
    usedKeys.add(key)
    // Lexicographic compare is correct and timezone-free for zero-padded
    // YYYY-MM-DD, which validateAllowlist has enforced.
    if (entry.expires < today) { expired.push({ ...hit, entry }); failures.push(hit) }
    else allowed.push({ ...hit, entry })
  }

  const stale = (entries || []).filter((e) => !usedKeys.has(`${e.file}|${e.table}|${e.column}`))
  return { failures, allowed, expired, stale }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function walkSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkSources(p, out)
    else if (/\.jsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

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
  const { schema, skippedViews } = collectSchema(MIGRATIONS_ROOT)
  const entries = readAllowlist()
  const problems = validateAllowlist(entries)
  if (problems.length) {
    console.error(`✗ ${ALLOWLIST_PATH} is malformed:`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\n  Every entry needs file, table, column, reason and expires (YYYY-MM-DD).\n')
    process.exit(1)
  }

  const hits = []
  let checked = 0
  const files = walkSources(SRC_ROOT)
  for (const file of files) {
    const rel = file.split(path.sep).join('/')
    const src = fs.readFileSync(file, 'utf8')
    for (const ref of collectFileRefs(src, schema)) {
      checked++
      if (schema.get(ref.table).has(ref.column)) continue
      hits.push({ file: rel, line: lineOf(src, ref.offset), ...ref })
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const { failures, allowed, expired, stale } = classifyHits(hits, entries, today)

  for (const a of allowed) {
    console.log(`✓ ALLOWED  ${a.file}  ${a.table}.${a.column}  (expires ${a.entry.expires}) — ${a.entry.reason}`)
  }
  for (const s of stale) {
    console.log(`  ⚠ stale allowlist entry (no longer hit): ${s.file} ${s.table}.${s.column}`)
  }

  if (failures.length === 0) {
    console.log(
      `✓ select columns: ${schema.size} tables/views (replayed from ${MIGRATIONS_ROOT}), ` +
      `${files.length} source files, ${checked} literal column references resolved, ` +
      `${allowed.length} allowlisted` +
      (skippedViews.size ? `; ${skippedViews.size} view(s) skipped (unreadable select list): ${[...skippedViews].sort().join(', ')}` : '')
    )
    process.exit(0)
  }

  for (const e of expired) {
    console.error(`✗ EXPIRED ALLOWLIST ENTRY: ${e.file} ${e.table}.${e.column} (expired ${e.entry.expires})`)
  }
  for (const f of failures) {
    console.error(`✗ PHANTOM COLUMN: ${f.file}:${f.line}  ${f.table}.${f.column}  (via .${f.via}())`)
  }
  console.error(`
${failures.length} column reference(s) name a column that the migrations do not
define on that table. PostgREST answers such a select with a 400 — and a
discarded error turns that into a feature that silently never works (#1685:
every sequence enrolment in the estate, for 24 days). Fix by either:
  1. Correcting the column name (check the CREATE TABLE in supabase/migrations,
     or \`information_schema.columns\` via the Supabase MCP).
  2. Adding the missing column in a forward-only migration.
  3. If the column genuinely exists but this script cannot read the migration
     that adds it, adding an entry to ${ALLOWLIST_PATH} naming the file, table,
     column, the REASON you verified it against the live schema, and a short
     \`expires\` date. Entries cannot rot: past that date the gate fails again.
`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
