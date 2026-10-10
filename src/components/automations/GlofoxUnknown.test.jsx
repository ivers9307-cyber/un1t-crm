// @vitest-environment jsdom
//
// PROFILESPREAD.1 (F6) — when the automations page could not read the
// location's Glofox settings, every card must say so, never "Glofox isn't
// connected" (which sends an operator to reconnect a live integration).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import AutomationsView from './AutomationsView.jsx'
import ClassClimateCard from './ClassClimateCard.jsx'
import BathroomClimateCard from './BathroomClimateCard.jsx'

// The climate cards load their schedule + history on mount (as
// ClimateCardRunNow.test.jsx stubs them).
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, classes: [], items: [] }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const card = (status) => ({
  key: 'glofox_lead_provisioning', label: 'Auto-create leads in Glofox', description: 'd',
  supportsBackfill: true, reviewBase: '/settings/glofox-import', enabled: false, status,
})
// No tooltip may claim "not connected" either.
// W1.M3a — the not-connected copy is source-neutral now ("a membership source").
const connectTitles = () => [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).filter((t) => /Connect (Glofox|a membership source)/.test(t))

describe('AutomationsView — unknown Glofox status', () => {
  it('says it could not check, not that Glofox is disconnected; the toggle stays off', () => {
    render(<AutomationsView locationId={LOC} locationName="Studio" cards={[card({ available: false, trialConfigured: false, unknown: true })]} />)
    expect(screen.getByText(/Couldn.t check Glofox/)).toBeTruthy()
    expect(screen.queryByText(/No membership source is connected/)).toBeNull()
    expect(connectTitles()).toEqual([])
    expect(screen.getByRole('button', { name: /Turn automation on/ }).disabled).toBe(true)
  })

  // W1.M3a — "not connected" copy lives in <MembershipSourceGate> (the page
  // renders the cards only behind it), so a known-unavailable card says
  // nothing of the kind: the toggle is simply off and disabled.
  it('a known "not connected" card draws no connection line at all (the gate owns that copy)', () => {
    render(<AutomationsView locationId={LOC} locationName="Studio" cards={[card({ available: false, trialConfigured: false })]} />)
    expect(screen.queryByText(/membership source/)).toBeNull()
    expect(screen.queryByText(/isn.t connected/)).toBeNull()
    expect(screen.queryByText(/Couldn.t check Glofox/)).toBeNull()
    expect(screen.getByRole('button', { name: /Turn automation on/ }).disabled).toBe(true)
  })
})

describe.each([['ClassClimateCard', ClassClimateCard], ['BathroomClimateCard', BathroomClimateCard]])('%s — unknown Glofox status', (_n, Card) => {
  it('says it could not check, not "no membership source"', () => {
    render(<Card locationId={LOC} glofoxConnected={false} glofoxUnknown devices={[]} initialEnabled={false} initialConfig={{}} />)
    expect(screen.getByText(/Couldn.t check Glofox/)).toBeTruthy()
    expect(screen.queryByText(/No membership source with a class schedule/)).toBeNull()
    expect(connectTitles()).toEqual([])
  })

  it('without glofoxUnknown, a not-connected card draws no connection line (the gate owns that copy, W1.M3a)', () => {
    render(<Card locationId={LOC} glofoxConnected={false} devices={[]} initialEnabled={false} initialConfig={{}} />)
    expect(screen.queryByText(/membership source/)).toBeNull()
    expect(screen.queryByText(/isn.t connected/)).toBeNull()
    expect(screen.queryByText(/Couldn.t check Glofox/)).toBeNull()
    expect(screen.getByRole('button', { name: /Turn automation on/ }).disabled).toBe(true)
  })
})
