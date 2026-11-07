// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import BoardList from './BoardList.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const stage = (id, name, n) => ({ id, slug: id, name, display_order: n, deal_count: 0 })
const BOARDS = [
  {
    id: 'b1', key: 'o_summer', name: 'Summer offer', board_type: 'offer', enabled: true, baseline_at: null, priority: 3,
    stages: [stage('s1', 'Interested', 1), stage('s2', 'Booked', 2), stage('s3', 'Lapsed', 3), stage('s4', 'Done', 4)],
    followups: [
      { id: 'f1', stage_id: 's1', state: 'live' },
      { id: 'f2', stage_id: 's2', state: 'awaiting_approval' },
      { id: 'f3', stage_id: 's3', state: 'rejected' },
    ],
  },
  {
    id: 'b2', key: 'cold', name: 'Cold calls', board_type: null, enabled: true, baseline_at: '2026-11-01T00:00:00Z', priority: 0,
    stages: [stage('s5', 'New', 1)], followups: [],
  },
]
function stub(data) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) }))
}

describe('BoardList', () => {
  it('listShowsStatusAndChips', async () => {
    stub({ boards: BOARDS, can_edit: true })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Summer offer')
    expect(screen.getByText('On — first placement tonight, no messages')).toBeTruthy()
    expect(screen.getByText('Live').className).toContain('text-green-700')
    expect(screen.getByText('Waiting for Meta').className).toContain('text-amber-700')
    expect(screen.getByText('Rejected').className).toContain('text-red-700')
    expect(screen.getAllByText('None').length).toBeGreaterThan(0)
    expect(screen.getByText('Offer')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/settings/pipelines/b1')
    expect(screen.getByRole('link', { name: 'New board' }).getAttribute('href')).toBe('/settings/pipelines/new')
  })
  it('newBoardHiddenWithoutCanEdit', async () => {
    stub({ boards: BOARDS, can_edit: false })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Summer offer')
    expect(screen.queryByText('New board')).toBeNull()
  })
  it('builtInBoardsReadOnly', async () => {
    stub({ boards: BOARDS, can_edit: true })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Cold calls')
    expect(screen.getByText('Built in')).toBeTruthy()
    expect(screen.getByText('Built in code — read only')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1)
  })
  it('shows the empty state', async () => {
    stub({ boards: [], can_edit: false })
    render(<BoardList locationId="loc1" />)
    await waitFor(() => expect(screen.getByText('No offer boards yet.')).toBeTruthy())
  })
})
