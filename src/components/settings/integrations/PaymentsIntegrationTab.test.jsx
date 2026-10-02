// @vitest-environment jsdom
// REVIEWNITS.1 (D5, from CHANNELREAD.1): the Stripe status read's failure was
// swallowed, so a location whose onboarding is finished read "Onboarding not
// finished" whenever the status call failed. A failed read now says it could
// not check; a good read still decides.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }))

import PaymentsIntegrationTab from './PaymentsIntegrationTab.jsx'

const LOC = {
  id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio',
  settings: { payments: { provider: 'stripe_connect', stripe_connected_account_id: 'acct_test' } },
}
const NOT_FINISHED = /Onboarding not finished/
const COULD_NOT_CHECK = "Couldn't check the Stripe status just now. Refresh to try again."

let statusAnswer
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => statusAnswer()))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('PaymentsIntegrationTab — the Stripe status line', () => {
  it('a failed status read says it could not check, not "onboarding not finished"', async () => {
    statusAnswer = () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'stripe down' }) })
    render(<PaymentsIntegrationTab location={LOC} canEdit />)
    await waitFor(() => expect(screen.getByText(COULD_NOT_CHECK)).toBeTruthy())
    expect(screen.queryByText(NOT_FINISHED)).toBeNull()
  })

  it('a status read that throws says the same', async () => {
    statusAnswer = () => { throw new Error('offline') }
    render(<PaymentsIntegrationTab location={LOC} canEdit />)
    await waitFor(() => expect(screen.getByText(COULD_NOT_CHECK)).toBeTruthy())
  })

  it('a good read still decides: not enabled reads "onboarding not finished", enabled reads ready', async () => {
    statusAnswer = () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { charges_enabled: false } }) })
    render(<PaymentsIntegrationTab location={LOC} canEdit />)
    await waitFor(() => expect(screen.getByText(NOT_FINISHED)).toBeTruthy())
    cleanup()
    statusAnswer = () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { charges_enabled: true } }) })
    render(<PaymentsIntegrationTab location={LOC} canEdit />)
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeTruthy())
  })
})
