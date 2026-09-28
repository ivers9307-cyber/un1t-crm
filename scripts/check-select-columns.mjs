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
//      column name on the chain whose text it can READ: the PostgREST select
//      grammar (`a,b`, `alias:col`, `rel(...)`, `rel!fk(...)`, an embed named
//      by its FK column — `alias:fk_col(...)` / `fk_col(...)` — resolved
//      through the FKs the replay also learns (SELCOLS2.1), `*`, `col->>'k'`,
//      casts, aggregates) plus the first argument of
//      `.order/.eq/.neq/.in/.is/.gt/.gte/.lt/.lte/.like/.ilike`. A select
//      string is readable when it is a literal or (SELCOLS2.1) a same-file
//      `const`, template of consts, `+` concatenation or `[…].join()`.
//
// THIS IS A FLOOR, NOT A PROOF — same posture as check-location-scoping and
// check-rls-restrictive. Everything it cannot READ, it SKIPS in silence:
//   - a select string held in a `let`, a parameter, a member, a call, a name
//     declared twice in the file, or a constant IMPORTED from another file
//     (19 sites / 4 constants at SELCOLS2.1, verified clean by hand then),
//     or a template whose `${}` is not a same-file const;
//   - a chain built across statements (`let q = db.from(t); q = q.eq(…)`) —
//     only the links syntactically attached to `.from()` are walked;
//   - `.from(someVar)`, `.rpc()`, and any table the migrations don't define
//     (a skipped view, a `private.` table, a table made by hand);
//   - an embed whose relation name is neither a table nor a single-column FK
//     of its parent (an FK into auth.*, a composite FK, one made outside the
//     migrations or inside a `DO $$` block, e.g. fleet_device_health's) —
//     none in src/ at SELCOLS2.1;
//   - everything outside `src/**` — `mobile/**`, `shared/**` and `tests/**`
//     are not scanned at all.
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
// Foreign keys (SELCOLS2.1) — so `alias:fk_column(…)` can be resolved
// ---------------------------------------------------------------------------
//
// PostgREST lets an embed name its relation by the FOREIGN KEY COLUMN instead
// of the table: `locations:location_id ( name )` on a table whose
// `location_id` references `locations`. Until SELCOLS2.1 walkSelect only
// descended when the relation name was itself a table, so every column
// inside such an embed was skipped in silence (found building LABOUR.1;
// 214 embeds in src/ at the time). Resolving it needs to know where each
// single-column FK points — one more thing the migration replay can learn.

const QUALIFIED = '((?:"?\\w+"?\\s*\\.\\s*)?"?\\w+"?)'
const INLINE_FK_RE = new RegExp(`\\bREFERENCES\\s+${QUALIFIED}`, 'i')
const TABLE_FK_RE = new RegExp(
  `^(?:CONSTRAINT\\s+("?\\w+"?)\\s+)?FOREIGN\\s+KEY\\s*\\(\\s*("?\\w+"?)\\s*\\)\\s*REFERENCES\\s+${QUALIFIED}`, 'i'
)
const NAMED_INLINE_RE = /\bCONSTRAINT\s+("?\w+"?)\s+REFERENCES\b/i

/** A public FK target → its table name; anything else (auth.users, …) → null. */
function publicTarget(raw) {
  const q = parseQualifiedName(raw)
  return q && q.schema === 'public' ? q.name : null
}

/**
 * Single-column foreign keys declared in a CREATE TABLE body (or one ALTER
 * action), as [{ column, target, constraint }]. `constraint` is the explicit
 * name, or Postgres's default `<table>_<column>_fkey`, so a later DROP
 * CONSTRAINT can find it. Composite FKs and FKs into a non-public schema are
 * left out: PostgREST cannot embed through either by column name.
 */
export function parseForeignKeys(table, body) {
  const out = []
  for (const item of splitTopLevel(body)) {
    const tableFk = item.match(TABLE_FK_RE)
    if (tableFk) {
      const column = unquote(tableFk[2])
      const target = publicTarget(tableFk[3])
      const constraint = tableFk[1] ? unquote(tableFk[1]) : `${table}_${column}_fkey`
      if (target) out.push({ column, target, constraint })
      continue
    }
    const first = item.match(/^("[^"]+"|[\w]+)/)
    if (!first) continue
    const column = unquote(first[1])
    if (CONSTRAINT_STARTERS.has(column.toLowerCase())) continue
    const inline = item.match(INLINE_FK_RE)
    if (!inline) continue
    const target = publicTarget(inline[1])
    const named = item.match(NAMED_INLINE_RE)
    const constraint = named ? unquote(named[1]) : `${table}_${column}_fkey`
    if (target) out.push({ column, target, constraint })
  }
  return out
}

function setForeignKey(fks, table, fk) {
  if (!fks.has(table)) fks.set(table, new Map())
  fks.get(table).set(fk.column, { target: fk.target, constraint: fk.constraint })
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
 * `fks` collects single-column foreign keys (SELCOLS2.1).
 */
export function applyMigrationSql(sqlText, schema, skippedViews = new Set(), fks = new Map()) {
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
      for (const fk of parseForeignKeys(q.name, body)) setForeignKey(fks, q.name, fk)
      continue
    }

    const dropTable = /^DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)/i.exec(flat)
    if (dropTable) {
      const q = parseQualifiedName(dropTable[1])
      if (q && q.schema === 'public') { schema.delete(q.name); fks.delete(q.name) }
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
      applyAlterActions(q.name, alter[2], schema, fks)
    }
  }
  return schema
}

/** ADD/DROP/RENAME COLUMN, ADD/DROP CONSTRAINT (FKs) + RENAME TO of one ALTER TABLE. */
function applyAlterActions(table, actionsText, schema, fks = new Map()) {
  // A table rename is a whole-statement action, never comma-listed.
  const renameTable = actionsText.trim().match(/^RENAME\s+TO\s+("?\w+"?)$/i)
  if (renameTable) {
    const to = unquote(renameTable[1])
    if (schema.has(table)) { schema.set(to, schema.get(table)); schema.delete(table) }
    if (fks.has(table)) { fks.set(to, fks.get(table)); fks.delete(table) }
    // FKs are bound to the table, not its name: every FK into it follows.
    for (const byCol of fks.values()) for (const fk of byCol.values()) if (fk.target === table) fk.target = to
    return
  }
  const renameCol = actionsText.trim().match(/^RENAME\s+COLUMN\s+("?\w+"?)\s+TO\s+("?\w+"?)$/i)
  if (renameCol) {
    const from = unquote(renameCol[1])
    const to = unquote(renameCol[2])
    const cols = schema.get(table)
    if (cols) { cols.delete(from); cols.add(to) }
    const byCol = fks.get(table)
    if (byCol?.has(from)) { byCol.set(to, byCol.get(from)); byCol.delete(from) }
    return
  }

  for (const action of splitTopLevel(actionsText)) {
    const add = action.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/i)
    if (add) {
      if (!schema.has(table)) schema.set(table, new Set())
      schema.get(table).add(unquote(add[1]))
      // `ADD COLUMN x uuid REFERENCES t(id)` — the column def is what follows ADD COLUMN.
      const def = action.replace(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?/i, '')
      for (const fk of parseForeignKeys(table, def)) setForeignKey(fks, table, fk)
      continue
    }
    const drop = action.match(/^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("?\w+"?)/i)
    if (drop) {
      schema.get(table)?.delete(unquote(drop[1]))
      fks.get(table)?.delete(unquote(drop[1]))
      continue
    }
    const addFk = action.match(/^ADD\s+((?:CONSTRAINT\s+"?\w+"?\s+)?FOREIGN\s+KEY[\s\S]*)$/i)
    if (addFk) {
      for (const fk of parseForeignKeys(table, addFk[1])) setForeignKey(fks, table, fk)
      continue
    }
    const dropConstraint = action.match(/^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("?\w+"?)/i)
    if (dropConstraint) {
      const name = unquote(dropConstraint[1])
      const byCol = fks.get(table)
      if (byCol) for (const [col, fk] of byCol) if (fk.constraint === name) byCol.delete(col)
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

/** Replay every .sql migration in filename order → { schema, skippedViews, fks }. */
export function collectSchema(migrationsDir) {
  const schema = new Map()
  const skippedViews = new Set()
  const fks = new Map()
  for (const f of fs.readdirSync(migrationsDir).sort()) {
    if (!f.endsWith('.sql')) continue
    applyMigrationSql(fs.readFileSync(path.join(migrationsDir, f), 'utf8'), schema, skippedViews, fks)
  }
  return { schema, skippedViews, fks }
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
 * resources are descended into when the relation name is a known table or
 * (SELCOLS2.1, given `fks`) an FK column of `table`; everything else is
 * dropped in silence.
 */
export function parseSelect(sel, table, schema, fks = new Map()) {
  const refs = []
  walkSelect(cleanSelectString(sel), table, schema, fks, refs)
  return refs
}

/**
 * The table an embed's relation name points at, or null. PostgREST accepts
 * a table (`locations(…)`, `locations!location_id(…)`) or, for a many-to-one,
 * the parent's FK column (`location_id(…)`, `locations:location_id(…)`).
 * Table first, so every embed that resolved before resolves identically.
 */
export function resolveEmbedTarget(rel, table, schema, fks = new Map()) {
  if (schema.has(rel)) return rel
  const fk = fks.get(table)?.get(rel)
  return fk && schema.has(fk.target) ? fk.target : null
}

function walkSelect(sel, table, schema, fks, refs) {
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
      const target = resolveEmbedTarget(rel, table, schema, fks)
      if (inner !== null && target) walkSelect(inner, target, schema, fks, refs)
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

// ---------------------------------------------------------------------------
// Select strings held in a constant (SELCOLS2.1)
// ---------------------------------------------------------------------------
//
// `const COLS = 'id, name'` then `.select(COLS)` was skipped in silence
// (found building REPLACE.1b), and it is the house style for any column list
// used twice. What is readable now, all within ONE file:
//   - an identifier naming a `const` declared exactly once in the file;
//   - a `'…'` / `"…"` / `` `…` `` literal;
//   - a template whose every `${…}` is itself such an identifier;
//   - an array literal of the above, joined: `[ 'a', 'b' ].join(', ')`;
//   - any `+` concatenation of the above.
// Still skipped, deliberately: an imported constant (it lives in another
// file), `let`/`var` (reassignable), a name declared more than once in the
// file (shadowing: we cannot tell which one reaches the call), a member
// (`X.cols`), any other call (`COLS.join(',')` on a named array, `pick()`),
// and any other `${expr}`. Known blind spot: a regex cannot see scopes, so
// a function or arrow PARAMETER, a destructured binding, a second declarator
// (`let a = 1, X = …`) or a `catch (X)` that shadows the file's one `const X`
// still reads as the const. That checks the WRONG string against the chain's
// table: it can raise a false phantom (blocks CI) or count a site as read
// when the value actually passed was never checked. 0 such sites in src/ at
// SELCOLS2.1.

/**
 * Split a call's argument text (or an array literal's body) on top-level
 * commas, JS-literal aware. A trailing comma yields no empty last element.
 */
export function splitArgs(text) {
  const parts = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1 }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter((p, idx, all) => p || idx < all.length - 1)
}

/** The first top-level argument of a call's argument text. */
export function firstArgText(argsText) {
  return splitArgs(argsText)[0] ?? ''
}

/** Offset of the `]` closing the `[` at `openIdx` (JS-literal aware), or -1. */
function closingBracket(s, openIdx) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '[' || c === '(' || c === '{') depth++
    else if (c === ']' || c === ')' || c === '}') { depth--; if (depth === 0) return c === ']' ? i : -1 }
  }
  return -1
}

const ESCAPES = { n: '\n', t: '\t', r: '\r' }
const IDENT_RE = /^[A-Za-z_$][\w$]*/
const JOIN_RE = /^\s*\.\s*join\s*\(\s*(?:(['"])((?:(?!\1)[^\\\n])*)\1\s*)?\)/

/**
 * Evaluate a string expression made only of literals, `+`, `[…].join()` and
 * resolvable identifiers. `lookup(name, seen)` returns a string or null.
 * Returns the string, or null for anything else.
 *
 * `prefix` mode reads a declaration's initializer, which is followed by the
 * rest of the file: it stops at the end of the expression (`;`, `,`, `)`,
 * `}`, or a newline before the next statement) and refuses anything that
 * would continue it (`.trim()`, `?? x`, `[0]`, …).
 */
export function evaluateStringExpr(text, lookup, seen = new Set(), prefix = false) {
  const s = text
  let i = 0
  let out = ''
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      let v = ''
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\') { v += ESCAPES[s[j + 1]] ?? s[j + 1]; j += 2; continue }
        if (c !== '`' && s[j] === '\n') return null
        if (c === '`' && s[j] === '$' && s[j + 1] === '{') {
          const close = s.indexOf('}', j)
          if (close === -1) return null
          const inner = s.slice(j + 2, close).trim()
          const id = inner.match(IDENT_RE)
          if (!id || id[0] !== inner) return null
          const r = lookup(inner, seen)
          if (r === null) return null
          v += r
          j = close + 1
          continue
        }
        v += s[j]
        j++
      }
      if (j >= s.length) return null
      out += v
      i = j + 1
    } else if (c === '[') {
      // `[ 'a', 'b', X ].join(', ')` — the other house way to spell a column list.
      const close = closingBracket(s, i)
      if (close === -1) return null
      const join = s.slice(close + 1).match(JOIN_RE)
      if (!join) return null
      const parts = []
      for (const el of splitArgs(s.slice(i + 1, close))) {
        const v = evaluateStringExpr(el, lookup, seen)
        if (v === null) return null
        parts.push(v)
      }
      out += parts.join(join[1] ? join[2] : ',')
      i = close + 1 + join[0].length
    } else {
      const m = s.slice(i).match(IDENT_RE)
      if (!m) return null
      const r = lookup(m[0], seen)
      if (r === null) return null
      out += r
      i += m[0].length
    }
    // After a token: a `+` continues, the end finishes, anything else refuses
    // (or, in prefix mode, must be something that ends the initializer).
    let k = i
    let sawNewline = false
    while (k < s.length && /\s/.test(s[k])) { if (s[k] === '\n') sawNewline = true; k++ }
    if (k >= s.length) return out
    if (s[k] === '+') { i = k + 1; continue }
    if (!prefix) return null
    if (';,)}'.includes(s[k])) return out
    if (sawNewline && /[A-Za-z_$]/.test(s[k])) return out // next statement (ASI)
    return null
  }
}

/**
 * The text after `const NAME =` when NAME is declared exactly once in the
 * file, and that one declaration is a `const`. Otherwise null. `src` must be
 * comment-masked, so a declaration in a comment does not count.
 */
export function findConstInitializer(src, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  const escaped = name.replace(/\$/g, '\\$')
  const decl = new RegExp(`(?<![\\w$.])(const|let|var|function)\\s+${escaped}(?![\\w$])\\s*(=)?`, 'g')
  const matches = [...src.matchAll(decl)]
  if (matches.length !== 1) return null
  const [m] = matches
  if (m[1] !== 'const' || !m[2]) return null
  return src.slice(m.index + m[0].length)
}

/**
 * The select string a `.select(<args>)` call passes, when it is anything
 * other than the plain literal firstStringArg already reads: an identifier
 * bound to a same-file `const`, a template of such identifiers, a `+`
 * concatenation or a `[…].join()`. `src` is the comment-masked file.
 * Null = unreadable, and the call is skipped exactly as before.
 */
export function resolveSelectArg(argsText, src) {
  const lookup = (name, seen) => {
    if (seen.has(name)) return null // a cycle is not a string
    const init = findConstInitializer(src, name)
    if (init === null) return null
    return evaluateStringExpr(init, lookup, new Set([...seen, name]), true)
  }
  const arg = firstArgText(argsText).trim()
  if (!arg) return null
  return evaluateStringExpr(arg, lookup)
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

export function collectFileRefs(src, schema, fks = new Map()) {
  const refs = []
  const masked = maskComments(src)
  for (const link of extractChainLinks(masked)) {
    if (!schema.has(link.table)) continue
    if (link.method === 'select') {
      const sel = firstStringArg(link.args) ?? resolveSelectArg(link.args, masked)
      if (sel === null) continue
      for (const r of parseSelect(sel, link.table, schema, fks)) {
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
  const { schema, skippedViews, fks } = collectSchema(MIGRATIONS_ROOT)
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
    for (const ref of collectFileRefs(src, schema, fks)) {
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
      `${files.length} source files, ${checked} readable column references resolved, ` +
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
