// PUBCAP.1 — Richard's rule: class and event capacity is NEVER surfaced to
// customers. Anonymous `/api/public/**` routes may count places server-side to
// refuse a booking, but no remaining/spots/places count may leave in a
// response key or in customer-facing words. This scans the route sources so a
// new public route (or an edit to an old one) cannot quietly bring one back.
// It is a floor, not a proof: a count computed in a helper and sent under an
// innocent key is invisible to it — the route tests (e.g. public/classes)
// assert the actual JSON.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..', 'src', 'app', 'api', 'public')

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(p))
    else if (entry.name === 'route.js') out.push(p)
  }
  return out
}

// Strip // line comments and /* block */ comments: a comment explaining the
// rule must not trip the rule.
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const LEAKS = [
  { name: 'a spots_left / spotsLeft / places_left key or call', re: /\b(spots_?left|spotsLeft|places_?left|placesLeft|seats_?left|remaining_spots|remaining_places)\b/i },
  { name: 'customer-facing "N spots/places left" wording', re: /\$\{[^}]+\}\s*(?:\$\{[^}]+\}\s*)?(spot|spots|place|places|seat|seats)\s+left/i },
  { name: 'customer-facing "only … left" wording', re: /only\s+\$\{[^}]+\}[^`'"]*\bleft\b/i },
]

describe('PUBCAP.1 — public routes never send a capacity count', () => {
  const files = routeFiles(ROOT)

  it('finds the public routes', () => {
    expect(files.length).toBeGreaterThan(10)
    expect(files.some((f) => f.endsWith(path.join('public', 'classes', 'route.js')))).toBe(true)
  })

  for (const leak of LEAKS) {
    it(`no public route carries ${leak.name}`, () => {
      const hits = files
        .filter((f) => leak.re.test(codeOnly(fs.readFileSync(f, 'utf8'))))
        .map((f) => path.relative(ROOT, f))
      expect(hits).toEqual([])
    })
  }
})
