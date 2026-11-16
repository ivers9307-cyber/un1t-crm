// @vitest-environment jsdom
//
// PAYLINK.1 — the "Continue to payment" form. An existing member gets no tick,
// but a terms_required answer (no account found after all) reveals it; a
// recent checkout answers `confirming`; a new customer must tick first.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import BuyForm from './BuyForm.jsx'

const TERMS = {
  required: true, label: 'I accept the {terms} and the {waiver}', terms_link_label: 'terms', waiver_link_label: 'waiver',
  required_message: 'Please accept the terms.', terms_url: '/legal/un1t/hatch-street/terms', waiver_url: '/legal/un1t/hatch-street/waiver',
}
const MESSAGES = { paid: 'All paid.', expired: 'Expired.', unavailable: 'Try again.', help: 'We will help.', confirming: 'Confirming. Please try again in a few minutes.' }
const TOKEN = 'a'.repeat(43)
const answer = (data, status = 200) => Promise.resolve({ status, json: () => Promise.resolve({ success: status < 400, data }) })

beforeEach(() => { globalThis.fetch = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = (isNew) => render(<BuyForm token={TOKEN} isNew={isNew} terms={TERMS} buttonText="Continue to payment" messages={MESSAGES} />)

describe('BuyForm', () => {
  it('an existing member: no tick; a terms_required answer reveals it and the next press sends acceptTerms', async () => {
    mount(false)
    expect(screen.queryByRole('checkbox')).toBe(null)
    fetch.mockReturnValueOnce(answer({ kind: 'terms_required' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy())
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ acceptTerms: false })

    fetch.mockReturnValueOnce(answer({ kind: 'paid' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }))
    await waitFor(() => expect(screen.getByText('All paid.')).toBeTruthy())
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ acceptTerms: true })
  })

  it('a new customer must tick before anything is sent', async () => {
    mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Please accept the terms.'))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('confirming: the confirming line, no second press offered', async () => {
    mount(false)
    fetch.mockReturnValueOnce(answer({ kind: 'confirming' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }))
    await waitFor(() => expect(screen.getByText(MESSAGES.confirming)).toBeTruthy())
    expect(screen.queryByRole('button')).toBe(null)
  })

  it('unavailable keeps the button for another try', async () => {
    mount(false)
    fetch.mockReturnValueOnce(answer({ kind: 'unavailable' }, 503))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Try again.'))
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeTruthy()
  })
})
