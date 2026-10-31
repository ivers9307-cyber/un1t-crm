// PAGES.1 — the landing pages API bodies: the chrome's logo alt takes the
// legacy table's 200 characters (mig 792 copied the value over), and a
// retired page's redirect is a same-site path (REDIRECT_PATH_RE).
import { describe, it, expect } from 'vitest'
import { landingPageChromeSchema, landingPagePublishSchema } from './landing-page-schemas'

describe('landing page schemas', () => {
  it('logo_alt takes up to 200 characters', () => {
    expect(landingPageChromeSchema.safeParse({ logo_alt: 'a'.repeat(200) }).success).toBe(true)
    expect(landingPageChromeSchema.safeParse({ logo_alt: 'a'.repeat(201) }).success).toBe(false)
  })

  it('redirect_to is a path on this site', () => {
    const ok = (redirect_to) => landingPagePublishSchema.safeParse({ publish_state: 'retired', redirect_to }).success
    expect(ok('/trial')).toBe(true)
    expect(ok('/welcome/hatch-street?x=1')).toBe(true)
    for (const bad of ['//evil.example', '/\\evil.example', 'trial', '/a b', '/a#b', 'https://evil.example']) {
      expect(ok(bad)).toBe(false)
    }
  })
})
