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
import { fetchGlofoxActiveMemberContactIds } from '@/lib/membership/glofox-active-members'
// UN1TRADAR.1 — the radar reads load churn-radar-data / lead-radar-data at
// CALL time: those modules import the seam (reads/index → state-for-page →
// registry → this file), so a static import would close a module cycle.
const churnData = () => import('@/lib/churn-radar-data')
const leadData = () => import('@/lib/lead-radar-data')

export const glofoxReads = Object.freeze({
  membershipCounts: (...args) => computeMembershipCounts(...args),
  mrr: (...args) => fetchMrr(...args),
  membershipFlows: (...args) => fetchMembershipFlows(...args),
  growth: (...args) => fetchGrowth(...args),
  engagement: (...args) => fetchEngagement(...args),
  revenueMtd: (...args) => fetchRevenueMTD(...args),
  arrears: (...args) => fetchArrearsSummary(...args),
  // UN1TRADAR.1 — the radar row fetches: today's contacts / glofox_invoices readers
  radarMembers: async (...args) => (await churnData()).fetchMembers(...args),
  winbackContacts: async (...args) => (await churnData()).fetchWinbackContacts(...args),
  leadContacts: async (...args) => (await leadData()).fetchNonMembers(...args),
  radarPastDue: async (...args) => (await churnData()).fetchPastDue(...args),
  // PIPEEXCL.1 — active members, for other studios' acquisition boards
  activeMemberContactIds: (...args) => fetchGlofoxActiveMemberContactIds(...args),
})
