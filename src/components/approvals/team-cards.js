// APPROVALSQ.4 — which card renders each team-and-money provider on /approvals.
// Every card takes ({ item, providerKey, providerLabel, timezone, onDecided }).
// A provider with no entry here is link-only: render TeamLinkCard for it.
import TeamDecideCard from './TeamDecideCard'
import HostEventCard from './HostEventCard'
import ContractorInvoiceCard from './ContractorInvoiceCard'
import TimeOffCard from './TimeOffCard'
import ShiftSwapCard from './ShiftSwapCard'
import TeamLinkCard from './TeamLinkCard'

export const TEAM_CARDS = {
  fte_expenses: TeamDecideCard,
  host_events: HostEventCard,
  time_off_cancellations: TeamDecideCard,
  contractor_invoices: ContractorInvoiceCard,
  time_off: TimeOffCard,
  shift_swaps: ShiftSwapCard,
}

export { TeamLinkCard }
