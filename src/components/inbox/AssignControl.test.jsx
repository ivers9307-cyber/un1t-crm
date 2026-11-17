// @vitest-environment jsdom
// INBOXASSIGN.1 — the "Assigned to …" control in a thread header.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import AssignControl from './AssignControl.jsx'

const ME = 'u-me'
const ALEX = 'u-alex'
const picker = (over = {}) => ({
  success: true,
  data: {
    assigned_to: null, assignee_name: null, viewer_id: ME,
    staff: [{ id: ALEX, full_name: 'Alex Example' }, { id: ME, full_name: 'Test Manager' }],
    ...over,
  },
})
const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body })

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async (url, init) => {
    if (!init || init.method !== 'POST') return reply(picker())
    const { assignee } = JSON.parse(init.body)
    const id = assignee === 'me' ? ME : assignee
    return reply({ success: true, data: { assigned_to: id, assignee_name: id === ALEX ? 'Alex Example' : id ? 'Test Manager' : null } })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const select = () => screen.getByRole('combobox', { name: 'Assigned to' })
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')

describe('AssignControl', () => {
  it.each([
    ['whatsapp', '/api/whatsapp/conversations/c1/assign'],
    ['instagram', '/api/instagram/conversations/c1/assign'],
    ['mail', '/api/email/mail/c1/assign'],
  ])('loads the %s picker from its own route', async (channel, url) => {
    render(<AssignControl channel={channel} conversationId="c1" />)
    await waitFor(() => expect(select().disabled).toBe(false))
    expect(fetchMock.mock.calls[0][0]).toBe(url)
    expect(screen.getByRole('option', { name: 'Me (Test Manager)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Alex Example' })).toBeTruthy()
    expect(select().value).toBe('')
  })

  it("picking yourself sends 'me' and shows you as owner", async () => {
    const onChanged = vi.fn()
    render(<AssignControl channel="whatsapp" conversationId="c1" onChanged={onChanged} />)
    await waitFor(() => expect(select().disabled).toBe(false))
    fireEvent.change(select(), { target: { value: ME } })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(JSON.parse(posts()[0][1].body)).toEqual({ assignee: 'me' })
    expect(select().value).toBe(ME)
  })

  it('picking a colleague sends their id; Unassigned sends null', async () => {
    render(<AssignControl channel="mail" conversationId="c1" />)
    await waitFor(() => expect(select().disabled).toBe(false))
    fireEvent.change(select(), { target: { value: ALEX } })
    await waitFor(() => expect(select().value).toBe(ALEX))
    expect(JSON.parse(posts()[0][1].body)).toEqual({ assignee: ALEX })
    fireEvent.change(select(), { target: { value: '' } })
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(JSON.parse(posts()[1][1].body)).toEqual({ assignee: null })
    await waitFor(() => expect(select().value).toBe(''))
  })

  it("a refused write shows the route's reason and keeps the old owner", async () => {
    fetchMock.mockImplementation(async (url, init) => (init?.method === 'POST'
      ? reply({ success: false, error: 'That person cannot work this conversation at this studio.' }, false, 400)
      : reply(picker())))
    render(<AssignControl channel="whatsapp" conversationId="c1" />)
    await waitFor(() => expect(select().disabled).toBe(false))
    fireEvent.change(select(), { target: { value: ALEX } })
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot work this conversation/)
    expect(select().value).toBe('')
  })

  it('a failed load says so', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('offline') })
    render(<AssignControl channel="whatsapp" conversationId="c1" />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load/)
  })

  it('keeps an owner who is no longer assignable visible rather than showing someone else', async () => {
    fetchMock.mockImplementation(async () => reply(picker({ assigned_to: 'u-gone', assignee_name: 'Former Coach' })))
    render(<AssignControl channel="whatsapp" conversationId="c1" assignedTo="u-gone" />)
    await waitFor(() => expect(select().disabled).toBe(false))
    expect(select().value).toBe('u-gone')
    expect(screen.getByRole('option', { name: /Former Coach \(cannot work this thread now\)/ })).toBeTruthy()
  })
})
