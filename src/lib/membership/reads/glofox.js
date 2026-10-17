// UN1TREAD.1 — the Glofox adapter for the membership read seam.
//
// A pure pass-through. Each read forwards EVERY argument it was given to the
// existing function and returns its value (or rejection) untouched, so a
// Glofox studio's numbers cannot move because a surface now asks the seam.
// Rest-args, not named parameters, on purpose: the wrapper can then never add,
// drop or default an argument (same args, same call).
import { computeMembershipCounts } from '@/lib/membership-snapshot'
import { fetchMembershipFlows } from '@/lib/membership-flows'
import { fetchMrr, fetchGrowth, fetchEngagement } from '@shared/studio-kpis'
import { fetchRevenueMTD, fetchArrearsSummary } from '@shared/dashboard-data'

export const glofoxReads = Object.freeze({
  membershipCounts: (...args) => computeMembershipCounts(...args),
  mrr: (...args) => fetchMrr(...args),
  membershipFlows: (...args) => fetchMembershipFlows(...args),
  growth: (...args) => fetchGrowth(...args),
  engagement: (...args) => fetchEngagement(...args),
  revenueMtd: (...args) => fetchRevenueMTD(...args),
  arrears: (...args) => fetchArrearsSummary(...args),
})
