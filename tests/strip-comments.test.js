// stripComments — the fix for the #1266 checker hole (2026-08-08 audit).
//
// check:route-guards matched guard tokens with raw src.includes(), comments
// included, and the incident report itself narrated the failure mode: the
// literal `hasPermission(` matching PROSE in a header comment. Every email
// route carries explanatory comments naming the guard helpers, so a route
// whose only remaining mention of a guard sits in a comment would pass the
// lint with the real call deleted. The checker now strips comments first;
// this file pins the scanner.
//
// KNOWN LIMIT, on purpose: no regex-literal awareness. A `//` or `/*` inside
// a regex literal would be over-stripped — which can only LOSE tokens and
// fail the check loudly, never quietly pass an unguarded route. The right
// failure direction for a guard lint.

import { describe, it, expect } from 'vitest'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

describe('stripComments', () => {
  it('removes line comments — the #1266 prose match', () => {
    const src = 'const a = 1 // no longer calls hasPermission( here\nconst b = 2\n'
    const out = stripComments(src)
    expect(out).not.toContain('hasPermission(')
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
  })

  it('removes block comments, including multi-line headers', () => {
    const src = '/*\n * The gate is loadTicketForUser( — see _helpers.\n */\nexport async function GET() {}\n'
    const out = stripComments(src)
    expect(out).not.toContain('loadTicketForUser(')
    expect(out).toContain('export async function GET()')
  })

  it('keeps real code untouched', () => {
    const src = 'const t = await loadTicketForUser(db, user, id)\n'
    expect(stripComments(src)).toContain('loadTicketForUser(')
  })

  it('does not mistake // inside a string for a comment', () => {
    const src = "const url = 'https://example.com/x' // trailing\n"
    const out = stripComments(src)
    expect(out).toContain('https://example.com/x')
    expect(out).not.toContain('trailing')
  })

  it('does not mistake /* inside a string for a comment', () => {
    const src = 'const glob = "src/**/*.js"\nconst after = 1\n'
    const out = stripComments(src)
    expect(out).toContain('src/**/*.js')
    expect(out).toContain('const after = 1')
  })

  it('keeps template-literal contents, including ${} expressions', () => {
    const src = 'const q = `calls hasPermission(${who}) // not a comment`\n'
    const out = stripComments(src)
    expect(out).toContain('hasPermission(')
    expect(out).toContain('// not a comment')
  })

  it('strips a comment INSIDE a template ${} expression', () => {
    const src = 'const q = `${a /* gone */ + b}`\nconst tail = 2\n'
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).toContain('const tail = 2')
  })

  it('the #1266 scenario end to end: comment-only mention fails, real call passes', () => {
    const commentOnly = '// gated by loadTicketForUser( downstream\nexport async function GET() { return x }\n'
    const realCall = commentOnly + 'const t = await loadTicketForUser(db)\n'
    expect(stripComments(commentOnly).includes('loadTicketForUser(')).toBe(false)
    expect(stripComments(realCall).includes('loadTicketForUser(')).toBe(true)
  })
})
