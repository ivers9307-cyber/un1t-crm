// HUBDOOR.2 — the server gate /challenges never had.
//
// The page itself is a client component (it lists + edits challenges
// through /api/challenges), so it cannot gate itself before render. Until
// this file its ONLY access control was the load fetch's 403 handler
// calling router.replace('/') — which means an unauthorised operator got
// the shell, the hub chrome, a network round trip and then a bounce: a
// page that renders and then fails, rather than a door that was never
// there. A layout is the lightest server gate for a client page (same
// pattern as src/app/admin/layout.js) and it runs before the page.
//
// The gate is `canAdminChallenges` — the SAME predicate /api/challenges
// and /api/challenges/[id] enforce, so this withholds nothing the data
// routes would have served and grants nothing they would have refused.
//
// It redirects to '/' rather than rendering a "no access" panel to match
// the sibling gates in this hub (/pulse redirects, /bookings and /events
// redirect); /hyrox renders a panel instead, which is the outlier.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAdminChallenges } from '@/lib/challenges-access'

export const dynamic = 'force-dynamic'

export default async function ChallengesGate({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/challenges')
  if (!canAdminChallenges(user)) redirect('/')
  return children
}
