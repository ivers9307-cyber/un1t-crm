// @vitest-environment jsdom
//
// SEGMENTROUTE.1 (DECISION R1) — saving, editing and deleting a saved segment
// need Contacts AND Email at the studio (src/lib/segment-access.js). /contacts
// opens on Contacts alone, so the page tells ContactsView whether the caller
// may save (`canSaveSegments`, the server's own canWriteSegmentsAt) and the
// view must not offer Save-as-segment or the delete X when it may not.
// Applying a saved segment (a read) stays open to everyone who can see them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'

// The builder and the table are not what this pins; stubs keep the render small.
vi.mock('./AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))
vi.mock('./ContactsTable', () => ({ default: () => <div data-testid="contacts-table" /> }))

import ContactsView from './ContactsView.jsx'

const SEGMENTS = [
  { id: 'seg-1', name: 'Locked members', description: null, filter: { logic: 'and', filters: [{ field: 'glofox_membership_state', op: 'eq', value: 'locked' }] } },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.startsWith('/api/contacts/segments')) return { ok: true, json: async () => ({ success: true, segments: SEGMENTS }) }
    return { ok: true, json: async () => ({ success: true, contacts: [], count: 0, crossoverContext: {}, listFlags: {} }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function openSavedSegment(props) {
  render(<ContactsView initialContacts={[]} locationId="loc-1" {...props} />)
  // Applying the saved segment opens the advanced panel with one filter row,
  // which is when Save-as-segment would show.
  fireEvent.click(await screen.findByRole('button', { name: 'Locked members' }))
  await waitFor(() => expect(screen.getByTestId('audience-builder')).toBeTruthy())
}

describe('ContactsView saved segments: Save and delete follow canSaveSegments', () => {
  it('with canSaveSegments, offers Save as segment and the delete button', async () => {
    await openSavedSegment({ canSaveSegments: true })
    expect(screen.getByRole('button', { name: /save as segment/i })).toBeTruthy()
    expect(screen.getByTitle('Delete segment')).toBeTruthy()
  })

  it('without it (Contacts but no Email), lists and applies segments but offers neither', async () => {
    await openSavedSegment({ canSaveSegments: false })
    expect(screen.getByRole('button', { name: 'Locked members' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /save as segment/i })).toBeNull()
    expect(screen.queryByTitle('Delete segment')).toBeNull()
  })

  it('fails closed: a caller that does not pass the prop is offered neither', async () => {
    await openSavedSegment({})
    expect(screen.queryByRole('button', { name: /save as segment/i })).toBeNull()
    expect(screen.queryByTitle('Delete segment')).toBeNull()
  })
})
