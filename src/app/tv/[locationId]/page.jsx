// /tv/[locationId] — public in-studio TV display.
//
// No auth (allow-listed in middleware). Designed for a 1080p+ TV
// at the front of class running a kiosk browser. Polls
// /api/public/live/[locationId] every 2s and renders a big-tile
// leaderboard sorted by UN1T Points.
//
// Data exposed is narrow on purpose — first name + last initial,
// current BPM, current zone color, accumulated UN1T Points,
// running zone breakdown. No contact ids, no full names, no MACs.
//
// Layout: full-viewport black background; tiles auto-fit a grid
// based on attendee count (4-30 tiles map to 2-6 columns).

import LiveTvClient from './LiveTvClient'

export const dynamic = 'force-dynamic'

export default async function TvPage(props) {
  const params = await props.params
  const searchParams = await props.searchParams
  // FLEET-CMD.2 — un1t-pi provisions the kiosk URL with ?device=<fleet name>,
  // so the board's own poll becomes per-device proof that this screen is
  // rendering. Absent for any other viewer (a laptop, the promo TV), and the
  // API ignores anything that is not a device at this location.
  const device = typeof searchParams?.device === 'string' ? searchParams.device : null
  return <LiveTvClient locationId={params.locationId} device={device} />
}
