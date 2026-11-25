// INBOXPERM.1 — the Instagram conversation and media routes judge the inbox key at the
// THREAD's (or message's) own studio, the WhatsApp thread routes' rule (INBOXLOC.1).
//
// Every route here runs on the service role, so RLS does nothing for it; the
// gate is in code. Instagram has no key of its own: 'ig' rides the `whatsapp`
// key (INBOX_CHANNEL_PERMISSION_KEYS in src/lib/auth.js), which is why the
// helpers are called requireWhatsApp*. A route that judged the active studio
// (requireInboxPermission(user, 'ig')) let a member of studio B without the
// key at B read, reply to and resolve B's threads whenever the key was held at
// the studio they had selected.
//
// This table is exhaustive: a new route file under the folder, or a handler
// that changes its gate, fails here until it is stated.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..', 'src', 'app', 'api', 'instagram')

// 'both' = web OR phone key (the phone calls the route); 'web' = web key only;
// 'list' = the list, which has no row and is judged below.
const GATES = {
  'conversations/route.js': { GET: 'list' },
  'conversations/[id]/route.js': { GET: 'both', PATCH: 'both' },
  'conversations/[id]/send/route.js': { POST: 'both' },
  'conversations/[id]/snooze/route.js': { POST: 'both' },
  'conversations/[id]/agent/route.js': { PATCH: 'both' },
  'conversations/[id]/assign/route.js': { GET: 'web', POST: 'web' },
  'conversations/[id]/add-contact/route.js': { POST: 'web' },
  'conversations/[id]/link/route.js': { GET: 'web', POST: 'web', DELETE: 'web' },
  // The phone calls it too (WAMediaThumb); judged at the message's studio before any re-host or signing.
  'media/[messageId]/route.js': { GET: 'both' },
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}
const routeFiles = walk(ROOT).filter((p) => p.endsWith('/route.js')).map((p) => path.relative(ROOT, p).split(path.sep).join('/')).sort()

// The source of one exported handler: from its `export` to the next top-level `export`.
function handlerSource(src, verb) {
  const start = src.search(new RegExp(`export (const|async function|function) ${verb}\\b`))
  if (start === -1) return null
  const rest = src.slice(start + 1)
  const next = rest.search(/\nexport /)
  return next === -1 ? rest : rest.slice(0, next)
}

// Every verb a file exports (const/function forms; `export { x as GET }` is also read).
function exportedVerbs(src) {
  const verbs = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|function)\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g)) verbs.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()
      if (/^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/.test(name)) verbs.add(name)
    }
  }
  return [...verbs].sort()
}

describe('Instagram routes: the inbox key is judged at the thread\'s (or message\'s) studio', () => {
  it('the table covers every route file, and nothing else', () => {
    expect(routeFiles).toEqual(Object.keys(GATES).sort())
  })

  for (const [file, verbs] of Object.entries(GATES)) {
    it(`${file} exports exactly the verbs the table lists`, () => {
      expect(exportedVerbs(fs.readFileSync(path.join(ROOT, file), 'utf8'))).toEqual(Object.keys(verbs).sort())
    })
  }

  it('the verb reader sees a verb the table would miss', () => {
    expect(exportedVerbs('export const GET = a\nexport async function DELETE() {}\nexport { x as PUT }')).toEqual(['DELETE', 'GET', 'PUT'])
  })

  for (const [file, verbs] of Object.entries(GATES)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')

    it(`${file} never judges the active studio's key (requireInboxPermission)`, () => {
      expect(src).not.toMatch(/requireInboxPermission\s*\(/)
    })

    for (const [verb, kind] of Object.entries(verbs)) {
      if (kind === 'list') continue
      it(`${verb} ${file}: ${kind === 'both' ? 'web or phone key' : 'web key only'}, any studio first, then at the thread's studio`, () => {
        // assign/ gates in one shared loader both handlers call, so its whole file is the handler.
        const h = file === 'conversations/[id]/assign/route.js' ? src : handlerSource(src, verb)
        expect(h, `no exported ${verb} in ${file}`).not.toBeNull()
        const fn = kind === 'both' ? 'requireWhatsAppInbox' : 'requireWebWhatsAppInbox'
        const wrong = kind === 'both' ? 'requireWebWhatsAppInbox' : 'requireWhatsAppInbox'
        expect(h).toMatch(new RegExp(`${fn}Anywhere\\(\\s*user\\s*\\)`))
        expect(h).not.toMatch(new RegExp(`${wrong}(Anywhere|At)\\(`))
        // The decision is taken at the row's own studio, after membership.
        const idx = (re) => h.search(re)
        const member = idx(/assertLocationAccessOr404\(\s*user\s*,/)
        const at = idx(new RegExp(`${fn}At\\(\\s*user\\s*,\\s*(conversation|thread|message)\\.location_id`))
        expect(member).toBeGreaterThan(-1)
        expect(at).toBeGreaterThan(member)
      })
    }
  }

  // The list has no row: it judges at the requested studio, membership first.
  it('GET conversations/route.js judges the web or phone key anywhere first, then at ?location_id after membership, and lists only studios holding the key', () => {
    const src = fs.readFileSync(path.join(ROOT, 'conversations', 'route.js'), 'utf8')
    expect(src).toMatch(/requireWhatsAppInboxAnywhere\(\s*user\s*\)/)
    expect(src).not.toMatch(/requireWebWhatsApp/)
    expect(src).toMatch(/requireWhatsAppInboxAt\(\s*user\s*,\s*locationId\s*\)/)
    expect(src.search(/assertLocationAccess\(/)).toBeLessThan(src.search(/requireWhatsAppInboxAt\(/))
    expect(src).not.toMatch(/\.in\('location_id',\s*getUserLocationIds\(user\)\)/)
  })
})
