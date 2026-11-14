// @vitest-environment jsdom
//
// STAFFCONSENT.1 — the per-studio switch with a reason on the contact page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import ContactMarketingPreferencesCard from './ContactMarketingPreferencesCard'

const STILL = 'loc-still'
const HATCH = 'loc-hatch'

const GET_BODY = {
  success: true,
  preferences: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true, email_administrative: true },
  studios: [
    { location_id: HATCH, name: 'Hatch Street', email_marketing: true, can_edit: false },
    { location_id: STILL, name: 'Stillorgan', email_marketing: false, can_edit: true },
  ],
  studios_error: false,
}

let postResponse
beforeEach(() => {
  postResponse = { ok: true, status: 200, body: { success: true, data: { changed: ['email_marketing'] } } }
  global.fetch = vi.fn(async (url, opts) => {
    if (opts?.method === 'POST') {
      return { ok: postResponse.ok, status: postResponse.status, json: async () => postResponse.body }
    }
    return { ok: true, status: 200, json: async () => GET_BODY }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const renderCard = () => render(<ContactMarketingPreferencesCard contactId="c1" canEdit />)
const stillSwitch = () => screen.getByRole('button', { name: /switch on marketing email at Stillorgan/i })

describe('ContactMarketingPreferencesCard studio lists', () => {
  it('lists each studio with its state; only editable studios have a switch', async () => {
    renderCard()
    await screen.findByText('Stillorgan')
    expect(screen.getByText('Hatch Street')).toBeTruthy()
    expect(stillSwitch()).toBeTruthy()
    expect(screen.queryByRole('button', { name: /marketing email at Hatch Street/i })).toBeNull()
  })

  it('switching opens a reason dialog; Save waits for a reason', async () => {
    renderCard()
    await screen.findByText('Stillorgan')
    fireEvent.click(stillSwitch())
    const dialog = await screen.findByRole('dialog')
    const save = within(dialog).getByRole('button', { name: 'Save' })
    expect(save.disabled).toBe(true)
    expect(within(dialog).getAllByRole('radio')).toHaveLength(5)
    fireEvent.click(within(dialog).getByLabelText('They asked by email'))
    expect(save.disabled).toBe(false)
  })

  it('other needs a note before Save', async () => {
    renderCard()
    await screen.findByText('Stillorgan')
    fireEvent.click(stillSwitch())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText(/Other/))
    const save = within(dialog).getByRole('button', { name: 'Save' })
    expect(save.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/Note/), { target: { value: '   ' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/Note/), { target: { value: 'came in with a friend' } })
    expect(save.disabled).toBe(false)
  })

  it('Save posts to the route and updates the row', async () => {
    renderCard()
    await screen.findByText('Stillorgan')
    fireEvent.click(stillSwitch())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText('They asked by email'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const post = global.fetch.mock.calls.find(([, o]) => o?.method === 'POST')
    expect(post[0]).toBe('/api/contacts/c1/studio-consent')
    expect(JSON.parse(post[1].body)).toEqual({ location_id: STILL, email_marketing: true, reason: 'email' })
    expect(screen.getByRole('button', { name: /switch off marketing email at Stillorgan/i })).toBeTruthy()
  })

  it('a failure shows the error and leaves the row as it was', async () => {
    postResponse = { ok: false, status: 500, body: { success: false, error: 'Could not record the preference' } }
    renderCard()
    await screen.findByText('Stillorgan')
    fireEvent.click(stillSwitch())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText('They asked by phone'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await within(dialog).findByText('Could not record the preference')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(stillSwitch()).toBeTruthy()
  })

  it('every button carries a type', async () => {
    renderCard()
    await screen.findByText('Stillorgan')
    fireEvent.click(stillSwitch())
    await screen.findByRole('dialog')
    for (const b of document.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button')
  })
})
