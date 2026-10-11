// @vitest-environment jsdom
//
// W1.L3b — "Payment link" copies a CUSTOMER link the operator pastes on to the
// entrant. It was built on window.location.origin (the CRM host the operator
// is on); it is now minted on the event's tenant host, which the server page
// resolves and passes in as `customerOrigin`.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaceTeamsManager from './RaceTeamsManager.jsx'

const race = { id: 'e1', allowed_team_sizes: [2], waves: [{ id: 'w1', start_time: '09:00:00', label: 'Wave 1', display_order: 0 }] }
const registration = {
  id: 'r1', status: 'pending_payment', team_name: 'Team One', team_size: 2, wave_id: 'w1',
  members: [], payment: { id: 'pay-123' },
}

let writeText
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [registration] }) })))
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceTeamsManager — copied payment link host', () => {
  it("mints the link on the event's tenant host (customerOrigin), not the CRM origin", async () => {
    render(<RaceTeamsManager race={race} customerOrigin="https://gym-a.repset.ie" />)
    fireEvent.click(await screen.findByRole('button', { name: /Payment link/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith('https://gym-a.repset.ie/event-pay/pay-123')
    expect(window.location.origin).not.toBe('https://gym-a.repset.ie')
  })

  it('falls back to the current origin only when the page resolved none', async () => {
    render(<RaceTeamsManager race={race} />)
    fireEvent.click(await screen.findByRole('button', { name: /Payment link/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/event-pay/pay-123`)
  })
})
