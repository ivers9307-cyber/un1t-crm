// /tv/live/[token] — P0-3 token-gated in-studio TV display.
//
// ADDITIVE + opt-in. Identical to /tv/[locationId] but the page polls the
// token-gated /api/public/tv-live/[token] endpoint (which resolves the location
// from an opaque tv_displays.token) instead of the guessable location-keyed URL.
// The existing /tv/[locationId] page is unchanged and still works, so switching
// the physical studio TV to this URL is a deliberate operator step, never the
// default. See the PR notes for how to obtain a location's token + the cutover.
//
// Public (allow-listed under /tv/ in proxy.js). The token in the URL is the
// bearer secret — the same model as /tv/cast/[token].

import LiveTvClient from '../../[locationId]/LiveTvClient'

export const dynamic = 'force-dynamic'

export default async function TvLiveTokenPage(props) {
  const params = await props.params
  const { token } = params
  // locationId is unused when an endpoint is supplied; pass the token through
  // as a stable key. The client polls the token endpoint and reads the studio
  // name out of the payload.
  return <LiveTvClient locationId={token} endpoint={`/api/public/tv-live/${token}`} />
}
