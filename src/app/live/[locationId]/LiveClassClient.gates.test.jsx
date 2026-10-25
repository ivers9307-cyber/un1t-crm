// @vitest-environment jsdom
//
// C116 GATES-2 — End all, End (per session), Pair, HR test mode and the
// Detected tab's Claim call /api/live routes that need a coach role
// (LIVE_MUTATION_ROLES) at the location. They showed to everyone who could
// open the board; the client now renders them only with `canMutate`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import LiveClassClient from './LiveClassClient.jsx'
import DetectedTab from './DetectedTab.jsx'

const LIVE = {
  ok: true,
  sessions: [{ id: 's1', contactFirstName: 'Aoife', contactName: 'Aoife B', currentBpm: 120, maxHrUsed: 190, lastSampleAt: new Date().toISOString() }],
  available_straps: [{ device_key: 'ant:12345', protocol: 'ant', name: 'Strap', lastBpm: 90 }],
  roster: [],
  occurrence: null,
  test_mode_until: null,
}
const DETECTIONS = {
  ok: true,
  detections: [{ id: 'd1', device_key: 'ant:777', protocol: 'ant', last_name: 'Walsh', linked_contact: null, live_now: false, visit_count: 2, last_bpm: null, last_seen_at: new Date().toISOString() }],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('/detections') ? DETECTIONS : LIVE),
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('LiveClassClient — mutation controls', () => {
  it('without canMutate: the board, but no End all, End, Pair or test mode (main: all shown)', async () => {
    render(<LiveClassClient locationId="loc1" locationName="Studio" canMutate={false} />)
    await screen.findByText('Aoife')
    expect(screen.queryByRole('button', { name: /End all sessions/ })).toBeNull()
    expect(screen.queryByTitle('End this session')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Pair$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /HR test mode/ })).toBeNull()
  })
  it('with canMutate: all four', async () => {
    render(<LiveClassClient locationId="loc1" locationName="Studio" canMutate />)
    await screen.findByText('Aoife')
    expect(screen.getByRole('button', { name: /End all sessions/ })).toBeTruthy()
    expect(screen.getByTitle('End this session')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Pair$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /HR test mode/ })).toBeTruthy()
  })
  it('the Detected tab gets the same flag', async () => {
    render(<LiveClassClient locationId="loc1" locationName="Studio" canMutate={false} />)
    await screen.findByText('Aoife')
    fireEvent.click(screen.getByRole('button', { name: 'Detected' }))
    await screen.findByText('Walsh')
    expect(screen.queryByRole('button', { name: /Claim/ })).toBeNull()
  })
})

// LIVE-TVBTN.1 — the "TV display" link opens /tv/live/<token>, the
// token-keyed board (W0.9c removed /tv/<locationId>). It is a staff PREVIEW:
// no ?kiosk=1 and no ?device=, so it never stamps a kiosk render heartbeat.
// Without a token there is no link at all (never a dead one).
describe('LiveClassClient — TV display link', () => {
  it('with tvToken: a new-tab link to /tv/live/<token>, with no kiosk or device params', async () => {
    render(<LiveClassClient locationId="loc1" locationName="Studio" tvToken="tok-abc" />)
    await screen.findByText('Aoife')
    const link = screen.getByRole('link', { name: /TV display/ })
    expect(link.getAttribute('href')).toBe('/tv/live/tok-abc')
    expect(link.getAttribute('href')).not.toMatch(/kiosk|device/)
    expect(link.getAttribute('target')).toBe('_blank')
  })
  it('without tvToken (the default): no link', async () => {
    render(<LiveClassClient locationId="loc1" locationName="Studio" />)
    await screen.findByText('Aoife')
    expect(screen.queryByRole('link', { name: /TV display/ })).toBeNull()
  })
  it('with tvToken null: no link', async () => {
    render(<LiveClassClient locationId="loc1" locationName="Studio" tvToken={null} />)
    await screen.findByText('Aoife')
    expect(screen.queryByRole('link', { name: /TV display/ })).toBeNull()
  })
})

describe('DetectedTab — Claim', () => {
  it('hidden without canClaim; the prop defaults to closed', async () => {
    render(<DetectedTab locationId="loc1" />)
    await screen.findByText('Walsh')
    expect(screen.queryByRole('button', { name: /Claim/ })).toBeNull()
  })
  it('shown with canClaim', async () => {
    render(<DetectedTab locationId="loc1" canClaim />)
    await screen.findByText('Walsh')
    expect(screen.getByRole('button', { name: /Claim/ })).toBeTruthy()
  })
})
