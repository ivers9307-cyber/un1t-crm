// ACDEVLOC.1 — a credential never rides a URL we serve or build. A query
// string is written to Vercel's request log (and any drain), every proxy's
// access log and the browser's network log; a body is not. The AC settings
// tab sent the live Sensibo key as GET /api/studio-management/ac/pods?api_key=.
//
// Server rule: no src/app/api/**/route.js reads a credential-named parameter
// from its query string. Client rule: no browser or phone source (src/app
// outside /api, src/components, mobile/app|components|lib, shared) builds a URL
// with one. Comments are stripped first.
//
// OUT OF SCOPE by design: server-to-vendor calls whose vendor demands query
// auth (src/lib/sensibo.js `apiKey`, the Instagram token-refresh cron's
// `access_token`), which no log of ours records; and `token=` (unsubscribe and
// capability links carry a single-purpose token in the URL on purpose).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const CRED_PARAMS = ['api_key', 'apiKey', 'pat', 'access_token', 'api_token', 'client_secret', 'password', 'webhook_secret']
const SERVER_RE = new RegExp(String.raw`\bsearchParams\.get\(\s*['"](?:${CRED_PARAMS.join('|')})['"]\s*\)`)
const CLIENT_RE = new RegExp(String.raw`[?&](?:${CRED_PARAMS.join('|')})=`)
const CLIENT_ROOTS = ['src/components', 'src/app', 'mobile/app', 'mobile/components', 'mobile/lib', 'shared']

// ACDEVLOC.1 owns these and its Task 7 deletes them. Never add to this list.
const PENDING_ACDEVLOC = {
  server: [
    'src/app/api/studio-management/ac/lg-devices/route.js',
    'src/app/api/studio-management/ac/pods/route.js',
  ],
  client: ['src/components/settings/integrations/AcDevicesIntegrationTab.jsx'],
}

function walk(rel, keep) {
  const out = []
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = path.join(rel, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(child, keep)) }
    else if (keep(child)) out.push(child)
  }
  return out
}
const isSource = (f) => /\.(js|jsx|mjs)$/.test(f) && !/\.(test|spec)\./.test(f)
const read = (f) => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))

function serverOffenders() {
  return walk('src/app/api', (f) => f.endsWith('route.js')).filter((f) => SERVER_RE.test(read(f))).sort()
}
function clientOffenders() {
  return CLIENT_ROOTS.flatMap((r) => walk(r, isSource))
    .filter((f) => !f.startsWith(path.join('src', 'app', 'api') + path.sep))
    .filter((f) => CLIENT_RE.test(read(f)))
    .sort()
}

describe('the patterns', () => {
  it('see a credential param and not its look-alikes', () => {
    expect(SERVER_RE.test("let apiKey = searchParams.get('api_key')")).toBe(true)
    expect(SERVER_RE.test("searchParams.get('pat')")).toBe(true)
    expect(SERVER_RE.test("searchParams.get('path')")).toBe(false)
    expect(SERVER_RE.test("searchParams.get('token')")).toBe(false)
    expect(CLIENT_RE.test('`/api/x?api_key=${k}`')).toBe(true)
    expect(CLIENT_RE.test('`/api/x?a=1&access_token=${t}`')).toBe(true)
    expect(CLIENT_RE.test('`/api/x?path=${p}`')).toBe(false)
  })
})

describe('no credential in a URL', () => {
  it('finds the trees (a wrong root finds nothing)', () => {
    expect(walk('src/app/api', (f) => f.endsWith('route.js')).length).toBeGreaterThan(500)
    expect(CLIENT_ROOTS.flatMap((r) => walk(r, isSource)).length).toBeGreaterThan(1000)
  })

  it('no route reads one from its query string', () => {
    expect(serverOffenders().filter((f) => !PENDING_ACDEVLOC.server.includes(f))).toEqual([])
  })

  it('no browser or phone source builds a URL with one', () => {
    expect(clientOffenders().filter((f) => !PENDING_ACDEVLOC.client.includes(f))).toEqual([])
  })

  it('every PENDING entry still matches (a fixed file leaves the list)', () => {
    const s = serverOffenders()
    const c = clientOffenders()
    expect(PENDING_ACDEVLOC.server.filter((f) => !s.includes(f))).toEqual([])
    expect(PENDING_ACDEVLOC.client.filter((f) => !c.includes(f))).toEqual([])
  })
})
