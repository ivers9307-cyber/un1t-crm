// Shared JS helpers for every guard that reads source code (TABLEDEFAULTACL.1;
// GUARDSTRIP.1, C74, moved the other guards onto this file). Never strip JS
// comments with a regex: `/\/\*[\s\S]*?\*\//` reads the '/*' in
// accept="image/*", in `// the /api/* routes` or in JSX text as a comment and
// hides real code up to the next '*/' (tests/comment-strip-meta-guard.test.js
// fails on one). stripComments and isClientFile are the GUARDSTRIP.0 / #1857
// version from tests/function-execute-guard.test.js (never a comment range at
// a JSX text).

import ts from 'typescript'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripComments as stripCommentsNoRegex } from '../../scripts/lib/strip-comments.mjs'

/**
 * JS/TS with comments blanked (same length, same line numbers), from the
 * TypeScript parser's own comment ranges, so a '/*' or '//' inside a string,
 * template or regex literal, or in JSX text, is never read as a comment. A
 * file the parser rejects falls back to the repo's quote-aware state machine
 * (scripts/lib/strip-comments.mjs), never to a regex.
 */
export function stripComments(text, file = 'scan.tsx') {
  return cached('strip', file, text, () => {
    const sf = parse(text, file)
    if (!sf) return stripCommentsNoRegex(text)
    return blank(text, commentRanges(text, sf).ranges)
  })
}

/**
 * Code for a token scan: comments, JSX text and regex-literal bodies blanked
 * (same length). JSX text and regex literals cannot hold a call, and a '/*'
 * in either would fool a later comment-aware scanner (check-select-columns'
 * maskComments, which tests/helpers/postgrest-column-uses.js used to run on
 * raw text). A file the parser rejects is returned raw: a false positive
 * beats a blind spot.
 */
export function codeOf(text, file = 'scan.jsx') {
  return cached('code', file, text, () => {
    const sf = parse(text, file)
    if (!sf) return text
    const { ranges, jsxText, regexes } = commentRanges(text, sf)
    return blank(text, [...ranges, ...jsxText, ...regexes])
  })
}

function parse(text, file) {
  // TSX first (a superset that also reads the repo's .js JSX), then JSX.
  // A .ts file (supabase/functions) is TS: `<T>(x) =>` is not JSX there.
  const kinds = /\.[mc]?ts$/.test(file) ? [ts.ScriptKind.TS] : [ts.ScriptKind.TSX, ts.ScriptKind.JSX]
  for (const kind of kinds) {
    const sf = ts.createSourceFile(kind === ts.ScriptKind.JSX ? 'scan.jsx' : 'scan.tsx', text, ts.ScriptTarget.Latest, true, kind)
    if (!sf.parseDiagnostics?.length) return sf
  }
  return null
}

function commentRanges(text, sf) {
  // JSX text is text: a '/*' or '//' inside it is not a comment. Any node can
  // share a JsxText's pos (its parent's SyntaxList does), so collect the text
  // spans first and drop every "comment" that starts inside one.
  const jsxText = []
  const regexes = []
  const findText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end])
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) regexes.push([node.getStart(sf), node.end])
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
  return { ranges: [...ranges], jsxText, regexes }
}

function blank(text, spans) {
  if (!spans.length) return text
  const out = text.split('')
  for (const [from, to] of spans) for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  return out.join('')
}

// ---------------------------------------------------------------------------
// Parse each text once. The TypeScript parse is the slow part (the whole repo
// is ~6 s to parse and ~10 s to walk for comments), and vitest gives every
// test file its own module registry, so an in-memory map alone re-parses the
// repo in every guard (C15's guard ran past vitest's 5 s budget on the CI
// runner). Results are kept in memory and on disk, keyed by a hash of the
// text (and whether it parses as TS), in a directory named after this file's
// own source, the fallback stripper's source and the TypeScript version, so
// editing any code that computes an entry starts a fresh cache. Writes are
// atomic (temp file + rename): parallel workers may race to write the same
// entry, never read half of one.
// ---------------------------------------------------------------------------

/** Every source whose code turns a text into a cached output. */
export const HELPER_SOURCES = Object.freeze([
  new URL(import.meta.url),
  new URL('../../scripts/lib/strip-comments.mjs', import.meta.url),
])
const HELPER_HASH = HELPER_SOURCES.reduce((h, src) => h.update(readFileSync(src)), createHash('sha1')).update(ts.version).digest('hex').slice(0, 12)
const CACHE_DIR = path.join(tmpdir(), `un1t-js-code-${HELPER_HASH}`)
const CACHE_PREFIX = 'un1t-js-code-'
const CACHE_UNUSED_MS = 24 * 60 * 60 * 1000

/**
 * Other helper versions' cache directories that may go: unused for a day.
 * A worktree on another version may be mid-run beside this one (the estate
 * runs guards in parallel worktrees), and deleting its directory makes every
 * later test file there re-parse the whole repo.
 */
export function staleCacheDirs(names, current, mtimeMsOf, now = Date.now()) {
  return names.filter((name) => {
    if (!name.startsWith(CACHE_PREFIX) || name === current) return false
    const mtime = mtimeMsOf(name)
    return mtime != null && now - mtime > CACHE_UNUSED_MS
  })
}

let cacheReady = null
function cacheDir() {
  if (cacheReady !== null) return cacheReady
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    // Mark this version's cache as in use (a warm cache only reads, which
    // would leave its mtime old enough for another version to prune it).
    try { const now = new Date(); utimesSync(CACHE_DIR, now, now) } catch { /* best effort */ }
    const mtimeMsOf = (name) => { try { return statSync(path.join(tmpdir(), name)).mtimeMs } catch { return null } }
    for (const name of staleCacheDirs(readdirSync(tmpdir()), path.basename(CACHE_DIR), mtimeMsOf)) {
      rmSync(path.join(tmpdir(), name), { recursive: true, force: true })
    }
    cacheReady = CACHE_DIR
  } catch {
    cacheReady = '' // no disk cache; memory only
  }
  return cacheReady
}

const MEMO = new Map()
function cached(mode, file, text, compute) {
  const key = createHash('sha1').update(mode).update(/\.[mc]?ts$/.test(file) ? '\0ts\0' : '\0jsx\0').update(text).digest('hex')
  if (MEMO.has(key)) return MEMO.get(key)
  const dir = cacheDir()
  const entry = dir && path.join(dir, `${key}.txt`)
  let out = null
  if (entry && existsSync(entry)) {
    try { out = readFileSync(entry, 'utf8') } catch { out = null }
  }
  if (out === null) {
    out = compute()
    if (entry) {
      try {
        const tmp = `${entry}.${process.pid}.${Math.random().toString(36).slice(2)}`
        writeFileSync(tmp, out)
        renameSync(tmp, entry)
      } catch { /* a cache miss next time, nothing worse */ }
    }
  }
  MEMO.set(key, out)
  return out
}

/** stripComments of a file on disk (cached like every call). */
export const stripCommentsOfFile = (file) => stripComments(readFileSync(file, 'utf8'), file)
/** codeOf of a file on disk (cached like every call). */
export const codeOfFile = (file) => codeOf(readFileSync(file, 'utf8'), file)

export function isClientFile(text) {
  return isClientCode(stripComments(text).trimStart())
}
/** isClientFile for a file on disk, from the per-run cache. */
export const isClientPath = (file) => isClientCode(stripCommentsOfFile(file).trimStart())
function isClientCode(code) {
  // The anon key is what a browser/session client is built from; the service
  // role key never appears next to it in a client-session file.
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) || /\bcreateAuthClient\s*\(/.test(code) ||
    /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}
