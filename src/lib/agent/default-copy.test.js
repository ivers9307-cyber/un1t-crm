import { describe, it, expect } from 'vitest'
import { defaultHoldingMessage, defaultWelcomeGreeting, DEFAULT_FLOW_BOOKING_ACK_TEXT, DEFAULT_FLOW_BOOKING_HOLDING_TEXT, DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT } from './default-copy.js'

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

  // FLOWACK.1 — the Flow booking texts never claim a booking and carry no em dash.
  it('the Flow acknowledgement and holding line', () => {
    expect(DEFAULT_FLOW_BOOKING_ACK_TEXT).toBe("Got it, we're booking your spot now. You'll get a confirmation shortly.")
    expect(DEFAULT_FLOW_BOOKING_HOLDING_TEXT).toBe('Thanks, the team is confirming your class and will be in touch shortly.')
    expect(DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT).toBe("You've already asked for that class. You'll get a confirmation shortly.")
    for (const t of [DEFAULT_FLOW_BOOKING_ACK_TEXT, DEFAULT_FLOW_BOOKING_HOLDING_TEXT, DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT]) {
      expect(t).not.toMatch(/[—–]/)
      expect(t).not.toMatch(/all set|you're booked|you are booked/i)
    }
  })
})
