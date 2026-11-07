// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { RECIPES } from '@shared/pipelines/recipes.js'
import BoardList, { followupChip, boardStatus } from './BoardList.jsx'
import { NO_WHATSAPP_NOTICE } from './NoWhatsappNotice'

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
  it('New board is a real link, not a button inside a link', async () => {
    stub({ boards: [], can_edit: true })
    const { container } = render(<BoardList locationId="loc1" />)
    await screen.findByText('No offer boards yet.')
    expect(container.querySelector('a button')).toBeNull()
    expect(screen.getByRole('link', { name: 'New board' })).toBeTruthy()
  })
  // RAILS.3 — Live says when WhatsApp has paused or rejected the template.
  it('healthTurnsLiveIntoWhatWhatsAppDid', () => {
    const chip = (rows) => followupChip(rows.map((r) => ({ stage_id: 's', ...r })), 's')
    const paused = chip([{ state: 'live', health: 'template_paused' }])
    expect(paused.label).toBe('Paused by WhatsApp')
    expect(paused.tone).toContain('text-amber-700')
    const rejected = chip([{ state: 'live', health: 'template_rejected' }])
    expect(rejected.label).toBe('Rejected by WhatsApp')
    expect(rejected.tone).toContain('text-red-700')
    const seq = chip([{ state: 'live', health: 'sequence_paused' }])
    expect(seq.label).toBe('Paused')
    expect(seq.tone).toContain('text-amber-700')
    expect(chip([{ state: 'awaiting_approval', health: 'template_rejected' }]).label).toBe('Rejected by WhatsApp')
    expect(chip([{ state: 'awaiting_approval', health: 'template_paused' }]).label).toBe('Waiting for Meta')
    expect(chip([{ state: 'live', health: null }]).label).toBe('Live')
    expect(chip([{ state: 'off', health: 'template_paused' }]).label).toBe('Off')
  })
  it('theWorstHealthWinsAStagesChip', () => {
    const chip = (rows) => followupChip(rows.map((r) => ({ stage_id: 's', ...r })), 's')
    expect(chip([{ state: 'live', health: null }, { state: 'live', health: 'template_paused' }]).label).toBe('Paused by WhatsApp')
    expect(chip([{ state: 'live', health: 'template_paused' }, { state: 'awaiting_approval', health: 'template_rejected' }]).label).toBe('Rejected by WhatsApp')
    expect(chip([{ state: 'off', health: 'template_rejected' }, { state: 'live', health: null }]).label).toBe('Live')
  })
  it('listShowsHealthChips', async () => {
    const boards = [{ ...BOARDS[0], followups: [
      { id: 'f1', stage_id: 's1', state: 'live', health: 'template_paused' },
      { id: 'f2', stage_id: 's2', state: 'live', health: 'template_rejected' },
      { id: 'f3', stage_id: 's3', state: 'live', health: 'sequence_paused' },
      { id: 'f4', stage_id: 's4', state: 'off', health: 'template_paused' },
    ] }]
    stub({ boards, can_edit: true })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Summer offer')
    expect(screen.getByText('Paused by WhatsApp').className).toContain('text-amber-700')
    expect(screen.getByText('Rejected by WhatsApp').className).toContain('text-red-700')
    expect(screen.getByText('Paused').className).toContain('text-amber-700')
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.queryByText('Live')).toBeNull()
  })
  it('an unknown follow-up state ranks below a known one', () => {
    const chip = followupChip([{ stage_id: 's', state: 'mystery' }, { stage_id: 's', state: 'off' }], 's')
    expect(chip.label).toBe('Off')
    expect(followupChip([{ stage_id: 's', state: 'mystery' }], 's').label).toBe('None')
  })

  // PIPEBUILD.5p — built-in boards are live and send; their follow-ups are
  // sequences, read from stage-coverage, never pipeline_stage_followups.
  function stubBoth(pipelinesData, coverage) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/stage-coverage')) {
        if (coverage === 'fail') return { ok: false, json: async () => ({ success: false }) }
        return { ok: true, json: async () => ({ success: true, data: { boards: coverage } }) }
      }
      return { ok: true, json: async () => ({ success: true, data: pipelinesData }) }
    }))
  }
  const BUILT = {
    id: 'b9', key: 'acquisition', name: 'Acquisition', board_type: null, enabled: true, baseline_at: null, priority: 0,
    stages: [stage('k1', 'New Leads', 1), stage('k2', '1st Class', 2), stage('k3', 'Converted', 3)], followups: [],
  }
  // RAILS.4 — a held first placement says so, on the studio's own clock.
  it('pendingBoardsSayWhenTheirFirstPlacementIsAndWhenItIsHeld', () => {
    const offer = { board_type: 'offer', enabled: true, baseline_at: null }
    const run = { status: 'partial', errors: 3, started_at: '2026-11-06T12:00:00Z', finished_at: null }
    expect(boardStatus({ ...offer, baseline_pending: { cadence: 'nightly', last_run: null, held: false } }))
      .toBe('On — first placement tonight, no messages')
    expect(boardStatus({ ...offer, module: 'offer_un1t', baseline_pending: { cadence: 'hourly', last_run: null, held: false } }))
      .toBe('On — first placement within the hour, no messages')
    expect(boardStatus({ ...offer, baseline_pending: { cadence: 'nightly', last_run: run, held: true } }))
      .toBe('On — first placement held: 3 people could not be checked (6 Nov)')
    // An unreadable runs read is never "held".
    expect(boardStatus({ ...offer, baseline_pending: { cadence: 'hourly', last_run: null, held: false, unread: true } }))
      .toBe('On — first placement within the hour, no messages')
    // A run with no count that failed outright never reads "0 people".
    expect(boardStatus({ ...offer, baseline_pending: { cadence: 'nightly', last_run: { ...run, status: 'failed', errors: 0 }, held: true } }))
      .toBe('On — first placement held: the last run could not complete (6 Nov)')
    // A run still in flight is pending, not held.
    expect(boardStatus({ ...offer, baseline_pending: { cadence: 'nightly', last_run: { ...run, status: 'running', errors: 0 }, held: false } }))
      .toBe('On — first placement tonight, no messages')
    // A board from before RAILS.4's field: by its module.
    expect(boardStatus({ ...offer, module: 'offer_un1t' })).toBe('On — first placement within the hour, no messages')
  })
  it('anUnreadableHealthReadSaysSoOnTheBoardCard', async () => {
    stub({ boards: [{ ...BOARDS[0], health_unread: true }], can_edit: true })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Summer offer')
    const line = screen.getByText('Could not check whether WhatsApp has paused or rejected a follow-up just now. Reload the page to try again.')
    expect(line.className).toContain('text-amber-700')
  })
  it('a built-in board with no baseline reads On, never "first placement tonight"', async () => {
    stubBoth({ boards: [BUILT], can_edit: false }, [])
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Acquisition')
    expect(screen.getByText('On')).toBeTruthy()
    expect(screen.queryByText(/first placement tonight/)).toBeNull()
  })
  it('a built-in board shows its sequences per stage from coverage', async () => {
    stubBoth({ boards: [BUILT], can_edit: false }, [{
      id: 'b9', stages: [
        { id: 'k1', name: 'New Leads', followups: [{ id: 'q1' }, { id: 'q2' }] },
        { id: 'k2', name: '1st Class', followups: [{ id: 'q3' }] },
        { id: 'k3', name: 'Converted', followups: [] },
      ],
    }])
    render(<BoardList locationId="loc1" />)
    expect((await screen.findByText('2 sequences')).className).toContain('text-green-700')
    expect(screen.getByText('1 sequence')).toBeTruthy()
    expect(screen.getAllByText('None')).toHaveLength(1)
  })
  it('a failed coverage read shows no chip on a built-in board, never "None"', async () => {
    stubBoth({ boards: [BUILT], can_edit: false }, 'fail')
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Acquisition')
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('None')).toBeNull()
    expect(screen.queryByText(/sequence/)).toBeNull()
  })

  it('recipeCardsShowWithNoOfferBoardsAndCanEdit', async () => {
    stub({ boards: [BOARDS[1]], can_edit: true, has_whatsapp: true })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Start from a recipe')
    for (const r of Object.values(RECIPES)) {
      expect(screen.getByText(r.name)).toBeTruthy()
      const links = screen.getAllByRole('link', { name: 'Set up' }).map((a) => a.getAttribute('href'))
      expect(links).toContain(`/settings/pipelines/new?recipe=${r.key}`)
    }
    expect(screen.queryByText(/no WhatsApp number switched on/)).toBeNull()
  })

  it('recipeCardsHiddenWithAnOfferBoardOrWithoutCanEdit', async () => {
    stub({ boards: BOARDS, can_edit: true })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Summer offer')
    expect(screen.queryByText('Start from a recipe')).toBeNull()
    cleanup()
    stub({ boards: [BOARDS[1]], can_edit: false })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Cold calls')
    expect(screen.queryByText('Start from a recipe')).toBeNull()
  })

  it('recipeCardsCarryTheWhatsAppNoticeWhenNoNumber', async () => {
    stub({ boards: [], can_edit: true, has_whatsapp: false })
    render(<BoardList locationId="loc1" />)
    await screen.findByText('Start from a recipe')
    expect(screen.getAllByText(NO_WHATSAPP_NOTICE)).toHaveLength(Object.keys(RECIPES).length)
  })
})
