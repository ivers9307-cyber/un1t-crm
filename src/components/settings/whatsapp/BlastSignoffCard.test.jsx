// @vitest-environment jsdom
//
// ORGCONTACTS.0 (spec §3.3, decision 6) — the "Sign-off until" card on the
// studio WhatsApp tab: reads the window, lets an org admin set or clear it,
// and shows it read-only to everyone else. Ids are synthetic.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import BlastSignoffCard from './BlastSignoffCard.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000002'
const URL_ = `/api/locations/${LOC}/whatsapp/blast-signoff`
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

let putBodies
function mockServer({ until, can_edit, putAnswer }) {
  putBodies = []
  global.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') {
      putBodies.push(JSON.parse(init.body))
      return putAnswer(putBodies.at(-1))
    }
    return reply(200, { success: true, data: { until, can_edit } })
  })
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete global.fetch })

describe('BlastSignoffCard', () => {
  it('shows the label, the hint and the stored date; saving PUTs { until }', async () => {
    mockServer({ until: '2026-11-16', can_edit: true, putAnswer: (b) => reply(200, { success: true, data: { until: b.until, can_edit: true } }) })
    render(<BlastSignoffCard locationId={LOC} />)
    const input = await screen.findByLabelText('Sign-off until')
    expect(input.value).toBe('2026-11-16')
    expect(screen.getByText("Blasts at this studio need an organisation admin's sign-off until this date. Clear it to end the window.")).toBeTruthy()
    fireEvent.change(input, { target: { value: '2026-12-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putBodies).toEqual([{ until: '2026-12-01' }]))
    expect(global.fetch.mock.calls.at(-1)[0]).toBe(URL_)
  })

  it('Clear sends null and is a plain button, never a submit', async () => {
    mockServer({ until: '2026-11-16', can_edit: true, putAnswer: () => reply(200, { success: true, data: { until: null, can_edit: true } }) })
    render(<BlastSignoffCard locationId={LOC} />)
    const clear = await screen.findByRole('button', { name: 'Clear' })
    expect(clear.getAttribute('type')).toBe('button')
    fireEvent.click(clear)
    await waitFor(() => expect(putBodies).toEqual([{ until: null }]))
    await waitFor(() => expect(screen.getByLabelText('Sign-off until').value).toBe(''))
  })

  it('without can_edit the date is shown read-only and nothing can be saved', async () => {
    mockServer({ until: '2026-11-16', can_edit: false, putAnswer: () => { throw new Error('must not PUT') } })
    render(<BlastSignoffCard locationId={LOC} />)
    expect(await screen.findByText('16 Nov 2026')).toBeTruthy()
    expect(screen.queryByLabelText('Sign-off until')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it("a refused save shows the route's message", async () => {
    mockServer({ until: null, can_edit: true, putAnswer: () => reply(400, { success: false, error: 'Use a real calendar date like 2026-11-16.' }) })
    render(<BlastSignoffCard locationId={LOC} />)
    const input = await screen.findByLabelText('Sign-off until')
    fireEvent.change(input, { target: { value: '2026-12-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Use a real calendar date like 2026-11-16.')).toBeTruthy()
  })
})
