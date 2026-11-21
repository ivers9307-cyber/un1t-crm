// ROUTEWRAP.1 — a new /api route uses a wrapper: withAuth (src/lib/with-auth.js)
// for a signed-in staff session, withHostAuth (src/lib/with-host-auth.js) for
// a host-portal session, defineCron for a scheduled job. They own the sign-in
// check, the studio check, the role check and one error boundary, which routes
// otherwise write by hand in a dozen slightly different ways.
//
// tests/fixtures/routes-without-wrapper.json lists the routes written before
// this rule. It only shrinks: moving a route onto withAuth means deleting its
// line, and adding a line is the wrong fix for a failure here. Outside the rule:
// webhooks and public routes (they verify a signature or a token, not a
// session), routes that accept an organisation API key, and /api/cron, which
// tests/cron-define-guard.test.js covers.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../src/app/api')
const LEGACY = new Set(JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'fixtures/routes-without-wrapper.json'), 'utf8')))

const routes = readdirSync(ROOT, { recursive: true })
  .map(String)
  .filter((f) => path.basename(f) === 'route.js')
  .map((f) => ({ name: f.split(path.sep).join('/'), src: readFileSync(path.join(ROOT, f), 'utf8') }))

const outsideRule = (r) => /^(webhooks|public|cron)\//.test(r.name)
  || /\b(requireApiKeyOrManager|authenticateApiKey)\(/.test(r.src)
const wrapped = (src) => (src.includes("from '@/lib/with-auth'") && /\bwithAuth\(/.test(src))
  || (src.includes("from '@/lib/define-cron'") && /\bdefineCron\(/.test(src))
  // HOSTCHECKIN.1 — the host portal's twin of withAuth (host sessions only).
  || (src.includes("from '@/lib/with-host-auth'") && /\bwithHostAuth\(/.test(src))

describe('new API routes use a wrapper', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(900)
  })

  it('every route outside the legacy list uses withAuth or defineCron', () => {
    expect(routes.filter((r) => !outsideRule(r) && !LEGACY.has(r.name) && !wrapped(r.src)).map((r) => r.name)).toEqual([])
  })

  it('the legacy list only names routes that still need moving', () => {
    const byName = new Map(routes.map((r) => [r.name, r]))
    expect([...LEGACY].filter((n) => !byName.has(n) || wrapped(byName.get(n).src))).toEqual([])
  })
})
