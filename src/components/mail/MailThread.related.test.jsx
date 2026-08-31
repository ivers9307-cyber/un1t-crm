// @vitest-environment jsdom
//
// MAIL-REFINE.1 (03) — related conversations + merge, as rendered.
//
// The pure decisions (when a nudge is earned, stop-on-first-failure, the
// candidate lines) are pinned in mail-relate.test.js; this file pins the
// LIFECYCLE — that the banner appears off the real endpoint answer and never
// off a failed one, that the picker calls the merge route and refreshes, that
// a failed merge keeps the picker open, and that Undo lives on the toast and
// nowhere else.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import MailThread from './MailThread.jsx'

const CONVERSATION = {
  id: 'a0000000-0000-4000-8000-00000000000a',
  status: 'open',
  subject: 'Flogas bill for Hatch Street',
  requester_email: 'caitlin.thornton@flogas.ie',
  requester_name: 'Caitlin Thornton',
  mailbox: { id: 'mb-1', label: 'Accounts', address: 'accounts@hatch.ie' },
  needs_reply: true,
  archived: false,
  unread: false,
}

const OPEN_RELATED = {
  id: 'r-open-1',
  subject: 'RE: Meter reading — urgent',
  status: 'open',
  message_count: 2,
  last_message_at: '2026-08-28T12:00:00Z',
  requester_name: 'Caitlin Thornton',
}
const ARCHIVED_RELATED = {
  id: 'r-arch-1',
  subject: 'Flogas account setup',
  status: 'closed',
  message_count: 5,
  last_message_at: '2026-08-12T10:00:00Z',
  requester_name: 'Caitlin Thornton',
}

const MESSAGE = {
  id: 'm-1',
  direction: 'inbound',
  from_email: 'caitlin.thornton@flogas.ie',
  to_emails: ['accounts@hatch.ie'],
  text_body: 'Just following up on the meter read.',
  created_at: '2026-08-31T08:00:00Z',
}

// Route-shaped fetch stub. `related` is the payload the related endpoint
// answers; merge/unmerge outcomes are programmable per test.
let calls
function stubNetwork({ related, mergeResults = {}, unmergeResults = {} } = {}) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    const method = init?.method || 'GET'
    calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : null })
    if (u.includes('/related')) {
      if (related === 'fail') return { ok: false, status: 500, json: async () => ({ success: false, error: 'boom' }) }
      return { ok: true, status: 200, json: async () => related }
    }
    if (u.includes('/merge')) {
      const id = u.split('/')[4]
      const table = method === 'DELETE' ? unmergeResults : mergeResults
      const verdict = table[id] ?? { success: true }
      return { ok: true, status: 200, json: async () => verdict }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  }))
}

const RELATED_BODY = (related, openCount) => ({
  success: true,
  data: { related, open_count: openCount },
})

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderThread(props = {}) {
  return render(
    <MailThread
      hasSelection
      conversation={CONVERSATION}
      messages={[MESSAGE]}
      onBack={() => {}}
      onSend={() => {}}
      onArchive={() => {}}
      onMarkRead={() => {}}
      {...props}
    />
  )
}

describe('MailThread — the nudge banner', () => {
  it('appears when the sender has another open conversation, naming them and the count', async () => {
    stubNetwork({ related: RELATED_BODY([OPEN_RELATED], 1) })
    renderThread()
    expect(await screen.findByText('1 other open conversation')).toBeTruthy()
    // The banner names the sender (the header names them too, hence AllBy).
    expect(screen.getAllByText(/Caitlin Thornton/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Merge into this one' })).toBeTruthy()
  })

  it('pluralises the count', async () => {
    stubNetwork({ related: RELATED_BODY([OPEN_RELATED, { ...OPEN_RELATED, id: 'r-open-2' }], 2) })
    renderThread()
    expect(await screen.findByText('2 other open conversations')).toBeTruthy()
  })

  it('stays away with zero open conversations — archived relatives are picker material, not a nudge', async () => {
    stubNetwork({ related: RELATED_BODY([ARCHIVED_RELATED], 0) })
    renderThread()
    await waitFor(() => expect(calls.some(c => c.url.includes('/related'))).toBe(true))
    expect(screen.queryByRole('button', { name: 'Merge into this one' })).toBeNull()
  })

  // 🔴 A failed read must never render as "no related conversations" — but it
  // must not render as a nudge either. Nothing is the only honest answer.
  it('stays away when the related read fails', async () => {
    stubNetwork({ related: 'fail' })
    renderThread()
    await waitFor(() => expect(calls.some(c => c.url.includes('/related'))).toBe(true))
    expect(screen.queryByRole('button', { name: 'Merge into this one' })).toBeNull()
  })

  it('never invites merging into a tombstone', async () => {
    stubNetwork({ related: RELATED_BODY([OPEN_RELATED], 1) })
    renderThread({ conversation: { ...CONVERSATION, merged_into_id: 'other' } })
    await waitFor(() => expect(calls.some(c => c.url.includes('/related'))).toBe(true))
    expect(screen.queryByRole('button', { name: 'Merge into this one' })).toBeNull()
  })

  it('asks the pinned endpoint for THIS conversation', async () => {
    stubNetwork({ related: RELATED_BODY([], 0) })
    renderThread()
    await waitFor(() =>
      expect(calls.some(c => c.url === `/api/email/mail/${CONVERSATION.id}/related`)).toBe(true)
    )
  })

  it('offers View only when the surface wired navigation, and opens the newest open thread', async () => {
    const onOpenConversation = vi.fn()
    stubNetwork({ related: RELATED_BODY([ARCHIVED_RELATED, OPEN_RELATED], 1) })
    renderThread({ onOpenConversation })
    fireEvent.click(await screen.findByRole('button', { name: 'View' }))
    // The newest OPEN one — never the archived row that happens to be newer.
    expect(onOpenConversation).toHaveBeenCalledWith({ id: 'r-open-1' })

    cleanup()
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    stubNetwork({ related: RELATED_BODY([OPEN_RELATED], 1) })
    renderThread() // no onOpenConversation
    expect(await screen.findByRole('button', { name: 'Merge into this one' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull()
  })
})

describe('MailThread — the merge picker', () => {
  async function openPicker(networkOpts, props = {}) {
    stubNetwork(networkOpts)
    renderThread(props)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into this one' }))
  }

  it('lists ALL related — open and archived — with honest per-row descriptions', async () => {
    await openPicker({ related: RELATED_BODY([OPEN_RELATED, ARCHIVED_RELATED], 1) })
    expect(screen.getByText('RE: Meter reading — urgent')).toBeTruthy()
    expect(screen.getByText('Flogas account setup')).toBeTruthy()
    expect(screen.getByText(/archived 12 Aug/)).toBeTruthy()
    // Nothing ticked yet → the confirm has nothing to do.
    expect(screen.getByRole('button', { name: 'Merge' })).toHaveProperty('disabled', true)
  })

  it('merges the ticked conversations into this one and celebrates with an Undo toast', async () => {
    const onThreadChanged = vi.fn()
    await openPicker({ related: RELATED_BODY([OPEN_RELATED, ARCHIVED_RELATED], 1) }, { onThreadChanged })
    fireEvent.click(screen.getByRole('checkbox', { name: /RE: Meter reading/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge 1 conversation' }))

    await screen.findByText('Merged 1 conversation into this one.')
    const merge = calls.find(c => c.method === 'POST' && c.url.includes('/merge'))
    expect(merge.url).toBe('/api/email/tickets/r-open-1/merge')
    expect(merge.body).toEqual({ into: CONVERSATION.id })
    expect(onThreadChanged).toHaveBeenCalled()
    // The picker closed; Undo is on the toast and nowhere else.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    // The related answer was re-read so the nudge tells the truth again.
    expect(calls.filter(c => c.url.includes('/related')).length).toBeGreaterThan(1)
  })

  // 🔴 A failed merge must never look merged.
  it('stops at the first failure, keeps the picker open and says how far it got', async () => {
    const onThreadChanged = vi.fn()
    await openPicker({
      related: RELATED_BODY([OPEN_RELATED, ARCHIVED_RELATED], 1),
      mergeResults: { 'r-arch-1': { success: false, error: 'That conversation is already merged' } },
    }, { onThreadChanged })
    fireEvent.click(screen.getByRole('checkbox', { name: /RE: Meter reading/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Flogas account setup/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2 conversations' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Merged 1 of 2')
    expect(alert.textContent).toContain('That conversation is already merged')
    // Still open — the failure is in front of the operator, not behind a toast.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByText(/into this one\.$/)).toBeNull()
    // What DID merge still refreshed the surface.
    expect(onThreadChanged).toHaveBeenCalled()
  })

  it('undoes a merge from the toast via DELETE, then the toast leaves', async () => {
    const onThreadChanged = vi.fn()
    await openPicker({ related: RELATED_BODY([OPEN_RELATED], 1) }, { onThreadChanged })
    fireEvent.click(screen.getByRole('checkbox', { name: /RE: Meter reading/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge 1 conversation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))

    await waitFor(() => {
      const undo = calls.find(c => c.method === 'DELETE')
      expect(undo?.url).toBe('/api/email/tickets/r-open-1/merge')
    })
    await waitFor(() => expect(screen.queryByText(/Merged 1 conversation/)).toBeNull())
    expect(onThreadChanged).toHaveBeenCalledTimes(2)
  })
})

describe('MailThread — audit M1: continuations die with the pane they started on', () => {
  // The merge/undo continuations close over the conversation they began on.
  // Switching conversations mid-flight must drop every UI write they would
  // make — a late related answer for A painted under B put A's SENDER's
  // conversations in B's merge picker, a cross-sender merge offer.
  const CONVERSATION_B = {
    ...CONVERSATION,
    id: 'b0000000-0000-4000-8000-00000000000b',
    subject: 'Sonos order',
    requester_email: 'orders@sonos.com',
    requester_name: 'Sonos',
  }

  it('a merge landing after a switch paints no toast and no stale related under the new conversation', async () => {
    // Related answers: A has one open related; B has none. The merge POST for
    // A is HELD until after the switch to B.
    let releaseMerge
    const mergeGate = new Promise(resolve => { releaseMerge = resolve })
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      calls.push({ url: u, method: init?.method || 'GET' })
      if (u.includes(`/mail/${CONVERSATION.id}/related`)) {
        return { ok: true, status: 200, json: async () => RELATED_BODY([OPEN_RELATED], 1) }
      }
      if (u.includes(`/mail/${CONVERSATION_B.id}/related`)) {
        return { ok: true, status: 200, json: async () => RELATED_BODY([], 0) }
      }
      if (u.includes('/merge')) {
        await mergeGate
        return { ok: true, status: 200, json: async () => ({ success: true }) }
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
    }))

    const view = renderThread({ conversation: CONVERSATION, conversationId: CONVERSATION.id })
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into this one' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /RE: Meter reading/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge 1 conversation' }))

    // The operator leaves for B while the POST is in flight.
    view.rerender(
      <MailThread
        hasSelection
        conversation={CONVERSATION_B}
        conversationId={CONVERSATION_B.id}
        messages={[MESSAGE]}
        onBack={() => {}}
        onSend={() => {}}
        onArchive={() => {}}
        onMarkRead={() => {}}
      />
    )
    releaseMerge()
    // Give the continuation every chance to misbehave.
    await new Promise(r => setTimeout(r, 0))
    await waitFor(() => {
      expect(screen.queryByText(/Merged\b/)).toBeNull() // no toast under B
      expect(screen.queryByText(/other open conversation/)).toBeNull() // no stale A nudge
    })
    // And B's pane never asked about A again after the switch.
    const lateARelated = calls.filter(c =>
      c.url.includes(`/mail/${CONVERSATION.id}/related`)).length
    expect(lateARelated).toBeLessThanOrEqual(1) // only the initial load, never the continuation's re-read
  })
})
