// Strip JS comments before token matching (EMAIL-MOPUP.5, 2026-08-08 audit).
//
// The #1266 incident: check:route-guards matched guard tokens over raw file
// contents, and the literal `hasPermission(` matched PROSE in a header
// comment — a route whose only mention of a guard survives in a comment
// after the real call is deleted would pass the lint. The checker's own
// comment block narrated the hole without closing it. This closes it.
//
// A small state machine, not a regex: line + block comments removed; the
// contents of '…', "…" and `…` template literals kept verbatim (a token
// inside a string is unusual but must not vanish — see the template test);
// comments inside a template's ${} expressions removed like any other code.
//
// KNOWN LIMIT, on purpose: no regex-literal awareness. A `//` or `/*` inside
// a regex literal is over-stripped, which can only LOSE tokens — the checker
// then fails LOUDLY on a guarded route, never quietly passes an unguarded
// one. The right failure direction for a guard lint, and cheap to spot.

export function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  // 'code' | 'tpl'. Entering a ${} expression pushes the surrounding
  // template's brace depth so nested templates unwind correctly.
  let state = 'code'
  let braceDepth = 0
  const stack = []

  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''

    if (state === 'code') {
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') i++
        continue // the \n itself is kept on the next pass
      }
      if (c === '/' && d === '*') {
        i += 2
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
        i += 2
        // Keep token boundaries honest: two names separated only by a block
        // comment must not fuse into one.
        out += ' '
        continue
      }
      if (c === "'" || c === '"') {
        out += c
        i++
        while (i < n && src[i] !== c) {
          if (src[i] === '\\' && i + 1 < n) { out += src[i]; i++ }
          out += src[i]
          i++
        }
        if (i < n) { out += src[i]; i++ }
        continue
      }
      if (c === '`') { out += c; i++; state = 'tpl'; continue }
      if (stack.length) {
        if (c === '{') { braceDepth++; out += c; i++; continue }
        if (c === '}') {
          if (braceDepth === 0) { braceDepth = stack.pop(); state = 'tpl'; out += c; i++; continue }
          braceDepth--
          out += c
          i++
          continue
        }
      }
      out += c
      i++
      continue
    }

    // Inside a template literal.
    if (c === '\\' && d) { out += c + d; i += 2; continue }
    if (c === '`') { out += c; i++; state = 'code'; continue }
    if (c === '$' && d === '{') {
      out += '${'
      i += 2
      stack.push(braceDepth)
      braceDepth = 0
      state = 'code'
      continue
    }
    out += c
    i++
  }

  return out
}
