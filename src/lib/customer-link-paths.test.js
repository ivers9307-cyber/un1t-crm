// W1.L3a / W1.L3b — a customer-facing link minted on a tenant host must land
// on a path the tenant-domain tier SERVES. The proxy admits a path on a tenant host only
// if `brand.allowedPaths.some((p) => path.startsWith(p))` (src/proxy.js) and
// otherwise rewrites it to /welcome — the customer clicks "unsubscribe" and
// gets the studio chooser, consent untouched (the W1.L2 class). So every path
// a W1.L3a site builds on `resolveCustomerBaseUrl()` is read out of the source
// here and checked against DB_BRAND_DEFAULTS.allowedPaths (the default every
// automatic <slug>.repset.ie row resolves to, mig 716). A new `${baseUrl}/…`
// in one of these files fails here, not on a tenant host in prod.
//
// Reads the source rather than a hand-kept list: a list would be a second
// claim about the code, and the two would drift.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DB_BRAND_DEFAULTS } from './tenant-domains-edge.js'

// Every file whose customer link is minted on resolveCustomerBaseUrl(), plus
// the helpers they build the link through.
const SITES = [
  // W1.L3a — marketing, sequences, HR:
  'src/lib/campaign-sender.js',
  'src/lib/sequences/steps.js',
  'src/lib/host-campaign-queue.js',
  'src/lib/hr-post-class-email.js',
  'src/app/api/campaigns/[id]/send-test/route.js',
  'src/app/api/host/emails/[id]/send-test/route.js',
  'src/lib/postmark.js',          // buildUnsubscribeUrl
  'src/lib/campaign-web-view.js', // buildCampaignViewUrl
  // W1.L3b — events, booking, host and Mia:
  'src/app/api/public/events/[slug]/register/route.js',
  'src/app/api/public/races/[slug]/register/route.js',
  'src/lib/race-register-solo.js',
  'src/app/api/event-registrations/[id]/moves/[moveId]/gap-link/route.js',
  'src/lib/race-gap-payment.js',
  'src/app/api/public/entry/[token]/move/route.js',
  'src/lib/entry-manage-tokens.js', // entryManageUrl (race-confirmations hands in the host)
  'src/lib/event-waitlist.js',
  'src/app/api/events/[id]/qr-code/route.js',
  'src/app/(members)/events/page.js',
  'src/lib/agent/event-tools.js',
  'src/lib/class-booking-payments.js',
  'src/app/host/(portal)/page.js',
  'src/app/api/host/signup-qr/route.js',
  'src/app/api/hosts/[id]/onboarding-link/route.js',
  'src/app/api/hosts/[id]/onboarding-link/send/route.js',
  'src/app/api/public/host-connect/[token]/start/route.js',
  'src/app/api/public/host-connect/[token]/refresh/route.js',
  'src/lib/host-notifications.js',
]

// Pure helpers: they build the link from a base the send path hands in, so
// they carry no resolver call of their own (and keep getAppUrl() as a floor).
const HELPERS = new Set([
  'src/lib/postmark.js',
  'src/lib/campaign-web-view.js',
  'src/lib/entry-manage-tokens.js',
])

// The literal path that follows `${baseUrl}` (or a route's `${floor}`
// fallback) in a template literal, up to the first dynamic part, query string
// or closing backtick.
const LINK_RE = /\$\{(?:baseUrl|floor)\}(\/[A-Za-z0-9_\-./]*)/g

function mintedPaths(file) {
  const src = readFileSync(resolve(process.cwd(), file), 'utf8')
  return [...src.matchAll(LINK_RE)].map((m) => m[1])
}

const admitted = (path) => DB_BRAND_DEFAULTS.allowedPaths.some((p) => path.startsWith(p))

describe('W1.L3a/b — minted customer links land on paths the tenant-domain tier serves', () => {
  const found = Object.fromEntries(SITES.map((f) => [f, mintedPaths(f)]))

  it('reads at least one minted path out of every site (the regex is not matching nothing)', () => {
    for (const f of SITES) expect(found[f], f).not.toHaveLength(0)
  })

  it('covers the five W1.L3a link families', () => {
    const all = Object.values(found).flat()
    for (const p of ['/unsubscribe/', '/unsubscribe/host/', '/preferences/', '/view-email/', '/api/preferences/hr-emails']) {
      expect(all, p).toContain(p)
    }
  })

  it('covers the W1.L3b link families (events, entry, pay, class-pay, host)', () => {
    const all = Object.values(found).flat()
    for (const p of ['/event/', '/event/entry/', '/event-pay/', '/class-pay/', '/h/', '/host', '/host-connect/', '/api/public/host-connect/']) {
      expect(all, p).toContain(p)
    }
    // The cancellation form link is built by buildFormUrl (cancellation-form/
    // links.js) from the base the route resolves, not as a `${baseUrl}/…`
    // literal; its family is pinned here directly.
    expect(admitted('/cancel/')).toBe(true)
  })

  it('W1.L3b — Mia and the race flow mint the canonical /event/ path, never the /race/ alias', () => {
    // /race/:slug is a next.config rewrite on the CRM host only; a tenant host
    // rewrites it to /welcome, so a /race/ link there loses the customer.
    expect(admitted('/race/')).toBe(false)
    for (const f of ['src/lib/agent/event-tools.js', 'src/lib/race-register-solo.js', 'src/app/api/public/races/[slug]/register/route.js']) {
      expect(found[f].some((p) => p.startsWith('/race/')), f).toBe(false)
    }
  })

  for (const f of SITES) {
    it(`${f}: every \${baseUrl} path is on DB_BRAND_DEFAULTS.allowedPaths`, () => {
      for (const p of found[f]) expect(admitted(p), `${p} would rewrite to /welcome on a tenant host`).toBe(true)
    })
  }

  it('no site builds a customer link on getAppUrl() any more, and every non-helper resolves the tenant host', () => {
    for (const f of SITES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/\$\{getAppUrl\(\)\}/)
      if (!HELPERS.has(f)) expect(src, f).toMatch(/resolveCustomerBaseUrl\(/)
    }
  })
})
