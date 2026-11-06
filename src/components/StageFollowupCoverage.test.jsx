// @vitest-environment jsdom
// PIPEBUILD.1f — the coverage strip above the pipeline board.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import StageFollowupCoverage from './StageFollowupCoverage'

const LOC = 'loc-1'
const board = {
  id: 'p1', key: 'funnel', name: 'Funnel',
  stages: [
    { id: 's1', slug: 'new_lead', name: 'New lead', isPile: false, followups: [{ id: 'q1', name: 'Welcome', trigger: 'x' }, { id: 'q2', name: 'Nudge', trigger: 'y' }] },
    { id: 's2', slug: 'first_class', name: 'First class', isPile: false, followups: [] },
    { id: 's3', slug: 'dormant', name: 'Dormant', isPile: true, followups: [] },
  ],
}
const other = { id: 'p2', key: 'other', name: 'Other', stages: [{ id: 'x1', slug: 'x', name: 'Elsewhere', isPile: false, followups: [] }] }

function mockFetch(impl) {
  global.fetch = vi.fn(impl)
}
const ok = () => mockFetch(async () => ({ ok: true, json: async () => ({ success: true, data: { boards: [other, board] } }) }))

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('StageFollowupCoverage', () => {
  it('showsCoveredAndMissingChips', async () => {
    ok()
    render(<StageFollowupCoverage locationId={LOC} pipelineId="p1" canEditSequences />)
    const covered = await screen.findByText('New lead: 2 follow-ups')
    expect(covered.className).toMatch(/bg-emerald-500\/10/)
    expect(covered.className).toMatch(/text-emerald-700/)
    expect(covered.getAttribute('title')).toBe('Welcome, Nudge')
    const missing = screen.getByText('First class: no follow-up')
    expect(missing.className).toMatch(/bg-red-500\/10/)
    expect(missing.className).toMatch(/text-red-700/)
    expect(screen.getByText('Follow-ups by stage')).toBeTruthy()
    expect(global.fetch).toHaveBeenCalledWith(`/api/locations/${LOC}/stage-coverage`, expect.anything())
  })

  it('hidesPiles', async () => {
    ok()
    render(<StageFollowupCoverage locationId={LOC} pipelineId="p1" canEditSequences />)
    await screen.findByText('New lead: 2 follow-ups')
    expect(screen.queryByText(/Dormant/)).toBeNull()
    expect(screen.queryByText(/Elsewhere/)).toBeNull()
  })

  it('rendersNothingOnFetchError', async () => {
    mockFetch(async () => ({ ok: false, status: 500, json: async () => ({ success: false }) }))
    const { container } = render(<StageFollowupCoverage locationId={LOC} pipelineId="p1" canEditSequences />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await waitFor(() => expect(console.error).toHaveBeenCalledTimes(1))
    expect(container.innerHTML).toBe('')
  })

  it('buildLinkOnlyForEditors', async () => {
    ok()
    const { unmount } = render(<StageFollowupCoverage locationId={LOC} pipelineId="p1" canEditSequences />)
    const link = await screen.findByText('Build one')
    expect(link.closest('a').getAttribute('href')).toBe('/automations')
    unmount()
    render(<StageFollowupCoverage locationId={LOC} pipelineId="p1" canEditSequences={false} />)
    await screen.findByText('First class: no follow-up')
    expect(screen.queryByText('Build one')).toBeNull()
  })
})
