// /tv/live/[token]/challenges — token-gated in-studio challenge TV board (W0.9a).
//
// THE challenge board URL since W0.9c. The page polls the token-gated
// /api/public/tv-challenges/[token] endpoint, which resolves the studio from an
// opaque tv_displays.token — the same twin /tv/live/[token] is for the live HR
// board. The old location-keyed /tv/[locationId]/challenges +
// /api/public/challenges/[locationId] pair was removed in W0.9c once every
// kiosk had moved (W0.9b).
//
// Public (allow-listed under /tv/ in proxy.js). The token in the URL is the
// bearer secret — the same model as /tv/cast/[token].

import ChallengeTvClient from './ChallengeTvClient'

export const dynamic = 'force-dynamic'

export default async function TvLiveTokenChallengesPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  const { token } = params
  // FLEET-CMD.2 — forwarded like /tv/live/[token] so a kiosk's URL shape is
  // the same for both boards. A string or nothing (a repeated param is ignored).
  const device = typeof searchParams?.device === 'string' ? searchParams.device : null
  // The client polls the token endpoint and reads the studio name out of the
  // payload.
  return <ChallengeTvClient endpoint={`/api/public/tv-challenges/${token}`} device={device} />
}
