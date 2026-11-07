// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import BoardLaunchPanel, { TURN_ON_CONFIRM } from './BoardLaunchPanel.jsx'
import BoardWizard from './BoardWizard.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = (data) => ({ ok: true, json: async () => ({ success: true, data }) })
const board = { id: 'b1', name: 'Spring', enabled: false, stages: [{ id: 's1', name: '1st Class', stage_role: 'first_class' }] }
const live = [{ stage_id: 's1', state: 'live' }]
const DRY = { entering: 4, byStage: [{ slug: 'o_x_new', name: 'New Leads', count: 4 }], overlap: [{ boardKey: 'trial39', boardName: '€39 Trial', count: 3 }], contactsSeen: 9, errors: 0 }

describe('BoardLaunchPanel', () => {
  it('turnOnDisabledUntilDryRun', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(DRY))
    vi.stubGlobal('fetch', fetchMock)
    render(<BoardLaunchPanel board={board} followups={live} />)
    expect(screen.getByRole('button', { name: 'Turn on' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Check who would enter' }))
    await screen.findByText(/would enter this board/)
    expect(screen.getByRole('button', { name: 'Turn on' }).disabled).toBe(false)
  })

  it('stays disabled with no live or waiting follow-up, even after a dry run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(DRY)))
    render(<BoardLaunchPanel board={board} followups={[{ stage_id: 's1', state: 'rejected' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check who would enter' }))
    await screen.findByText(/would enter this board/)
    expect(screen.getByRole('button', { name: 'Turn on' }).disabled).toBe(true)
  })

  it('dryRunShowsOverlap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(DRY)))
    render(<BoardLaunchPanel board={board} followups={live} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check who would enter' }))
    expect(await screen.findByText('3 people now on the €39 Trial board would move here')).toBeTruthy()
    expect(screen.getByText('New Leads: 4')).toBeTruthy()
  })

  it('turn on asks first with the exact text, then enables', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(DRY))
      .mockResolvedValueOnce(ok({ board: { ...board, enabled: true } }))
    vi.stubGlobal('fetch', fetchMock)
    const onEnabled = vi.fn()
    render(<BoardLaunchPanel board={board} followups={live} onEnabled={onEnabled} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check who would enter' }))
    await screen.findByText(/would enter this board/)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(screen.getByText(TURN_ON_CONFIRM)).toBeTruthy()
    expect(TURN_ON_CONFIRM).toBe('People who already qualify are placed tonight without any messages. From tomorrow, new people get the follow-ups.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn on' }).pop())
    await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[1][0]).toBe('/api/pipelines/b1/enable')
  })

  it('failedInstallOffersRetry', () => {
    const onRetry = vi.fn()
    render(<BoardLaunchPanel board={board} followups={[]} issues={[{ key: 'book', label: 'Book the first class', error: 'name clash' }]} onRetry={onRetry} />)
    expect(screen.getByText(/name clash/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledWith('book')
  })
})

describe('BoardWizard finish', () => {
  async function toReview() {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ options: [{ value: 'RESET39', label: '14 Day Reset' }] })))
    const utils = render(<BoardWizard locationId="loc1" studioName="UN1T Stillorgan" canEdit membershipSource="glofox" />)
    const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: /Paid trial/ })); next()
    next()
    fireEvent.change(screen.getByLabelText(/Board name/), { target: { value: 'Spring reset' } }); next()
    fireEvent.click(await screen.findByLabelText(/14 Day Reset/)); next()
    next(); next(); next()
    return utils
  }

  const createdBoard = {
    id: 'b1', name: 'Spring reset', enabled: false,
    stages: [
      { id: 'st-new', name: 'New Leads', stage_role: 'new' },
      { id: 'st-fc', name: '1st Class', stage_role: 'first_class' },
      { id: 'st-cp', name: 'Day 7', stage_role: 'checkpoint', role_config: { day: 7 } },
      { id: 'st-done', name: 'Trial Done', stage_role: 'done' },
      { id: 'st-conv', name: 'Converted', stage_role: 'converted' },
    ],
  }

  it('createThenInstallsSequentially', async () => {
    await toReview()
    const calls = []
    let release
    const gate = new Promise((r) => { release = r })
    const fetchMock = vi.fn(async (url, init) => {
      calls.push(`${init?.method} ${url}`)
      if (url === '/api/locations/loc1/pipelines') return ok({ board: createdBoard })
      if (url.includes('/followups/')) {
        if (calls.filter((c) => c.includes('/followups/')).length === 1) await gate
        return ok({ followup: { state: 'live', stage_id: url.split('/').pop() } })
      }
      return ok({})
    })
    vi.stubGlobal('fetch', fetchMock)
    fireEvent.click(screen.getByRole('button', { name: 'Create board (switched off)' }))
    await waitFor(() => expect(calls.filter((c) => c.includes('/followups/')).length).toBe(1))
    // the second install waits for the first
    await Promise.resolve()
    expect(calls.filter((c) => c.includes('/followups/')).length).toBe(1)
    release()
    await waitFor(() => expect(calls.filter((c) => c.includes('/followups/')).length).toBe(4))
    const installs = calls.filter((c) => c.includes('/followups/'))
    expect(installs[0]).toBe('PUT /api/pipelines/b1/followups/st-new')
    expect(calls[0]).toBe('POST /api/locations/loc1/pipelines')
    expect(await screen.findByRole('button', { name: 'Check who would enter' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the board' }).getAttribute('href')).toBe('/settings/pipelines/b1')
  })

  it('doubleClickCreatesOnce', async () => {
    await toReview()
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/locations/loc1/pipelines') return ok({ board: { ...createdBoard, stages: [] } })
      return ok({})
    })
    vi.stubGlobal('fetch', fetchMock)
    const btn = screen.getByRole('button', { name: 'Create board (switched off)' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    await screen.findByRole('button', { name: 'Check who would enter' })
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/locations/loc1/pipelines').length).toBe(1)
  })

  it('a rejected install does not stop the rest, and Try again re-installs', async () => {
    await toReview()
    let n = 0
    let failSecond = true
    const fetchMock = vi.fn(async (url, init) => {
      if (url === '/api/locations/loc1/pipelines') return ok({ board: createdBoard })
      if (url.includes('/followups/')) {
        n += 1
        if (n === 2 && failSecond) throw new Error('network')
        return ok({ followup: { state: 'live', stage_id: url.split('/').pop() } })
      }
      return ok({})
    })
    vi.stubGlobal('fetch', fetchMock)
    fireEvent.click(screen.getByRole('button', { name: 'Create board (switched off)' }))
    const retryBtn = await screen.findByRole('button', { name: 'Try again' })
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u.includes('/followups/')).length).toBe(4))
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBe(1)
    failSecond = false
    await waitFor(() => expect(retryBtn.disabled).toBe(false))
    fireEvent.click(retryBtn)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull())
    const last = fetchMock.mock.calls.filter(([u]) => u.includes('/followups/')).pop()
    expect(JSON.parse(last[1].body).action).toBe('install')
  })
})
