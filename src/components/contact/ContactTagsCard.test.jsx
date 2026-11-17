// @vitest-environment jsdom
//
// CONTACTTAGS.1 — the profile Tags card: manual chips (removable, quick add,
// saved through PUT /api/contacts/[id]) and read-only automatic chips.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import ContactTagsCard from './ContactTagsCard.jsx'

const ID = 'c0000000-0000-4000-8000-000000000001'
const MACHINE = [{ tag: 'race_completed', addedAt: '2026-10-01', description: 'Finished a race.' }]

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ success: true, data: { tags: body.tags } }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ContactTagsCard', () => {
  it('shows both stores, the automatic ones read-only with an explaining title', () => {
    render(<ContactTagsCard contactId={ID} initialTags={['vip']} machineTags={MACHINE} canEdit={false} />)
    expect(screen.getByText('vip')).toBeTruthy()
    const auto = screen.getByText('race_completed')
    expect(auto.getAttribute('title')).toMatch(/Finished a race\. Set automatically; not editable here\./)
    expect(screen.queryByRole('button', { name: /Remove tag/ })).toBeNull()
    expect(screen.queryByLabelText('Add tag')).toBeNull()
  })

  it('adds a tag through PUT with the whole new array', async () => {
    render(<ContactTagsCard contactId={ID} initialTags={['vip']} machineTags={MACHINE} canEdit />)
    fireEvent.change(screen.getByLabelText('Add tag'), { target: { value: '  Morning  crew ' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    await waitFor(() => expect(screen.getByText('Morning crew')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/contacts/${ID}`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ tags: ['vip', 'Morning crew'] })
  })

  it('adding a tag it already has sends nothing', async () => {
    render(<ContactTagsCard contactId={ID} initialTags={['vip']} canEdit />)
    fireEvent.change(screen.getByLabelText('Add tag'), { target: { value: 'vip' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    await waitFor(() => expect(screen.getByLabelText('Add tag').value).toBe(''))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('removes a tag, never an automatic one', async () => {
    render(<ContactTagsCard contactId={ID} initialTags={['vip', 'other']} machineTags={MACHINE} canEdit />)
    expect(screen.getAllByRole('button', { name: /Remove tag/ })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag vip' }))
    await waitFor(() => expect(screen.queryByText('vip')).toBeNull())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ tags: ['other'] })
  })

  it('a refused save keeps the chips and shows the error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ success: false, error: 'not_found' }) })
    render(<ContactTagsCard contactId={ID} initialTags={['vip']} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag vip' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('not_found'))
    expect(screen.getByText('vip')).toBeTruthy()
  })
})
