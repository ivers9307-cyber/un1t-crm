// @vitest-environment jsdom
//
// CAMPDEL.1 — the editor's delete must not be the way round the delete guard.
//
// CAMPHIST.1 already learned this about SAVE: CampaignEditor persists by
// writing the `campaigns` row DIRECTLY from the browser Supabase client, so the
// 409 on PUT /api/campaigns/[id] never runs, and campaigns_location_scoped
// (mig 014) is `FOR ALL ... USING auth_is_in_location(location_id)` with no
// status predicate, so the database allows it too. `handleDelete` had exactly
// the same shape: a `db.from('campaigns').delete()` whose only check was a
// hard-coded ['queued','sending'] refusal.
//
// It cannot simply call the API route instead: DELETE /api/campaigns/[id]
// authenticates with `authenticateApiKey`, which is Bearer-only, so an
// operator's session cookie would just get a 401.
//
// So the editor re-reads the status from the database immediately before
// deleting and applies the SAME predicate the route does. That also closes a
// race the local state cannot see: an operator sitting on a 'scheduled'
// campaign while the run-campaigns cron sends it still holds `campaignStatus
// === 'scheduled'` in React, and the old code would have deleted a campaign
// that had just gone out to thousands of people.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }))
vi.mock('./AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))

// What the pre-delete re-read of `campaigns.status` returns.
let freshStatus = { data: null, error: null }
const deleteCalls = []

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => freshStatus }) }),
      update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'camp-1' }, error: null }) }) }) }),
      delete: () => ({ eq: async (col, val) => { deleteCalls.push({ col, val }); return { error: null } } }),
    }),
  }),
}))

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

beforeEach(() => {
  vi.clearAllMocks()
  deleteCalls.length = 0
  freshStatus = { data: null, error: null }
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, audience_count: 10 }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CampaignEditor delete guard', () => {
  it('deletes a draft whose stored status is still a draft', async () => {
    freshStatus = { data: { status: 'draft' }, error: null }
    renderEditor()
    fireEvent.click(screen.getByTitle('Delete this draft'))
    await waitFor(() => expect(deleteCalls).toHaveLength(1))
    expect(push).toHaveBeenCalledWith('/communications/sent')
  })

  // The race the local React state cannot see.
  it('refuses when the campaign has been sent since the editor loaded', async () => {
    freshStatus = { data: { status: 'sent' }, error: null }
    renderEditor({ status: 'scheduled' })
    fireEvent.click(screen.getByTestId('campaign-delete'))
    await waitFor(() => expect(screen.getByText(/cannot be deleted/i)).toBeTruthy())
    expect(deleteCalls).toHaveLength(0)
  })

  it('never issues the delete for a stored status past scheduled', async () => {
    for (const status of ['queued', 'sending', 'sent', 'cancelled', 'failed']) {
      cleanup()
      deleteCalls.length = 0
      freshStatus = { data: { status }, error: null }
      renderEditor({ status: 'draft' })
      fireEvent.click(screen.getByTestId('campaign-delete'))
      await waitFor(() => expect(deleteCalls).toHaveLength(0))
    }
  })

  it('falls back to the loaded status when the re-read returns nothing', async () => {
    freshStatus = { data: null, error: null }
    renderEditor({ status: 'draft' })
    fireEvent.click(screen.getByTitle('Delete this draft'))
    await waitFor(() => expect(deleteCalls).toHaveLength(1))
  })
})
