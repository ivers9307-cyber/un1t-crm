// PAIRSYNC.1 — extract the SOURCE of each top-level named export from a module.
//
// Why this exists: several modules live twice in this repo (`src/lib/x.js`
// and `shared/x.js`) because mobile cannot import `src/lib` — `shared/` is
// the seam. A pile of those carry header comments asserting the copies are
// "byte-identical" or must be "KEPT IN SYNC". Comments do not fail CI, and at
// least three pairs had already drifted by the time the comment was written.
// tests/shared-pair-sync.test.js turns those assertions into assertions the
// test runner can check; this module is the part that reads the source.
//
// Whole-file comparison is the wrong instrument for a pair that LEGITIMATELY
// differs — an import specifier (`'./dublin-time.js'` vs `'@/lib/dublin-time'`),
// a header paragraph, or a web-only helper the mobile seam has no use for. So
// the comparison happens per EXPORT: the shared copy's exports must match the
// web copy's exports of the same name, and anything extra on either side has
// to be declared in the manifest.
//
// The extractor is deliberately dumb-but-bounded: comments are stripped first
// (scripts/lib/strip-comments.mjs), then each `export <decl> <name>` is sliced
// to the end of its own declaration by balancing (), [] and {} with string
// literals masked. It does NOT parse JavaScript. Its failure direction is
// chosen: an unbalanced or unrecognised construct yields a LONGER slice (it
// runs on to later lines), which can make two copies look DIFFERENT that are
// in fact the same — a loud, inspectable failure — never the reverse.
//
// KNOWN LIMITS, on purpose:
//   • `export { a, b } from './x'` re-export lists are reported by
//     collectExportNames() but have no body to compare; the manifest's
//     `reexport` mode checks those by RUNTIME IDENTITY instead (the web
//     module's binding must be the very same object as the shared one),
//     which is strictly stronger than any text comparison.
//   • `export default` is not covered — no module in either directory uses it.
//   • No regex-literal awareness, inherited from stripComments. A `/` inside
//     a character class can only over-strip, i.e. lengthen a slice.

import { stripComments } from './strip-comments.mjs'

const DECL = /^export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/

/** Replace the CONTENTS of string/template literals with spaces so their
 *  brackets never move the depth counter. Both length AND line count are
 *  preserved, so an index or a line number computed on the masked text
 *  addresses the same place in the original.
 *
 *  NEWLINES ARE NEVER MASKED. Blanking them preserved character count but not
 *  LINE count, and exportBodies() walks the two texts by line index — so a
 *  module containing a multi-line template literal produced a `maskedLines`
 *  array shorter than `lines`, and the balancing loop read past its end and
 *  threw `maskedLines[j] is not iterable`. Measured on this tree: 22 files
 *  under src/lib/ crashed the extractor that way, every one of them a module
 *  that builds an email or a prompt from a multi-line template. None were
 *  reachable from the pair manifest when this was written, which is exactly
 *  why it went unnoticed until the cross-named sweep in
 *  tests/shared-pair-sync.test.js started reading every file in both trees.
 *  A newline cannot affect bracket depth, so keeping it costs nothing. */
function maskStrings(src) {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          if (src[i] !== '\n') out[i] = ' '
          i++
          if (i < src.length) { if (src[i] !== '\n') out[i] = ' '; i++ }
          continue
        }
        if (src[i] !== '\n') out[i] = ' '
        i++
      }
      i++
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Source text of every top-level named export, keyed by export name.
 * Values are the declaration's own source with comments removed and runs of
 * whitespace collapsed — so reindenting a copy does not read as drift, but
 * changing a token does.
 *
 * @param {string} src  module source
 * @returns {Record<string,string>}
 */
export function exportBodies(src) {
  const code = stripComments(src)
  const masked = maskStrings(code)
  const lines = code.split('\n')
  const maskedLines = masked.split('\n')

  const out = {}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DECL)
    if (!m) continue
    let depth = 0
    let seenOpen = false
    let end = i
    for (let j = i; j < lines.length; j++) {
      for (const ch of maskedLines[j]) {
        if (ch === '{' || ch === '(' || ch === '[') { depth++; seenOpen = true }
        else if (ch === '}' || ch === ')' || ch === ']') depth--
      }
      end = j
      // A declaration ends when every bracket it opened is closed. A
      // single-line `export const X = 1` opens none, so it ends on its
      // own line; `export function f() {}` ends when depth returns to 0.
      if (depth <= 0 && (seenOpen || j === i)) break
    }
    out[m[1]] = lines.slice(i, end + 1).join('\n').replace(/\s+/g, ' ').trim()
    i = end
  }
  return out
}

/**
 * Every top-level export NAME a module publishes, including the names in
 * `export { … }` lists and `export { … } from '…'` re-exports. `export *`
 * is reported as the literal '*' — it cannot be enumerated statically.
 *
 * @param {string} src  module source
 * @returns {string[]} sorted, de-duplicated
 */
export function collectExportNames(src) {
  const code = stripComments(src)
  const names = new Set(Object.keys(exportBodies(code)))
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  if (/export\s*\*\s*from/.test(code)) names.add('*')
  return [...names].sort()
}
