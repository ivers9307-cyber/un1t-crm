// @vitest-environment jsdom
//
// SEGPICK.1 — the Segments tab listed ONLY the 6 hardcoded machine tag cards,
// so a segment saved on /contacts appeared nowhere in Communications and an
// operator reasonably concluded the save had failed. This is the second group:
// the location's own saved filters, each with "Email these" and "WhatsApp these" deep links
// mirroring the tag cards' — but on ?segment_id, not ?segment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

import SavedSegmentsList from './SavedSegmentsList.jsx'

const SEGMENTS = [
  { id: 'seg-1', name: 'Overdue arrears', description: 'Members in payment arrears', filter: { logic: 'and', filters: [] } },
  { id: 'seg-2', name: 'Cold leads', description: null, filter: { logic: 'and', filters: [] } },
]

let calls = []
let response = { success: true, segments: SEGMENTS }

beforeEach(() => {
  calls = []
  response = { success: true, segments: SEGMENTS }
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    calls.push(String(url))
    return { ok: true, json: async () => response }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SavedSegmentsList', () => {
  it('lists the location saved segments with their descriptions', async () => {
    render(<SavedSegmentsList locationId="loc-1" />)
    await waitFor(() => expect(screen.getByText('Overdue arrears')).toBeTruthy())
    expect(screen.getByText('Members in payment arrears')).toBeTruthy()
    expect(screen.getByText('Cold leads')).toBeTruthy()
    expect(calls[0]).toContain('location_id=loc-1')
  })

  it('links each one to the email editor and the WhatsApp composer on ?segment_id (not ?segment)', async () => {
    render(<SavedSegmentsList locationId="loc-1" />)
    await waitFor(() => expect(screen.getAllByRole('link', { name: /email these/i })).toHaveLength(2))
    const email = screen.getAllByRole('link', { name: /email these/i }).map(a => a.getAttribute('href'))
    const wa = screen.getAllByRole('link', { name: /whatsapp these/i }).map(a => a.getAttribute('href'))
    expect(email).toEqual([
      '/communications/new-email?segment_id=seg-1',
      '/communications/new-email?segment_id=seg-2',
    ])
    expect(wa).toEqual([
      '/communications/send?segment_id=seg-1',
      '/communications/send?segment_id=seg-2',
    ])
  })

  it('states that membership is live rather than a frozen list', async () => {
    render(<SavedSegmentsList locationId="loc-1" />)
    await waitFor(() => expect(screen.getByText(/re-?run|re-?evaluat/i)).toBeTruthy())
  })

  it('sends the operator to /contacts when there are none', async () => {
    response = { success: true, segments: [] }
    render(<SavedSegmentsList locationId="loc-1" />)
    await waitFor(() => expect(screen.getByText(/no saved segments yet/i)).toBeTruthy())
    expect(screen.getByRole('link', { name: /contacts/i }).getAttribute('href')).toBe('/contacts')
  })

  it('surfaces a load failure instead of looking empty', async () => {
    response = { success: false, error: 'Forbidden' }
    render(<SavedSegmentsList locationId="loc-1" />)
    await waitFor(() => expect(screen.getByText(/Forbidden/)).toBeTruthy())
    expect(screen.queryByText(/no saved segments yet/i)).toBeNull()
  })
})
