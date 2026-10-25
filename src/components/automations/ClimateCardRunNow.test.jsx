// @vitest-environment jsdom
//
// REGISTRYREAD.1b: the run-now result on both climate cards. The route
// answers glofox_settings_unreadable:true when the Glofox settings read
// failed (a DB blip), and glofox_configured:false alongside it because every
// credential field comes back null. The card must say "couldn't read", never
// "isn't connected", for that case, and keep the old line for a studio that
// really has no Glofox.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import ClassClimateCard from './ClassClimateCard.jsx'
import BathroomClimateCard from './BathroomClimateCard.jsx'

const LOC = '00000000-0000-4000-8000-000000000001'
const DEVICES = [{ id: 'dev-1', label: 'Studio AC', enabled: true }]
const UNREADABLE = /Couldn't read this studio's Glofox settings just now/
const NOT_CONNECTED = /Glofox isn't connected — no schedule to check/

function stubFetch(runNowBody) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const body = String(url).includes('/run-now')
      ? runNowBody
      : { success: true, classes: [], items: [] }
    return { ok: true, json: async () => body }
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each([
  ['ClassClimateCard', ClassClimateCard],
  ['BathroomClimateCard', BathroomClimateCard],
])('%s run-now result', (_name, Card) => {
  function renderCard() {
    render(
      <Card
        locationId={LOC}
        glofoxConnected
        devices={DEVICES}
        initialEnabled={false}
        initialConfig={{ device_ids: ['dev-1'] }}
      />,
    )
  }

  it('a failed settings read says "couldn\'t read", not "isn\'t connected"', async () => {
    stubFetch({
      success: true, glofox_configured: false, glofox_settings_unreadable: true,
      synced: null, planned: [], actions: [], errors: [],
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Run schedule check now/ }))
    expect(await screen.findByText(UNREADABLE)).toBeTruthy()
    expect(screen.queryByText(NOT_CONNECTED)).toBeNull()
  })

  it('a studio with no Glofox still says "isn\'t connected"', async () => {
    stubFetch({
      success: true, glofox_configured: false, glofox_settings_unreadable: false,
      synced: null, planned: [], actions: [], errors: [],
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Run schedule check now/ }))
    expect(await screen.findByText(NOT_CONNECTED)).toBeTruthy()
    expect(screen.queryByText(UNREADABLE)).toBeNull()
  })
})
