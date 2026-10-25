// GUARDSTRIP.1 (C74): the two shared comment strippers every guard uses.
//
// tests/helpers/js-code.js blanks JS comments from the TypeScript parser's own
// comment ranges, and tests/helpers/sql-code.js (scripts/lib/sql-code.mjs)
// blanks SQL comments in one quote-aware, $tag$-pairing pass. Each case below
// is a shape that hid real code from at least one guard's old regex stripper
// (`/\/\*[\s\S]*?\*\//` first, then a `//` or `--` line regex).

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripComments, codeOf, stripCommentsOfFile, codeOfFile, HELPER_SOURCES, staleCacheDirs } from './helpers/js-code.js'
import { sqlCode as sqlCodeFromTests } from './helpers/sql-code.js'
import { sqlCode } from '../scripts/lib/sql-code.mjs'

describe('js-code stripComments keeps code a regex stripper hid', () => {
  it('a /* inside a string does not open a comment', () => {
    const src = 'const a = <input accept="image/*" />\nconst hidden = db.from("contacts").update(x)\n/* real */ const b = 1\n'
    const out = stripComments(src)
    expect(out).toContain('db.from("contacts").update(x)')
    expect(out).not.toContain('real')
    expect(out).toHaveLength(src.length)
  })

  it('a /* inside a // comment does not open a block comment', () => {
    const src = '// the /api/* routes\nconst hidden = 1\n// end */\n'
    const out = stripComments(src)
    expect(out).toContain('const hidden = 1')
    expect(out).not.toMatch(/api|end/)
  })

  it('a // inside a string or template is not a comment', () => {
    const src = "const u = 'https://x.test/a' ; const v = `//${y}` ; call()\n"
    expect(stripComments(src)).toBe(src)
  })

  it('a /* inside a regex literal does not open a comment', () => {
    const src = 'const re = /\\/\\*/\nconst hidden = 2\nconst c = 3 /* x */\n'
    const out = stripComments(src)
    expect(out).toContain('const hidden = 2')
    expect(out).not.toContain('x */')
  })

  it('a /* or an apostrophe in JSX text is text, not a comment or a string', () => {
    const src = "const p = <p>files/*.csv don't</p>\nconst hidden = db.from('x').delete()\nconst q = <i>*/</i>\n"
    const out = stripComments(src)
    expect(out).toContain("db.from('x').delete()")
  })

  it('keeps line numbers and offsets (comments become spaces)', () => {
    const src = 'a()\n/* one\n two */\nb() // c\n'
    const out = stripComments(src)
    expect(out.split('\n')).toHaveLength(src.split('\n').length)
    expect(out.indexOf('b()')).toBe(src.indexOf('b()'))
  })
})

describe('js-code codeOf also blanks JSX text and regex literals (token scans)', () => {
  it('a /* in JSX text or a regex literal leaves the call visible, and the text itself blank', () => {
    const src = "const p = <p>select(x) files/*.csv</p>\nconst re = /\\/\\*/\nconst r = db.from('t').select('a')\n"
    const out = codeOf(src, 'x.jsx')
    expect(out).toContain("db.from('t').select('a')")
    expect(out).not.toContain('select(x)')
    expect(out).not.toContain('\\/\\*')
    expect(out).toHaveLength(src.length)
  })

  it('a file the parser rejects is returned raw (a false positive beats a blind spot)', () => {
    const src = 'const = = /* x */ y(\n'
    expect(codeOf(src, 'bad.js')).toBe(src)
  })
})

describe('js-code file readers parse a file once and agree with the text helpers', () => {
  it('stripCommentsOfFile / codeOfFile equal the text versions, also from the disk cache', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jscode-'))
    try {
      const file = path.join(dir, 'a.jsx')
      const src = 'const a = "image/*"\nconst b = db.from("t").select("c") // note\n'
      writeFileSync(file, src)
      expect(stripCommentsOfFile(file)).toBe(stripComments(src))
      expect(codeOfFile(file)).toBe(codeOf(src, file))
      // Same content at another path: served from the content-keyed cache.
      const other = path.join(dir, 'b.jsx')
      writeFileSync(other, src)
      expect(stripCommentsOfFile(other)).toBe(stripComments(src))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The cache key is the scanned text; the directory is the code that turned
  // text into output. The fallback stripper is part of that code: a fix to it
  // must not leave its old output served from the cache.
  it('the cache directory is keyed by every source that computes an entry', () => {
    expect(HELPER_SOURCES.map(String)).toEqual(expect.arrayContaining([
      expect.stringMatching(/tests\/helpers\/js-code\.js$/),
      expect.stringMatching(/scripts\/lib\/strip-comments\.mjs$/),
    ]))
  })

  // Worktrees run guards side by side, and one on another helper version has
  // its own cache directory in the same tmpdir: deleting it mid-run makes
  // every later test file there re-parse the repo (the C15 timeout class).
  it('prunes only the caches of other versions that have gone a day unused', () => {
    const now = Date.parse('2026-10-02T12:00:00Z')
    const mtimes = {
      'un1t-js-code-current': now - 3 * 86_400_000,
      'un1t-js-code-busy': now - 60_000,
      'un1t-js-code-old': now - 2 * 86_400_000,
      'unrelated-dir': now - 9 * 86_400_000,
    }
    expect(staleCacheDirs(Object.keys(mtimes), 'un1t-js-code-current', (n) => mtimes[n], now)).toEqual(['un1t-js-code-old'])
  })
})

describe('sql-code sqlCode keeps SQL a two-regex stripper hid', () => {
  it('tests/helpers/sql-code.js is the scripts/lib implementation (one stripper)', () => {
    expect(sqlCodeFromTests).toBe(sqlCode)
  })

  it("a '/*' or '--' inside a string is not a comment", () => {
    const sql = "select '/*';\nGRANT UPDATE ON public.contacts TO authenticated;\nselect '*/', '--';\nGRANT ALL ON t TO anon;\n"
    const out = sqlCode(sql)
    expect(out).toContain('GRANT UPDATE ON public.contacts TO authenticated;')
    expect(out).toContain('GRANT ALL ON t TO anon;')
  })

  it('a /* inside a -- comment does not open a block comment', () => {
    const sql = '-- see /* below\nGRANT INSERT ON public.contacts TO authenticated;\n-- */\n'
    expect(sqlCode(sql)).toContain('GRANT INSERT ON public.contacts TO authenticated;')
  })

  it("pairs each $tag$ body with its own closing tag, so parity never flips after a DO block", () => {
    const sql = "DO $$ BEGIN PERFORM 1; END $$;\nselect $$ /* $$;\nGRANT DELETE ON public.contacts TO authenticated;\nselect $$ */ $$;\n"
    expect(sqlCode(sql)).toContain('GRANT DELETE ON public.contacts TO authenticated;')
  })

  it('blanks comments inside a function or DO body, and nested block comments', () => {
    const sql = 'CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN -- GRANT x\n/* a /* b */ GRANT y */ END $fn$;\n'
    const out = sqlCode(sql)
    expect(out).not.toMatch(/GRANT/)
    expect(out).toContain('$fn$ BEGIN')
  })

  it("E'' strings honour backslash escapes; '' doubles a quote", () => {
    const sql = "select E'it\\'s /*', 'a''b /*';\nGRANT SELECT ON public.contacts TO anon;\n"
    expect(sqlCode(sql)).toContain('GRANT SELECT ON public.contacts TO anon;')
  })

  it("{ bodies: 'blank' } drops dollar-quoted bodies (and their tags), keeping newlines", () => {
    const sql = "DO $x$ BEGIN\n CREATE POLICY p ON t; -- y\nEND $x$;\nCREATE POLICY q ON t;\n"
    const out = sqlCode(sql, { bodies: 'blank' })
    expect(out).not.toMatch(/policy p|\$x\$/i)
    expect(out).toContain('CREATE POLICY q ON t;')
    expect(out.split('\n')).toHaveLength(sql.split('\n').length)
  })

  it('keeps offsets (comments become spaces)', () => {
    const sql = '/* a */ GRANT x; -- b\nGRANT y;\n'
    const out = sqlCode(sql)
    expect(out).toHaveLength(sql.length)
    expect(out.indexOf('GRANT y')).toBe(sql.indexOf('GRANT y'))
  })
})
