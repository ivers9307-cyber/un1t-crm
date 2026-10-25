// /tv/live/[token] — token-gated in-studio TV display (P0-3).
//
// THE live HR board URL since W0.9c. The page polls the token-gated
// /api/public/tv-live/[token] endpoint, which resolves the studio from an
// opaque tv_displays.token — a kiosk never names its location in the URL, so
// live HR (health) data cannot be read by guessing a location id. The old
// location-keyed /tv/[locationId] + /api/public/live/[locationId] pair was
// removed in W0.9c once every kiosk had moved (W0.9b, un1t-pi `pi prepare` /
// `pi kiosk-refresh` bake this URL).
//
// Public (allow-listed under /tv/ in proxy.js). The token in the URL is the
// bearer secret — the same model as /tv/cast/[token].

import LiveTvClient from './LiveTvClient'

export const dynamic = 'force-dynamic'

export default async function TvLiveTokenPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  const { token } = params
  // FLEET-CMD.2 / W0.9a — un1t-pi provisions the kiosk URL with
  // ?device=<fleet name>; forwarded so the board's own poll stays this
  // screen's render heartbeat. A string or nothing (a repeated param is
  // ignored).
  const device = typeof searchParams?.device === 'string' ? searchParams.device : null
  // The token is passed through as a stable key. The client polls the token
  // endpoint and reads the studio name out of the payload.
  return <LiveTvClient locationId={token} endpoint={`/api/public/tv-live/${token}`} device={device} />
}
