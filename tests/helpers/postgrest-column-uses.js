// A static scan of PostgREST calls: which (table, column) pairs a file's code
// reads, and which tables it writes. A floor, not a proof: a select string
// built at runtime is invisible. Shared by the column-grant guards
// (SECFIX.3c; generalised from tests/shift-column-grants-guard.test.js, which
// keeps its inline copy for now).

import {
  extractChainLinks, firstArgText, firstStringArg, maskComments, resolveSelectArg,
} from '../../scripts/check-select-columns.mjs'

/**
 * FK column → target table, for every single-column FK (learned by the
 * migrations replay in scripts/check-select-columns.mjs: `collectSchema().fks`)
 * whose target is one of `tables`. PostgREST embeds through the FK column
 * (`location_id ( … )`, `anchor:anchor_location_id ( … )`), so each one is a
 * read path into the target. Throws if one column name points at two of
 * `tables` from different parents: a name-only scan could not tell them apart.
 * @param {Map<string, Map<string, {target: string}>>} fks
 * @param {string[]} tables
 */
export function fkAliasesInto(fks, tables) {
  const out = {}
  for (const [parent, cols] of fks) {
    for (const [col, { target }] of cols) {
      if (!tables.includes(target)) continue
      if (out[col] && out[col] !== target) throw new Error(`${parent}.${col} → ${target}, but ${col} also → ${out[col]}`)
      out[col] = target
    }
  }
  return out
}

const WRITE_METHODS = new Set(['update', 'insert', 'upsert', 'delete'])
const FILTER_METHODS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike', 'contains',
  'order', 'not', 'filter', 'match'])

/** A call's argument text: from the '(' at `open` to its match, JS-literal aware. */
function callArgs(src, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  return null
}

/** The text inside the parenthesis that opens at `open` (balanced). */
export function balanced(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

/** Top-level column names of a PostgREST select list (embeds skipped). */
export function topLevelColumns(list) {
  const cols = []
  let depth = 0
  let cur = ''
  for (const ch of list + ',') {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      const item = cur.trim()
      cur = ''
      if (!item || item.includes('(') || item.startsWith('${')) continue // embed or interpolation
      const name = item.split(':').pop().split('::')[0].split('->')[0].trim()
      if (name === 'count') continue // PostgREST aggregate: needs no column
      cols.push(name)
    } else cur += ch
  }
  return cols
}

/**
 * @param {string} text   source
 * @param {string[]} tables
 * @param {Record<string,string>} fkAliases  FK column → table, for `alias:fk_col ( … )` embeds
 * @returns {{ reads: [string,string][], writes: [string,string][], unresolved: [string,string][] }}
 *   unresolved = [table, arg text] for a select on one of `tables` whose
 *   string the scanner cannot evaluate: it could name any column, so the
 *   caller must fail closed on it.
 */
export function columnUses(text, tables, fkAliases = {}) {
  const alt = tables.join('|')
  const reads = []
  const writes = []
  const unresolved = []
  const src = maskComments(text)
  // A select string is a literal or (as check:select-columns reads it since
  // SELCOLS2.1) a same-file const, a template of consts, `+` or `[…].join()`.
  const readSelect = (args) => firstStringArg(args) ?? resolveSelectArg(args, src)
  // Every `.select(…)` in the file, for the embed scan below. A string that
  // cannot be evaluated still gives up its literal text (a template with a
  // dynamic `${}`), so an embed spelled out in it is still seen.
  const selectStrings = []
  for (const m of src.matchAll(/\.select\(/g)) {
    const args = callArgs(src, m.index + m[0].length - 1)
    if (args == null) continue
    const sel = readSelect(args) ?? /^\s*(['"`])([\s\S]*?)\1/.exec(args)?.[2]
    if (sel != null) selectStrings.push(sel)
  }

  // (a) `.from('<table>')…` — every link attached to the chain (walked call by
  //     call, as check:select-columns does, so no fixed window): its own
  //     select list, filters and writes.
  for (const link of extractChainLinks(src)) {
    const table = link.table
    if (!tables.includes(table)) continue
    const { method, args } = link
    if (method === 'select') {
      if (!args.trim()) { reads.push([table, '*']); continue }
      const sel = readSelect(args)
      if (sel == null) unresolved.push([table, firstArgText(args).trim()])
      else for (const c of topLevelColumns(sel)) reads.push([table, c])
      continue
    }
    if (WRITE_METHODS.has(method)) { writes.push([table, method]); continue }
    if (FILTER_METHODS.has(method)) {
      const col = firstStringArg(args)
      if (col != null && /^[a-z_]+$/.test(col)) reads.push([table, col])
    }
  }

  for (const list of selectStrings) {
    // (b) Embeds anywhere in a select: `[alias:]<table>[!hint] ( … )`.
    //     Lookbehind, not a consumed prefix: a nested embed starts right after
    //     its parent's '('.
    for (const e of list.matchAll(new RegExp(`(?<=^|[\\s,(:])(${alt})(?:![a-z_]+)?\\s*\\(`, 'g'))) {
      const inner = balanced(list, e.index + e[0].length - 1)
      if (inner != null) for (const c of topLevelColumns(inner)) reads.push([e[1], c])
    }
    // (c) FK-column embeds: `[alias:]location_id ( … )` reads the FK's table.
    //     The alias is optional: PostgREST embeds through a bare FK column.
    for (const [fk, table] of Object.entries(fkAliases)) {
      for (const e of list.matchAll(new RegExp(`(?<=^|[\\s,(])(?:[a-z_]+\\s*:\\s*)?${fk}(?:![a-z_]+)?\\s*\\(`, 'g'))) {
        const inner = balanced(list, e.index + e[0].length - 1)
        if (inner != null) for (const c of topLevelColumns(inner)) reads.push([table, c])
      }
    }
  }

  // (d) Dotted filters: `.eq('locations.settings', …)`. Single/double quotes
  //     only: a backticked `locations.color` is how the codebase's COMMENTS
  //     name a column (shared/location-colors.js, AdsIntegrationTab), and a
  //     filter column is never a template literal here.
  for (const f of src.matchAll(new RegExp(`(['"])(${alt})\\.([a-z_]+)\\1`, 'g'))) reads.push([f[2], f[3]])
  return { reads, writes, unresolved }
}
