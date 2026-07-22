import { describe, it, expect } from 'vitest'
import { agentRequestSubtitle } from './agent-requests'

describe('agentRequestSubtitle — paid class booking', () => {
  it('appends a paid marker when the booking was paid', () => {
    const s = agentRequestSubtitle({ kind: 'class_booking', details: { class_name: 'HIIT', class_time: 'Mon 6pm', paid: true, amount_cents: 2900, currency: 'EUR' } })
    expect(s).toBe('HIIT · Mon 6pm · 💳 Paid €29')
  })
  it('omits the marker for a free booking', () => {
    const s = agentRequestSubtitle({ kind: 'class_booking', details: { class_name: 'HIIT', class_time: 'Mon 6pm' } })
    expect(s).toBe('HIIT · Mon 6pm')
  })
})
