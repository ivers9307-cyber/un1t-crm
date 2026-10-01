// @vitest-environment jsdom
//
// CAMPDEL.1 — the editor's delete must not be the way round the delete guard.
//
// The editor used to delete with `db.from('campaigns').delete()` straight from
// the browser, after re-reading the status itself, because the n8n route
// (DELETE /api/campaigns/[id]) is Bearer-only. MEMBERWRITESWEEP.1e moved it to
// DELETE /api/communications/campaigns/[id] (session auth, email at the
// campaign's studio), which re-reads the status on the SERVER and applies the
// same predicate: the race the local React state cannot see (an operator
// sitting on a 'scheduled' campaign while the run-campaigns cron sends it)
// is now the route's 409, shown in the editor. Mig 684 closes `campaigns` to
// every client session, so there is no browser path left to guard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }))
vi.mock('./AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))

import CampaignEditor from './CampaignEditor.jsx'

const BASE = {
  id: 'camp-1',
  name: 'Weekend offer',
  subject: 'Last chance',
  status: 'draft',
  location_id: 'loc-1',
  html_content: '<html><body>hi</body></html>',
  audience_filter: { logic: 'and', filters: [] },
}

const renderEditor = (overrides = {}) =>
  render(<CampaignEditor campaign={{ ...BASE, ...overrides }} locationId="loc-1" userId="user-1" />)

// What DELETE /api/communications/campaigns/camp-1 answers.
let deleteAnswer
const deleteCalls = () => fetch.mock.calls.filter(([url, init]) =>
  url === '/api/communications/campaigns/camp-1' && init?.method === 'DELETE')

beforeEach(() => {
  vi.clearAllMocks()
  deleteAnswer = { status: 200, body: { success: true } }
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    if (init.method === 'DELETE') {
      return { ok: deleteAnswer.status < 400, status: deleteAnswer.status, json: async () => deleteAnswer.body }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, audience_count: 10 }) }
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CampaignEditor delete guard', () => {
  it('deletes a draft through the route and lands on the sends list', async () => {
    renderEditor()
    fireEvent.click(screen.getByTitle('Delete this draft'))
    await waitFor(() => expect(deleteCalls()).toHaveLength(1))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/communications/sent'))
  })

  // The race the local React state cannot see: the route re-reads and refuses.
  it('shows the route\'s refusal when the campaign has been sent since the editor loaded, and adopts the real status', async () => {
    deleteAnswer = {
      status: 409,
      body: { success: false, error: 'This campaign is sent, so it cannot be deleted. Its recipients, opens and clicks are the record of what was actually sent, and deleting it would take them with it.', data: { status: 'sent' } },
    }
    renderEditor({ status: 'scheduled' })
    fireEvent.click(screen.getByTestId('campaign-delete'))
    await screen.findByText(/cannot be deleted/i)
    expect(push).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('campaign-status-pill').textContent).toMatch(/sent/i))
  })

  it('shows the sending text the route returns for a queued or sending campaign', async () => {
    deleteAnswer = { status: 409, body: { success: false, error: 'This campaign is sending. Cancel the send first, then delete.', data: { status: 'sending' } } }
    renderEditor()
    fireEvent.click(screen.getByTestId('campaign-delete'))
    await screen.findByText('This campaign is sending. Cancel the send first, then delete.')
    expect(push).not.toHaveBeenCalled()
  })

  it('asks first, and deletes nothing when declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    renderEditor()
    fireEvent.click(screen.getByTestId('campaign-delete'))
    await Promise.resolve()
    expect(deleteCalls()).toHaveLength(0)
  })
})
