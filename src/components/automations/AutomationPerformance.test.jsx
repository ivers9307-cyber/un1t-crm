// @vitest-environment jsdom
//
// SEQEXIT.1 — exit reasons are operator-facing now.
//
// The panel rendered the raw enum with underscores swapped for spaces
// ("left audience (3)"), which reads as a typo rather than an outcome.
// The stats route groups by exit_reason, so the labelling belongs here,
// in the one place that renders them — not in a second parallel map.
//
// SEQGAPS.1 Task B — the roster gains an Exit control beside Resume. It is
// irreversible and there is no re-entry path, so it confirms first and names
// the contact; and because the route compare-and-sets, a 409 is a benign
// "someone already did this", not an error state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import AutomationPerformance, { exitReasonLabel } from './AutomationPerformance.jsx'

describe('exitReasonLabel', () => {
  it('names the SEQEXIT.1 audience exit in operator language', () => {
    expect(exitReasonLabel('left_audience')).toBe('No longer matched the audience')
  })

  it('names the SEQGAPS.1 manual exit in the same map — not a second one', () => {
    expect(exitReasonLabel('manual_exit')).toBe('Removed by staff')
  })

  it('labels the reasons the engine already writes', () => {
    expect(exitReasonLabel('goal_met')).toBe('Goal met')
    expect(exitReasonLabel('unsubscribed')).toBe('Unsubscribed')
    expect(exitReasonLabel('unspecified')).toBe('Unspecified')
  })

  it('falls back to the de-underscored reason for anything unmapped', () => {
    // Historical/free-text reasons must still render legibly — exit_reason
    // is free text, so the map can never be exhaustive.
    expect(exitReasonLabel('some_future_reason')).toBe('some future reason')
    expect(exitReasonLabel('')).toBe('Unspecified')
    expect(exitReasonLabel(null)).toBe('Unspecified')
  })
})

// ── The Exit control ─────────────────────────────────────────────

const STATS = {
  success: true,
  data: { enrolments: { total: 3, active: 1, completed: 1, exited: 1, paused: 1 }, exit_reasons: {}, per_step: {} },
}
const run = (over = {}) => ({
  id: 'enr-active', contact_id: 'c1', contact_name: 'Aoife Byrne',
  source_type: 'manual', enrolled_at: '2026-08-01T09:00:00.000Z',
  state: 'active', outcome: '', stepLabel: 'Step 2', next_step_at: null, ...over,
})

let runs
let exitCalls
let exitStatus

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (String(url).endsWith('/stats')) return jsonRes(STATS)
    if (String(url).endsWith('/runs')) return jsonRes({ success: true, data: { runs } })
    if (String(url).endsWith('/exit')) {
      exitCalls.push({ url: String(url), method: opts?.method })
      if (exitStatus === 200) return jsonRes({ success: true, data: { id: 'enr-active', status: 'exited' } }, 200)
      if (exitStatus === 409) {
        return jsonRes({ success: false, error: 'This contact has already left this sequence (exited)' }, 409)
      }
      // A real failure with no parseable message — the fallback copy shows.
      return jsonRes({}, exitStatus)
    }
    return jsonRes({ success: true, data: {} })
  }))
}
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

beforeEach(() => {
  runs = [run()]
  exitCalls = []
  exitStatus = 200
  vi.stubGlobal('confirm', vi.fn(() => true))
  stubFetch()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderPanel = async () => {
  render(<AutomationPerformance sequenceId="seq-1" steps={[]} />)
  await screen.findByText('Aoife Byrne')
}

describe('AutomationPerformance — Exit control', () => {
  it('offers Exit on an active row', async () => {
    await renderPanel()
    expect(screen.getByRole('button', { name: /^Exit$/ })).toBeTruthy()
  })

  it('offers Exit alongside Resume on a paused row', async () => {
    runs = [run({ state: 'paused', outcome: 'Paused: send failed' })]
    await renderPanel()
    expect(screen.getByRole('button', { name: /Resume/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Exit$/ })).toBeTruthy()
  })

  it('offers NO Exit on a completed or already-exited row', async () => {
    runs = [
      run({ id: 'e-done', contact_name: 'Aoife Byrne', state: 'completed', outcome: 'Completed' }),
      run({ id: 'e-gone', contact_name: 'Cian Walsh', state: 'exited', outcome: 'Exited' }),
    ]
    await renderPanel()
    expect(screen.queryByRole('button', { name: /^Exit$/ })).toBeNull()
  })

  it('confirms first and NAMES the contact — the exit is irreversible', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Exit$/ }))
    expect(globalThis.confirm).toHaveBeenCalledTimes(1)
    expect(globalThis.confirm.mock.calls[0][0]).toContain('Aoife Byrne')
  })

  it('does NOT call the route when the operator cancels the confirm', async () => {
    globalThis.confirm.mockReturnValue(false)
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Exit$/ }))
    await waitFor(() => expect(exitCalls).toEqual([]))
  })

  it('POSTs the exit route for that enrolment once confirmed', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Exit$/ }))
    await waitFor(() => expect(exitCalls.length).toBe(1))
    expect(exitCalls[0].method).toBe('POST')
    expect(exitCalls[0].url).toBe('/api/sequences/seq-1/enrollments/enr-active/exit')
  })

  it('surfaces a 409 as a plain "already left this sequence" note, not an error state', async () => {
    exitStatus = 409
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Exit$/ }))
    const note = await screen.findByText(/already left this sequence/i)
    expect(note).toBeTruthy()
    // Not the red error treatment reserved for real failures.
    expect(note.className).not.toMatch(/red/)
  })

  it('shows an error when the route genuinely fails', async () => {
    exitStatus = 500
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Exit$/ }))
    expect(await screen.findByText(/Exit failed/i)).toBeTruthy()
  })

  it('every roster control is type="button" — the panel sits inside page forms', async () => {
    runs = [run({ state: 'paused', outcome: 'Paused: send failed' })]
    await renderPanel()
    for (const b of document.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button')
  })
})
