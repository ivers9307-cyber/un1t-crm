import { describe, it, expect } from 'vitest'
import { defaultHoldingMessage, defaultWelcomeGreeting } from './default-copy.js'

// W1.S3 — Mia's two code-default customer texts are functions of the brand.
describe('default-copy', () => {
  it('both defaults carry the brand they are given and never a literal gym', () => {
    expect(defaultHoldingMessage('Gym A')).toContain('One of the Gym A team')
    expect(defaultWelcomeGreeting({ agentName: 'Mia', brand: 'Gym A' })).toContain("I'm Mia, the studio's assistant at Gym A.")
    for (const t of [defaultHoldingMessage(), defaultHoldingMessage(null), defaultWelcomeGreeting(), defaultWelcomeGreeting({ brand: '  ' })]) {
      expect(t).not.toMatch(/UN1T/)
      expect(t).not.toMatch(/  /) // a missing brand leaves no double space behind
    }
  })

  it('HUMANIZE.1 — no em dash, no emoji in either default', () => {
    for (const t of [defaultHoldingMessage('Gym A'), defaultWelcomeGreeting({ agentName: 'Mia', brand: 'Gym A' })]) {
      expect(t).not.toMatch(/[—–]/)
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  it('trims the inputs', () => {
    expect(defaultWelcomeGreeting({ agentName: '  Ava ', brand: ' Gym A ' })).toContain("I'm Ava, the studio's assistant at Gym A.")
  })
})
