// W1.L3a — a customer-facing link minted on a tenant host must land on a path
// the tenant-domain tier SERVES. The proxy admits a path on a tenant host only
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
// the two helpers they build the link through.
const SITES = [
  'src/lib/campaign-sender.js',
  'src/lib/sequences/steps.js',
  'src/lib/host-campaign-queue.js',
  'src/lib/hr-post-class-email.js',
  'src/app/api/campaigns/[id]/send-test/route.js',
  'src/app/api/host/emails/[id]/send-test/route.js',
  'src/app/api/hosts/[id]/invite/route.js', // W1.L3c — host set-password
  'src/lib/postmark.js',          // buildUnsubscribeUrl
  'src/lib/campaign-web-view.js', // buildCampaignViewUrl
]

// The literal path that follows `${baseUrl}` in a template literal, up to the
// first dynamic part, query string or closing backtick.
const LINK_RE = /\$\{baseUrl\}(\/[A-Za-z0-9_\-./]*)/g

function mintedPaths(file) {
  const src = readFileSync(resolve(process.cwd(), file), 'utf8')
  return [...src.matchAll(LINK_RE)].map((m) => m[1])
}

const admitted = (path) => DB_BRAND_DEFAULTS.allowedPaths.some((p) => path.startsWith(p))

describe('W1.L3a — minted customer links land on paths the tenant-domain tier serves', () => {
  const found = Object.fromEntries(SITES.map((f) => [f, mintedPaths(f)]))

  it('reads at least one minted path out of every site (the regex is not matching nothing)', () => {
    for (const f of SITES) expect(found[f], f).not.toHaveLength(0)
  })

  it('covers the five link families this PR moves', () => {
    const all = Object.values(found).flat()
    for (const p of ['/unsubscribe/', '/unsubscribe/host/', '/preferences/', '/view-email/', '/api/preferences/hr-emails']) {
      expect(all, p).toContain(p)
    }
  })

  for (const f of SITES) {
    it(`${f}: every \${baseUrl} path is on DB_BRAND_DEFAULTS.allowedPaths`, () => {
      for (const p of found[f]) expect(admitted(p), `${p} would rewrite to /welcome on a tenant host`).toBe(true)
    })
  }

  it('W1.L3c — the host invite mints /host/set-password on the tenant host', () => {
    expect(found['src/app/api/hosts/[id]/invite/route.js']).toEqual(['/host/set-password'])
  })

  it('none of the seven sites builds a customer link on getAppUrl() any more', () => {
    for (const f of SITES.slice(0, 7)) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/\$\{getAppUrl\(\)\}/)
      expect(src, f).toMatch(/resolveCustomerBaseUrl\(/)
    }
  })
})
