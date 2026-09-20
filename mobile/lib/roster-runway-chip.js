// RUNWAY.1 — view-model for the Studio dashboard's roster-runway chip.
//
// What the chip says, how loud it is and where it goes are decided HERE, not
// in the component: there is no React Native component test runner in this
// repo, so a decision made in JSX is a decision nobody tests. The component
// (components/dashboard/RosterRunwayChip.jsx) only draws what this returns.
//
// The copy is shared/roster-runway.js's, the same strings as the web chip and
// the push. The route is the push's own (notification-nav.js), so tapping the
// chip and tapping the notification can never land in different places.

import { rosterRunwayHeadline, rosterRunwayDetail } from 'shared/roster-runway'
import { routeForNotification } from './notification-nav'

/**
 * @param {object|null|undefined} runway  fetchRosterRunway's answer (dashboard-api.js)
 * @returns {{ tone: 'red'|'amber', title: string, detail: string, route: string } | null}
 *   null = draw nothing.
 */
export function rosterRunwayChip(runway) {
  if (!runway || typeof runway !== 'object' || !runway.weekStart) return null
  return {
    tone: runway.severity === 'red' ? 'red' : 'amber',
    title: rosterRunwayHeadline(runway),
    detail: `${rosterRunwayDetail(runway)} Tap to open that week.`,
    route: routeForNotification({ type: 'roster_runway', week_start: runway.weekStart }),
  }
}
