// @vitest-environment jsdom
//
// EMAIL-ASSIGN.1 — the ownership control's three faces: Claim on an
// unassigned ticket, Release on your own, and the elevated reassign picker
// fed by the assignees route. The route-level rules are pinned in
// assign/route.test.js; this file pins that the control OFFERS the right
// action to the right viewer — a claim button that never renders is a dead
// feature no route test can see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import TicketThread from './TicketThread.jsx'

beforeEach(() => {
  // jsdom has no scrollIntoView; the thread scroll-follows new messages.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})

const TICKET = {
  id: 'T-1', status: 'open', requester_email: 'member@example.com',
  mailbox: { id: 'mb-1', label: 'Studio', address: 'studio@x.com' },
}
const noop = () => {}

function renderThread(ticket, { viewerIsElevated = false, onAssign = noop, assignees } = {}) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).includes('/assignees')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { assignees: assignees || [] } }) })
    }
    return new Promise(() => {})
  }))
  return render(
    <TicketThread
      hasSelection
      ticket={ticket}
      messages={[]}
      currentUserId="me-1"
      onBack={noop}
      onStatusChange={noop}
      onSend={noop}
      onForward={noop}
      onAssign={onAssign}
      viewerIsElevated={viewerIsElevated}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TicketThread — ownership control', () => {
  it('offers Claim on an unassigned ticket and reports the claim as "me"', () => {
    const onAssign = vi.fn()
    renderThread({ ...TICKET, assigned_to: null }, { onAssign })
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }))
    expect(onAssign).toHaveBeenCalledWith('me')
  })

  it('offers Release on my own ticket, and no Claim', () => {
    const onAssign = vi.fn()
    renderThread({ ...TICKET, assigned_to: 'me-1' }, { onAssign })
    expect(screen.queryByRole('button', { name: 'Claim' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onAssign).toHaveBeenCalledWith(null)
  })

  it("offers a non-elevated viewer NOTHING on somebody else's ticket", () => {
    renderThread({ ...TICKET, assigned_to: 'someone-else' })
    expect(screen.queryByRole('button', { name: 'Claim' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unassign' })).toBeNull()
  })

  it('gives an elevated viewer the picker, fed by the assignees route, firing the chosen id', async () => {
    const onAssign = vi.fn()
    renderThread({ ...TICKET, assigned_to: null }, {
      viewerIsElevated: true,
      onAssign,
      assignees: [{ id: 'p-2', full_name: 'Casey Coach' }],
    })
    const picker = await screen.findByLabelText('Assign to')
    fireEvent.change(picker, { target: { value: 'p-2' } })
    expect(onAssign).toHaveBeenCalledWith('p-2')
  })

  it('never fetches the assignees list for a non-elevated viewer', () => {
    // (The composer's SignatureHint fetches preferences — only the
    // access-enumerating assignees route must stay un-hit.)
    renderThread({ ...TICKET, assigned_to: null })
    const urls = globalThis.fetch.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/assignees'))).toBe(false)
  })
})
