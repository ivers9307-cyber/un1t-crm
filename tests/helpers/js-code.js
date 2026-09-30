// Shared JS helpers for the client-code guards (TABLEDEFAULTACL.1; C74 moves
// the other guards' private copies onto this file). stripComments and
// isClientFile are copied verbatim from tests/function-execute-guard.test.js
// (the GRANTSTRIP.0 / #1857 version: never a comment range at a JSX text).

import ts from 'typescript'
import { stripComments as stripCommentsNoRegex } from '../../scripts/lib/strip-comments.mjs'

/**
 * JS/TS with comments blanked, from the TypeScript parser's own comment
 * ranges, so a '/*' or '//' inside a string, template or regex literal is
 * never read as a comment. A file the parser rejects falls back to the
 * repo's quote-aware state machine (scripts/lib/strip-comments.mjs), never
 * to a regex.
 */
export function stripComments(text) {
  const sf = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  if (sf.parseDiagnostics?.length) {
    const js = ts.createSourceFile('scan.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
    if (js.parseDiagnostics?.length) return stripCommentsNoRegex(text)
    return blankComments(text, js)
  }
  return blankComments(text, sf)
}
function blankComments(text, sf) {
  // JSX text is text: a '/*' or '//' inside it is not a comment. Any node can
  // share a JsxText's pos (its parent's SyntaxList does), so collect the text
  // spans first and drop every "comment" that starts inside one.
  const jsxText = []
  const findText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end])
    for (const child of node.getChildren(sf)) findText(child)
  }
  findText(sf)
  const inJsxText = (pos) => jsxText.some(([a, b]) => pos >= a && pos < b)
  const ranges = new Map()
  const visit = (node) => {
    for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) {
      if (!inJsxText(r.pos)) ranges.set(r.pos, r.end)
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  let out = text
  for (const [pos, end] of ranges) out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end)
  return out
}

export function isClientFile(text) {
  const code = stripComments(text).trimStart()
  // The anon key is what a browser/session client is built from; the service
  // role key never appears next to it in a client-session file.
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) || /\bcreateAuthClient\s*\(/.test(code) ||
    /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}
