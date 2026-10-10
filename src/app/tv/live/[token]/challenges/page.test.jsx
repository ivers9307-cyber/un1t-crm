// W0.9a — the token-gated challenge board page: token endpoint + ?device=
// forwarded to the client (mirrors /tv/live/[token]).

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../[locationId]/challenges/ChallengeTvClient', () => ({ default: (props) => <div data-props={JSON.stringify(props)} /> }))

import TvLiveTokenChallengesPage from './page.jsx'

async function renderPage({ token = 'tok-1', searchParams = {} } = {}) {
  const el = await TvLiveTokenChallengesPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(searchParams) })
  return el.props
}

describe('/tv/live/[token]/challenges page', () => {
  it('passes the token challenges endpoint and the ?device= name to the client', async () => {
    const props = await renderPage({ searchParams: { device: 'kiosk-1' } })
    expect(props.endpoint).toBe('/api/public/tv-challenges/tok-1')
    expect(props.device).toBe('kiosk-1')
  })

  it('passes device=null when there is no ?device=', async () => {
    const props = await renderPage()
    expect(props.endpoint).toBe('/api/public/tv-challenges/tok-1')
    expect(props.device).toBeNull()
  })
})
