// /tv/live/[token]/challenges — W0.9a token-gated in-studio challenge TV board.
//
// ADDITIVE + opt-in. Identical to /tv/[locationId]/challenges but the page
// polls the token-gated /api/public/tv-challenges/[token] endpoint (which
// resolves the location from an opaque tv_displays.token) instead of the
// guessable location-keyed URL — the same twin /tv/live/[token] is for the
// live HR board. The existing /tv/[locationId]/challenges page is unchanged
// until the kiosks have moved (W0.9b) and the location-keyed routes go (W0.9c).
//
// Public (allow-listed under /tv/ in proxy.js). The token in the URL is the
// bearer secret — the same model as /tv/cast/[token].

import ChallengeTvClient from '../../../[locationId]/challenges/ChallengeTvClient'

export const dynamic = 'force-dynamic'

export default async function TvLiveTokenChallengesPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  const { token } = params
  // FLEET-CMD.2 — forwarded like /tv/live/[token] so a kiosk's URL shape is
  // the same for both boards. A string or nothing (a repeated param is ignored).
  const device = typeof searchParams?.device === 'string' ? searchParams.device : null
  // locationId is unused when an endpoint is supplied; pass the token through
  // as a stable key. The client polls the token endpoint and reads the studio
  // name out of the payload.
  return <ChallengeTvClient locationId={token} endpoint={`/api/public/tv-challenges/${token}`} device={device} />
}
