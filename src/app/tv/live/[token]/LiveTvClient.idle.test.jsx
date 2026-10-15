// @vitest-environment jsdom
//
// TVSCENE.1 — the scene layer must hand the screen to the live tiles the
// instant a band connects: same component, same render pass, no URL change,
// no second page. That is the reason the idle scenes live INSIDE the board
// rather than in a separate app, so it is the guarantee this file exists for.
//
// The board polls with its own self-scheduling setTimeout, so the second
// payload cannot be delivered by re-rendering with the same props: these tests
// swap what fetch returns and move the fake clock past the next poll. Every
// clock move is inside act() (tests/fake-timer-act.test.js).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'

// next/font only runs under the Next compiler.
vi.mock('@/fonts/repset', () => ({
  repsetDisplay: { style: { fontFamily: 'sans-serif' }, variable: 'v-display' },
  repsetBody: { style: { fontFamily: 'sans-serif' }, variable: 'v-body' },
  repsetMono: { style: { fontFamily: 'monospace' }, variable: 'v-mono' },
}))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn(() => null) }))

import { SCENE_DWELL_MS } from '@/lib/tv-scenes'
import { ACTIVE_POLL_MS } from '@/lib/live-poll'
import LiveTvClient from './LiveTvClient.jsx'

const ENDPOINT = '/api/public/tv-live/tok-1'

const BASE = {
  ok: true,
  server_time: '2026-10-16T10:00:00Z',
  timezone: 'Europe/Dublin',
  location: { id: 'loc-1', name: 'UN1T Stillorgan' },
  bridge: { online: true },
  available_straps: [],
  timer: null,
  current_class: null,
}

const IDLE = {
  ...BASE,
  sessions: [],
  idle: {
    up_next: [{ starts_at: '2026-10-16T11:00:00Z', starts_at_label: '12:00', class_name: 'BU1LD — Strength', program: null }],
    earned: [{ display_name: 'Saoirse M.', achievement: '50 classes', tier: 4, earned_at: '2026-10-15T18:00:00Z' }],
    operator: null,
  },
}

// Exactly the tile shape live-board.js emits. A live payload carries no `idle`
// block: that is built only when no session is open.
const LIVE = {
  ...BASE,
  sessions: [{
    id: 's1',
    displayName: 'Strap 49931',
    currentBpm: 150,
    currentZone: { id: 4, label: 'Z4', color: '#E8913C' },
    zonesSeconds: { 1: 0, 2: 0, 3: 0, 4: 60, 5: 0 },
    effortPoints: 12,
    peakBpm: 161,
    avgBpm: 148,
    startedAt: '2026-10-16T09:55:00Z',
    stale: false,
  }],
}

function serve(payload) {
  global.fetch = vi.fn(() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve(payload),
  }))
}

// Move the fake clock, inside act so React renders before the next read.
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
// Past the next poll, whatever the cadence rounding.
const nextPoll = () => advance(ACTIVE_POLL_MS + 50)

function mount() {
  const view = render(<LiveTvClient endpoint={ENDPOINT} device={null} />)
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  // 11:00 Dublin: daytime, so an idle board polls at the active cadence
  // (nextPollDelay backs off only 22:00-06:00).
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete global.fetch
})

describe('idle stage and live tiles', () => {
  it('shows a scene while no band is connected', async () => {
    serve(IDLE)
    mount()
    await advance(0)

    expect(screen.getByText('BU1LD — Strength')).toBeTruthy()
    expect(screen.queryByText('Waiting for class to start')).toBeNull()
  })

  it('yields the screen to the tiles the moment a session appears', async () => {
    serve(IDLE)
    const { container } = mount()
    await advance(0)
    expect(screen.getByText('BU1LD — Strength')).toBeTruthy()

    const main = container.querySelector('main')
    const href = window.location.href

    // Mid-dwell: the scene has 26s left and must not get to finish them.
    serve(LIVE)
    await nextPoll()

    expect(screen.getByText('Strap 49931')).toBeTruthy()
    expect(screen.queryByText('BU1LD — Strength')).toBeNull()
    expect(screen.queryByText('Up next')).toBeNull()
    // Same component instance and same page: nothing remounted, no navigation,
    // and the only thing fetched was the board's own endpoint.
    expect(container.querySelector('main')).toBe(main)
    expect(window.location.href).toBe(href)
    expect(global.fetch.mock.calls.every(([url]) => url === ENDPOINT)).toBe(true)
  })

  it('yields from the Earned scene too, whichever scene was up', async () => {
    serve(IDLE)
    mount()
    await advance(0)
    await advance(SCENE_DWELL_MS)
    expect(screen.getByText('Saoirse M.')).toBeTruthy()

    serve(LIVE)
    await nextPoll()

    expect(screen.getByText('Strap 49931')).toBeTruthy()
    expect(screen.queryByText('Saoirse M.')).toBeNull()
  })

  it('rotates on the board clock alone, with no timer of its own', async () => {
    serve(IDLE)
    mount()
    await advance(0)
    expect(screen.getByText('BU1LD — Strength')).toBeTruthy()

    // Nothing but the header's 1 Hz clock (and the poll) is running.
    await advance(SCENE_DWELL_MS)
    expect(screen.getByText('Saoirse M.')).toBeTruthy()
    expect(screen.queryByText('BU1LD — Strength')).toBeNull()

    await advance(SCENE_DWELL_MS)
    expect(screen.getByText('BU1LD — Strength')).toBeTruthy()
  })

  it('starts again at the first scene when the tiles leave, not mid-cycle', async () => {
    serve(IDLE)
    mount()
    await advance(0)
    await advance(SCENE_DWELL_MS)
    expect(screen.getByText('Saoirse M.')).toBeTruthy()

    serve(LIVE)
    await nextPoll()
    expect(screen.getByText('Strap 49931')).toBeTruthy()

    // The band drops. The board has been alive ~34s, which indexes the Earned
    // scene if the rotation were still counted from page load.
    serve(IDLE)
    await nextPoll()

    expect(screen.getByText('BU1LD — Strength')).toBeTruthy()
    expect(screen.queryByText('Saoirse M.')).toBeNull()
  })

  it('leaves the class timer in charge when one is running and nobody is strapped in', async () => {
    serve({
      ...IDLE,
      timer: {
        id: 't1',
        name: 'Intervals',
        status: 'running',
        started_at: '2026-10-16T09:59:50Z',
        paused_at: null,
        paused_accum_ms: 0,
        elapsed_offset_ms: 0,
        structure_snapshot: [{ kind: 'segment', label: 'Work block', type: 'work', seconds: 600 }],
      },
    })
    mount()
    await advance(0)

    expect(screen.getByText('Work block')).toBeTruthy()
    expect(screen.queryByText('BU1LD — Strength')).toBeNull()
  })

  it('falls back to the empty board when no scene has content', async () => {
    serve({ ...BASE, sessions: [], idle: { up_next: [], earned: [], operator: null } })
    mount()
    await advance(0)

    expect(screen.getByText('Waiting for class to start')).toBeTruthy()
  })

  it('falls back to the empty board when the payload has no idle block at all', async () => {
    serve({ ...BASE, sessions: [] })
    mount()
    await advance(0)

    expect(screen.getByText('Waiting for class to start')).toBeTruthy()
  })

  it('shows the empty board before the first poll lands', () => {
    // fetch never settles: the board has no payload yet.
    global.fetch = vi.fn(() => new Promise(() => {}))
    mount()

    expect(screen.getByText('Waiting for class to start')).toBeTruthy()
  })
})
