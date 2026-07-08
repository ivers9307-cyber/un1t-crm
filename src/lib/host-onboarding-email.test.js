// Host onboarding email HTML (EVENTS-HOST.9) — link + escaping.

import { describe, it, expect } from 'vitest'
import { renderHostOnboardingEmail } from './host-onboarding-email.js'

describe('renderHostOnboardingEmail', () => {
  it('embeds the onboarding URL in the CTA', () => {
    const html = renderHostOnboardingEmail({ hostName: 'Pride Training Club', url: 'https://crm.un1tdublin.com/host-connect/tok.sig' })
    expect(html).toContain('href="https://crm.un1tdublin.com/host-connect/tok.sig"')
    expect(html).toContain('Pride Training Club')
    expect(html).toContain('Connect your Stripe account')
  })

  it('falls back to a neutral greeting when the host has no name', () => {
    const html = renderHostOnboardingEmail({ url: 'https://x/host-connect/t' })
    expect(html).toContain('Hi there,')
  })

  it('escapes the host name (no HTML injection)', () => {
    const html = renderHostOnboardingEmail({ hostName: '<script>bad</script>', url: 'https://x/t' })
    expect(html).not.toContain('<script>bad')
    expect(html).toContain('&lt;script&gt;')
  })
})
