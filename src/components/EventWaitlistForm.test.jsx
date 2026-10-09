// @vitest-environment jsdom
//
// EVENT-WAITLIST.1 — the public waitlist form: posts name, email, phone,
// size and consent; success shows the fixed sentence; a refusal shows the
// server's words; never a count.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import EventWaitlistForm, { WAITLIST_SUCCESS_COPY } from './EventWaitlistForm.jsx'

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fill({ name = 'Ann Example', email = 'Ann@Example.test', phone = '' } = {}) {
  fireEvent.change(screen.getByLabelText('Name *'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Email *'), { target: { value: email } })
  if (phone) fireEvent.change(screen.getByLabelText('Phone'), { target: { value: phone } })
}

describe('EventWaitlistForm', () => {
  it('joins and shows the fixed success sentence', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ success: true, data: { id: 'wl1' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<EventWaitlistForm slug="hatch-oct18-1100" allowedTeamSizes={[2, 1]} sizeLabel="Team size" />)
    fill({ phone: '087 000 0000' })
    fireEvent.change(screen.getByLabelText('Team size'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /join the waitlist/i }))
    await screen.findByText(WAITLIST_SUCCESS_COPY)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/public/events/hatch-oct18-1100/waitlist')
    expect(JSON.parse(init.body)).toEqual({ name: 'Ann Example', email: 'ann@example.test', phone: '087 000 0000', headcount: 2, consent: true })
  })

  it('a single size hides the size picker and sends 1; no phone is fine', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ success: true, data: { id: 'wl1' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<EventWaitlistForm slug="s" allowedTeamSizes={[1]} />)
    expect(screen.queryByLabelText('Group size')).toBeNull()
    fill()
    fireEvent.click(screen.getByRole('button', { name: /join the waitlist/i }))
    await screen.findByText(WAITLIST_SUCCESS_COPY)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'Ann Example', email: 'ann@example.test', headcount: 1, consent: true })
  })

  it('shows the server refusal (spots are available) and stays on the form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ success: false, code: 'has_room', error: 'Spots are available, book directly.' }, 409)))
    render(<EventWaitlistForm slug="s" allowedTeamSizes={[1]} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /join the waitlist/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch('Spots are available, book directly.')
    expect(screen.queryByText(WAITLIST_SUCCESS_COPY)).toBeNull()
  })

  it('checks the email and phone before posting', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<EventWaitlistForm slug="s" allowedTeamSizes={[1]} />)
    fill({ email: 'nope' })
    fireEvent.click(screen.getByRole('button', { name: /join the waitlist/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/valid email/))
    fill({ phone: '12' })
    fireEvent.click(screen.getByRole('button', { name: /join the waitlist/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/phone/))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the consent box names the host on a hosted event, and unticking sends false', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ success: true, data: { id: 'wl1' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<EventWaitlistForm slug="s" allowedTeamSizes={[1]} hostName="Run Club" organizationName="UN1T Dublin" />)
    expect(document.body.textContent).toMatch(/emails from Run Club/)
    fireEvent.click(screen.getByRole('checkbox'))
    fill()
    fireEvent.click(screen.getByRole('button', { name: /join the waitlist/i }))
    await screen.findByText(WAITLIST_SUCCESS_COPY)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).consent).toBe(false)
  })

  it('copy has no em-dash and no number of people waiting', () => {
    render(<EventWaitlistForm slug="s" allowedTeamSizes={[1]} />)
    expect(document.body.textContent + WAITLIST_SUCCESS_COPY).not.toMatch(/—/)
    expect(document.body.textContent).not.toMatch(/\d+ (people|person)s? (waiting|ahead)/i)
  })
})
