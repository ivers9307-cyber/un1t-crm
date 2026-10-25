// GUARDSTRIP.1 (C74) meta-guard: no test or check script strips comments with
// a regex. Every guard reads code through the two shared strippers:
//
//   tests/helpers/js-code.js   JS: the TypeScript parser's own comment ranges
//                              (a '/*' or '//' in a string, template, regex
//                              literal or JSX text is not a comment)
//   tests/helpers/sql-code.js  SQL: one quote-aware pass that pairs each $tag$
//   (scripts/lib/sql-code.mjs) body with its own closing tag
//
// A regex stripper fails open. `/\/\*[\s\S]*?\*\//` read the '/*' in
// accept="image/*" or `// the /api/* routes` as a comment and hid real code up
// to the next '*/' (C61's guard was blind to ~9.5k lines); a `//…$` or `--…$`
// line regex also eats code after a '//' or '--' inside a string. This scans
// every test file (tests/, src/, shared/, mobile/lib/) and every script under
// scripts/ for the three regex shapes, in code (comments blanked first, so
// prose may name them), and for a private copy of a stripper (a TypeScript
// comment-range walk or a hand scan for '--' or '/*'): copies drift, and the
// unpaired-$$ and JSX-text bugs each lived in one. A floor, not a proof: a
// stripper built with new RegExp('…') from a string is not seen.

import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripCommentsOfFile, stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SELF = 'tests/comment-strip-meta-guard.test.js'
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

/**
 * Files allowed to keep a regex stripper, each with the reason. An entry that
 * no longer matches fails (stale), so the list only shrinks.
 */
export const REGEX_STRIP_ALLOWED = {
  'tests/rls-active-staff-gate.test.js':
    'strips `--` before replaying every migration; open in PRs #1912/#1914/#1915 when GUARDSTRIP.1 was written, so moving it onto sqlCode waits for them to merge',
  'tests/tv-content-bucket-guard.test.js':
    'a correct private copy (TS comment ranges, JSX-aware; paired $tag$ sqlCode); TV files were held for OTA-2 when GUARDSTRIP.1 was written',
  'tests/member-write-sweep-guard.test.js':
    'a correct private copy (TS comment ranges, JSX-aware; paired $tag$ sqlCode); open in PR #1914 when GUARDSTRIP.1 was written',
  'tests/whatsapp-config-callers.test.js':
    'blankNonCode blanks comments AND every literal (TS parser, JSX-aware): a different, correct mode; whatsapp files were held for WEB-3',
  'tests/whatsapp-config-route-gates.test.js':
    'blankNonCode blanks comments AND every literal (TS parser, JSX-aware): a different, correct mode; whatsapp files were held for WEB-3',
  'scripts/check-select-columns.mjs':
    "maskComments is check:select-columns' own hand scanner (no regex-literal or JSX-text awareness); the guards no longer use it (postgrest-column-uses reads codeOf)",
}

/** The shared strippers themselves. */
const SHARED = new Set(['tests/helpers/js-code.js', 'scripts/lib/sql-code.mjs', 'scripts/lib/strip-comments.mjs'])

// A block-comment strip: a regex literal holding `\/\*` and, a little later, `\*\/`.
const BLOCK = /\\\/\\\*[^\n]{0,40}?\\\*\\\//
// A `//` line strip: .replace(/…\/\/.*  or  …\/\/[^\n]*
const JS_LINE = /\.replace\(\s*\/[^\n]{0,30}?\\\/\\\/(?:\.\*|\[\^\\n\]\*)/
// A `--` line strip: .replace(/--.*  or  /(…)--[^\n]*
const SQL_LINE = /\.replace\(\s*\/[^\n]{0,30}?--(?:\.\*|\[\^\\n\]\*)/
// A private stripper: a TypeScript comment-range walk, or a hand scan for '--' or '/*'.
const PRIVATE = /\bgetLeadingCommentRanges\b|===\s*'-'\s*&&\s*[\w.[\]+ ]+===\s*'-'|===\s*'\/'\s*&&\s*[\w.[\]+ ]+===\s*'\*'/

/** The stripper shapes in one file's code: ['block' | 'js-line' | 'sql-line' | 'private-copy']. */
export function regexStrippers(code) {
  return [
    ...(BLOCK.test(code) ? ['block'] : []),
    ...(JS_LINE.test(code) ? ['js-line'] : []),
    ...(SQL_LINE.test(code) ? ['sql-line'] : []),
    ...(PRIVATE.test(code) ? ['private-copy'] : []),
  ]
}

function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || ['ios', 'android', 'dist', 'web-build'].includes(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, keep, out)
    else if (keep(name)) out.push(full)
  }
  return out
}

const isTest = (name) => /\.(test|spec)\.(m?js|jsx)$/.test(name)
function scannedFiles() {
  return [
    ...walk(path.join(ROOT, 'tests'), (n) => /\.(m?js|jsx)$/.test(n)),
    ...walk(path.join(ROOT, 'src'), isTest),
    ...walk(path.join(ROOT, 'shared'), isTest),
    ...walk(path.join(ROOT, 'mobile/lib'), isTest),
    ...walk(path.join(ROOT, 'scripts'), (n) => /\.(m?js|cjs)$/.test(n)),
  ].filter((f) => rel(f) !== SELF && !SHARED.has(rel(f)))
}

describe('no test or check script strips comments with a regex (GUARDSTRIP.1)', { timeout: 120_000 }, () => {
  const files = scannedFiles()
  const found = Object.fromEntries(files.map((f) => [rel(f), regexStrippers(stripCommentsOfFile(f))]).filter(([, hits]) => hits.length))

  it('scans the tree (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(1000)
    expect(files.map(rel)).toEqual(expect.arrayContaining([
      'tests/helpers/sql-code.js', 'scripts/check-rls-restrictive.mjs', 'shared/dashboard-data.test.js',
      'mobile/lib/dashboard-api.test.js', 'src/lib/consent-actions.test.js',
    ]))
  })

  it('finds none outside the reasoned allowlist', () => {
    const offenders = Object.entries(found).filter(([f]) => !REGEX_STRIP_ALLOWED[f]).map(([f, hits]) => `${f}: ${hits.join(', ')}`)
    expect(offenders, 'blank comments with tests/helpers/js-code.js (stripComments / codeOf) or tests/helpers/sql-code.js (sqlCode), never a regex').toEqual([])
  })

  it('every allowlist entry still matches and says why (stale entries go)', () => {
    for (const [f, why] of Object.entries(REGEX_STRIP_ALLOWED)) {
      expect(why, f).toMatch(/\w{10,}/)
      expect(found[f], `${f} no longer strips with a regex: remove it from REGEX_STRIP_ALLOWED`).toBeTruthy()
    }
  })
})

describe('the detector', () => {
  it('sees every regex-stripper shape the repo used', () => {
    const shapes = [
      [String.raw`code.replace(/\/\*[\s\S]*?\*\//g, '')`, 'block'],
      [String.raw`s.replace(/\/\*[^]*?\*\//g, ' ')`, 'block'],
      [String.raw`src.replace(/(^|[^:'"\x60])\/\/.*$/gm, '$1')`, 'js-line'],
      [String.raw`src.replace(/^\s*\/\/.*$/gm, '')`, 'js-line'],
      [String.raw`text.replace(/(^|\s)\/\/[^\n]*/g, '$1')`, 'js-line'],
      [String.raw`line.replace(/\/\/.*$/, '')`, 'js-line'],
      [String.raw`sql.replace(/--[^\n]*/g, ' ')`, 'sql-line'],
      [String.raw`MIG.replace(/--.*$/gm, '')`, 'sql-line'],
      ['for (const r of ts.getLeadingCommentRanges(text, node.pos) || []) ranges.push(r)', 'private-copy'],
      ["if (c === '-' && d === '-') { while (sql[i] !== '\\n') i++ }", 'private-copy'],
      ["if (src[i] === '/' && src[i + 1] === '*') depth++", 'private-copy'],
    ]
    for (const [code, shape] of shapes) expect(regexStrippers(code), code).toContain(shape)
  })

  it('passes the shared helpers, regexes that are not strippers, and prose', () => {
    for (const code of [
      "const code = stripComments(text)",
      "const sql = sqlCode(readFileSync(f, 'utf8'))",
      String.raw`const m = sql.match(/^-- ROLLBACK[^\n]*\n/m)`,
      String.raw`rollback.replace(/^--\s?/gm, '')`,
      String.raw`const re = /\.from\(\s*['"]contacts['"]\)/g`,
      "const url = 'https://example.test/a/*'",
      "if (glob[i + 1] === '*') i++",
    ]) expect(regexStrippers(code), code).toEqual([])
    const prose = "// never `/\\/\\*[\\s\\S]*?\\*\\//` here\nconst a = 1\n"
    expect(regexStrippers(stripComments(prose))).toEqual([])
  })
})
