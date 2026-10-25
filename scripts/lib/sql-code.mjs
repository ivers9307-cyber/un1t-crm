// The one SQL comment stripper (GUARDSTRIP.1, C74). tests/helpers/sql-code.js
// re-exports this file, so the migration guards and the check:* scripts read
// SQL the same way. It replaced two-regex strips (`/\/\*[\s\S]*?\*\//` then
// `/--[^\n]*/`, in either order), which read a '/*' or '--' inside a string,
// or a '/*' inside a line comment, as a comment and hid real code up to the
// next '*/' or end of line; and one-pass strippers that did not pair each
// $tag$ body with its own closing tag, so after a DO block the parity flipped
// and a '/*' inside a later $$ literal hid a real GRANT.

const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/

/**
 * The SQL with its comments blanked (newlines kept, offsets unchanged), by a
 * quote-aware scan: '…' (with '' doubling, and backslash escapes in E'…'),
 * "…" identifiers and $tag$…$tag$ bodies are never read as comment markers,
 * so a '/*' or '--' inside one cannot hide code. Block comments nest, as in
 * Postgres. A dollar-quoted body is scanned the same way on its own (function
 * and DO bodies are SQL too, so a commented-out GRANT inside one is not a
 * decision); its end is found first, so nothing inside can run past it.
 * String contents are kept verbatim: a GRANT run from EXECUTE '…' counts.
 *
 * `{ bodies: 'blank' }` blanks every dollar-quoted body, tags included, for a
 * reader that deliberately ignores what DO blocks and function bodies do
 * (check:rls-restrictive, check:bundle-sql).
 */
export function sqlCode(sql, { bodies = 'code' } = {}) {
  let out = ''
  let i = 0
  const n = sql.length
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += blank(sql.slice(i, stop))
      i = stop
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue }
        j++
      }
      out += blank(sql.slice(i, j))
      i = j
      continue
    }
    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const m = sql.slice(i, i + 256).match(DOLLAR_TAG)
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) { out += bodies === 'blank' ? blank(sql.slice(i)) : sql.slice(i); break }
        out += bodies === 'blank'
          ? blank(sql.slice(i, end + tag.length))
          : tag + sqlCode(sql.slice(i + tag.length, end)) + tag
        i = end + tag.length
        continue
      }
    }
    out += c
    i++
  }
  return out
}

export const ident = (s) => s.trim().replace(/"/g, '').toLowerCase()

/** Split a comma list at depth 0 (parentheses nest). */
export function splitTop(list) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}
