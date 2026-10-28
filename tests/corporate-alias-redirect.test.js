// CORPPROMO.3 — /corporate routes to the /corp promo page (a re-pointable 307).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const nextConfig = require('../next.config.js')

describe('/corporate alias', () => {
  it('redirects /corporate and /corporate/<promo> to /corp, not permanently', async () => {
    const redirects = await nextConfig.redirects()
    expect(redirects).toEqual(expect.arrayContaining([
      { source: '/corporate', destination: '/corp', permanent: false },
      { source: '/corporate/:promo', destination: '/corp/:promo', permanent: false },
    ]))
  })
})
