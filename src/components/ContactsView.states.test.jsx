// @vitest-environment jsdom
//
// VISREFRESH.1 — the contacts list names its state. A failed read, a filter
// with no matches and a studio with no contacts each get their own block;
// before this they all rendered "No contacts found." and the server's read
// error was discarded.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('./AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))
vi.mock('./ContactsTable', () => ({ default: ({ contacts }) => <div data-testid="contacts-table">{contacts.length} rows</div> }))

import ContactsView from './ContactsView.jsx'

const ROWS = [
  { id: 'c1', name: 'Ava', email: 'ava@example.com', pipeline_stage_slug: 'new_lead' },
  { id: 'c2', name: 'Ben', email: 'ben@example.com', pipeline_stage_slug: 'member' },
]

let searchImpl
beforeEach(() => {
  searchImpl = async () => ({ ok: true, json: async () => ({ success: true, contacts: [], count: 0, crossoverContext: {}, listFlags: {} }) })
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    if (u.startsWith('/api/contacts/segments')) return { ok: true, json: async () => ({ success: true, segments: [] }) }
    return searchImpl(u, init)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ContactsView list states', () => {
  it('rows: shows the table and a count', () => {
    render(<ContactsView initialContacts={ROWS} locationId="loc-1" />)
    expect(screen.getByTestId('contacts-table').textContent).toBe('2 rows')
    expect(screen.getByText('2 contacts')).toBeTruthy()
    expect(screen.queryByText(/No contacts/)).toBeNull()
  })

  it('empty: no contacts and no filters offers New contact only to a creator', () => {
    const { unmount } = render(<ContactsView initialContacts={[]} locationId="loc-1" canCreate />)
    expect(screen.getByText('No contacts yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: /new contact/i })).toBeTruthy()
    expect(screen.queryByTestId('contacts-table')).toBeNull()
    unmount()
    render(<ContactsView initialContacts={[]} locationId="loc-1" />)
    expect(screen.getByText('No contacts yet')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /new contact/i })).toBeNull()
  })

  it('error: the server read failed → error block with Try again, never "no contacts"', async () => {
    searchImpl = async () => ({ ok: true, json: async () => ({ success: true, contacts: ROWS, count: 2, crossoverContext: {}, listFlags: {} }) })
    render(<ContactsView initialContacts={[]} locationId="loc-1" initialError="The contact list could not be read." />)
    expect(screen.getByRole('alert').textContent).toContain("Contacts couldn't be loaded")
    expect(screen.queryByText('No contacts yet')).toBeNull()
    // Try again re-reads through the search route and the rows appear.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('contacts-table').textContent).toBe('2 rows'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('no matches: a search the API answers with zero rows → "no contacts match", and Clear filters restores the list', async () => {
    render(<ContactsView initialContacts={ROWS} locationId="loc-1" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search contacts' }), { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByText('No contacts match “zzz”')).toBeTruthy())
    expect(screen.queryByTestId('contacts-table')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(screen.getByTestId('contacts-table').textContent).toBe('2 rows'))
  })

  it('a failed search keeps nothing stale: error block, then Try again recovers', async () => {
    searchImpl = async () => ({ ok: false, json: async () => ({ success: false, error: 'Search failed' }) })
    render(<ContactsView initialContacts={ROWS} locationId="loc-1" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search contacts' }), { target: { value: 'ava' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Search failed'))
    searchImpl = async () => ({ ok: true, json: async () => ({ success: true, contacts: [ROWS[0]], count: 1, crossoverContext: {}, listFlags: {} }) })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('contacts-table').textContent).toBe('1 rows'))
    expect(screen.getByText('Showing 1 of 1 contacts')).toBeTruthy()
  })

  it('stage chips keep their URL and read as "New lead", with the active one marked', () => {
    render(<ContactsView initialContacts={ROWS} locationId="loc-1" initialStatus="new_lead" />)
    const chip = screen.getByRole('link', { name: 'New lead' })
    expect(chip.getAttribute('href')).toBe('/contacts?status=new_lead')
    expect(chip.getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBeNull()
  })
})
