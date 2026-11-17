// @vitest-environment jsdom
//
// CONTACTTAGS.1 — the bulk tag dialog and its wiring into the contacts list's
// bulk bar.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

// The bar loads its modals lazily. The tag modal is stood in for by a probe
// that shows the props the bar hands it (the real modal is tested above it).
vi.mock('next/dynamic', () => ({
  default: (loader) => {
    if (!String(loader).includes('ContactBulkTagModal')) return () => null
    return function TagModalProbe({ action, contactIds }) {
      return <div data-testid="tag-modal-probe">{`${action}:${contactIds.join(',')}`}</div>
    }
  },
}))

import ContactBulkTagModal, { bulkTagSummary } from './ContactBulkTagModal.jsx'
import ContactsTable from './ContactsTable.jsx'

const C1 = 'c0000000-0000-4000-8000-000000000001'
const C2 = 'c0000000-0000-4000-8000-000000000002'

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { requested: 2, updated: 1, unchanged: 0, skipped: 1, failed: 0 } }) }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('bulkTagSummary', () => {
  it('counts only, never names', () => {
    expect(bulkTagSummary('add', { updated: 3, unchanged: 1, skipped: 2, failed: 1 }))
      .toBe('3 tagged · 1 already had it · 2 skipped (not available to you at this studio) · 1 could not be saved, try again')
    expect(bulkTagSummary('remove', { updated: 0, unchanged: 2, skipped: 0, failed: 0 })).toBe('0 untagged · 2 did not have it')
  })
})

describe('ContactBulkTagModal', () => {
  it('posts one tag and the action, then shows the counts', async () => {
    render(<ContactBulkTagModal action="add" contactIds={[C1, C2]} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText(/Tag/), { target: { value: ' vip ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1 tagged · 1 skipped/))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/contacts/bulk-tags')
    expect(JSON.parse(init.body)).toEqual({ contact_ids: [C1, C2], tag: 'vip', action: 'add' })
  })

  it('shows the route error and keeps the form', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ success: false, error: 'Contacts permission required' }) })
    render(<ContactBulkTagModal action="remove" contactIds={[C1]} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText(/Tag/), { target: { value: 'vip' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag' }))
    await waitFor(() => expect(screen.getByText('Contacts permission required')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('ContactsTable bulk bar — tag buttons', () => {
  const rows = [
    { id: C1, name: 'Sam Sample', email: null, phone: null, tags: [] },
    { id: C2, name: 'Alex Example', email: null, phone: null, tags: [] },
  ]

  it('hidden without canTag', () => {
    render(<ContactsTable contacts={rows} locationId="l-1" />)
    fireEvent.click(screen.getAllByLabelText('Select Sam Sample')[0])
    expect(screen.queryByRole('button', { name: /Add tag/ })).toBeNull()
  })

  it('opens the dialog for the selected contacts with the chosen action', () => {
    render(<ContactsTable contacts={rows} locationId="l-1" canTag />)
    fireEvent.click(screen.getAllByLabelText('Select Sam Sample')[0])
    fireEvent.click(screen.getByRole('button', { name: /Remove tag/ }))
    expect(screen.getByTestId('tag-modal-probe').textContent).toBe(`remove:${C1}`)
  })
})
