// @vitest-environment jsdom
//
// GAPS-P8 — the assist must stay an assist: nothing requested until asked,
// nothing applied until clicked, and a dead endpoint must be a one-line notice
// rather than anything the composer notices.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import CopyAssist from './CopyAssist.jsx'

const LOC = 'a0000000-0000-0000-0000-000000000001'

const ok = (data) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) })

let fetchMock

beforeEach(() => {
  fetchMock = vi.fn(() => ok({ available: true, kind: 'subject', suggestions: ['Membership is open again'], dropped: [] }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const open = () => fireEvent.click(screen.getByRole('button', { name: /suggest alternatives/i }))

describe('CopyAssist', () => {
  it('asks for nothing until the operator opens it and clicks Suggest', async () => {
    render(<CopyAssist locationId={LOC} subject="Weekend offer" onUseSubject={() => {}} />)
    expect(fetchMock).not.toHaveBeenCalled()
    open()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('says plainly that the text is machine-generated, unreviewed and factually ignorant', () => {
    render(<CopyAssist locationId={LOC} subject="x" onUseSubject={() => {}} />)
    open()
    const note = screen.getByText(/language model/i)
    expect(note.textContent).toMatch(/not reviewed/i)
    expect(note.textContent).toMatch(/does not know/i)
  })

  it('carries no em dash and no emoji in its own copy', () => {
    const { container } = render(<CopyAssist locationId={LOC} subject="x" onUseSubject={() => {}} />)
    open()
    expect(container.textContent).not.toMatch(/[—–]/)
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('every button is type="button" so it can never submit a surrounding form', () => {
    const { container } = render(<CopyAssist locationId={LOC} subject="x" onUseSubject={() => {}} />)
    open()
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button')
  })

  it('will not fire with nothing to rewrite', () => {
    render(<CopyAssist locationId={LOC} subject="" onUseSubject={() => {}} />)
    open()
    expect(screen.getByRole('button', { name: 'Suggest' }).disabled).toBe(true)
  })

  it('applies a suggestion only when the operator clicks Use', async () => {
    const onUseSubject = vi.fn()
    render(<CopyAssist locationId={LOC} subject="Weekend offer" onUseSubject={onUseSubject} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    await screen.findByText('Membership is open again')
    expect(onUseSubject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(onUseSubject).toHaveBeenCalledWith('Membership is open again')
  })

  it('sends the brief and the draft, and never anything about the audience', async () => {
    render(<CopyAssist locationId={LOC} subject="Weekend offer" getBody={async () => '<p>Draft</p>'} onUseSubject={() => {}} />)
    open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'membership reopens' } })
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent).toEqual({
      location_id: LOC,
      kind: 'subject',
      brief: 'membership reopens',
      subject: 'Weekend offer',
      body: '<p>Draft</p>',
    })
  })

  it('reports the assist as unavailable without disturbing anything else', async () => {
    fetchMock.mockImplementation(() => ok({ available: false, reason: 'not_configured', suggestions: [], dropped: [] }))
    render(<CopyAssist locationId={LOC} subject="Weekend offer" onUseSubject={() => {}} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    expect(await screen.findByText(/not available right now/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull()
  })

  it('survives a network failure', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')))
    render(<CopyAssist locationId={LOC} subject="Weekend offer" onUseSubject={() => {}} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    expect(await screen.findByText(/not available right now/i)).toBeTruthy()
  })

  it('tells the operator when suggestions were discarded', async () => {
    fetchMock.mockImplementation(() => ok({
      available: true, kind: 'subject', suggestions: ['Membership is open again'],
      dropped: [{ reason: 'unsupported_claim' }, { reason: 'capacity' }],
    }))
    render(<CopyAssist locationId={LOC} subject="Weekend offer" onUseSubject={() => {}} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    expect(await screen.findByText(/2 suggestions were discarded/i)).toBeTruthy()
  })

  it('offers copy, not apply, for body variants — the designer owns the layout', async () => {
    fetchMock.mockImplementation(() => ok({ available: true, kind: 'body', suggestions: ['Hi there'], dropped: [] }))
    render(<CopyAssist locationId={LOC} subject="Weekend offer" onUseSubject={() => {}} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Body copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }))
    await screen.findByText('Hi there')
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })
})
