// /tv/[locationId]/challenges — public in-studio challenge TV board.
// No auth (allow-listed in middleware via /tv/ prefix). Designed for a
// 1080p+ TV in the gym lobby running a kiosk browser. Polls
// /api/public/challenges/[locationId] every 45s and rolls through the
// leaderboard 8 rows at a time (landscape) or 12 (portrait).

import ChallengeTvClient from './ChallengeTvClient'

export const dynamic = 'force-dynamic'

export default async function ChallengeTvPage(props) {
  const params = await props.params
  return <ChallengeTvClient locationId={params.locationId} />
}
