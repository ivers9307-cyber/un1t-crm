// A static scan of PostgREST calls: which (table, column) pairs a file's code
// reads, and which tables it writes. A floor, not a proof: a select string
// built at runtime is invisible. Shared by the column-grant guards
// (SECFIX.3c; generalised from tests/shift-column-grants-guard.test.js, which
// keeps its inline copy for now).

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
 * @returns {{ reads: [string,string][], writes: [string,string][] }}
 */
export function columnUses(text, tables, fkAliases = {}) {
  const alt = tables.join('|')
  const reads = []
  const writes = []
  const selectStrings = [...text.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)]

  // (a) `.from('<table>')…` — the chain's own select list, filters and writes,
  //     up to the next statement boundary.
  for (const m of text.matchAll(new RegExp(`\\.from\\(\\s*['"\`](${alt})['"\`]\\s*\\)`, 'g'))) {
    const tail = text.slice(m.index, m.index + 1200)
    const end = tail.search(/\n\s*\n|\bawait\b(?!\s*$)|;|\]\)/)
    const chain = end > 0 ? tail.slice(0, end) : tail
    const sel = selectStrings.find((s) => s.index > m.index && s.index - m.index < 400)
    if (sel && sel.index - m.index < chain.length + 50) for (const c of topLevelColumns(sel[2])) reads.push([m[1], c])
    if (/\.select\(\s*\)/.test(chain)) reads.push([m[1], '*'])
    for (const f of chain.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|in|is|like|ilike|contains|order|not|filter|match)\(\s*['"`]([a-z_]+)['"`]/g)) reads.push([m[1], f[1]])
    for (const w of chain.matchAll(/\.(update|insert|upsert|delete)\(/g)) writes.push([m[1], w[1]])
  }

  for (const s of selectStrings) {
    const list = s[2]
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
  for (const f of text.matchAll(new RegExp(`(['"])(${alt})\\.([a-z_]+)\\1`, 'g'))) reads.push([f[2], f[3]])
  return { reads, writes }
}
