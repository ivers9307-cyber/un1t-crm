// W0.9a — the token-gated live board page must forward ?device= to the client
// so the kiosk's poll keeps stamping its FLEET-CMD.2 render heartbeat after it
// moves from /tv/[locationId]?device= to /tv/live/[token]?device= (W0.9b).
// Without this the token route's heartbeat support is unreachable.

import { describe, it, expect, vi } from 'vitest'

// The client pulls in next/font + browser-only hooks; the page's contract is
// only the props it hands over, so stub it and inspect the element.
vi.mock('../../[locationId]/LiveTvClient', () => ({ default: (props) => <div data-props={JSON.stringify(props)} /> }))

import TvLiveTokenPage from './page.jsx'

async function renderPage({ token = 'tok-1', searchParams = {} } = {}) {
  const el = await TvLiveTokenPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(searchParams) })
  return el.props
}

describe('/tv/live/[token] page', () => {
  it('passes the token endpoint and the ?device= name to the client', async () => {
    const props = await renderPage({ searchParams: { device: 'kiosk-1' } })
    expect(props.endpoint).toBe('/api/public/tv-live/tok-1')
    expect(props.device).toBe('kiosk-1')
  })

  it('passes device=null when there is no ?device=', async () => {
    const props = await renderPage()
    expect(props.endpoint).toBe('/api/public/tv-live/tok-1')
    expect(props.device).toBeNull()
  })

  it('ignores a repeated ?device= (array), like /tv/[locationId]', async () => {
    const props = await renderPage({ searchParams: { device: ['a', 'b'] } })
    expect(props.device).toBeNull()
  })
})
