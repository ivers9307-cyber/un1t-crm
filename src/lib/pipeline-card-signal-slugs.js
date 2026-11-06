import { stageRoleOf, isLiveFunnelRole } from '../../shared/pipelines/stage-roles.js'

// HATCHCARD.1 — the columns where a un1t.online board's card carries signals:
// the live funnel of both Hatch boards. Converted and the off-funnel piles do
// not (they have bought, or left). Dependency-free on purpose: DealCard (a
// client component) imports it, and pipeline-card-signals.js re-exports it, so
// the server read and the card can never disagree about the columns.
export const SIGNAL_SLUGS = new Set([
  'new_lead', 'rebook', 'first_class', 'second_class', 'trial_done',
  'paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done',
])

// PIPEBUILD.2e — does this stage's card carry signals? A code-built board
// (board_type NULL) keeps today's slug set exactly; a configured board decides
// by what the stage MEANS (its role), so a new board's cards show signals
// without a slug edit. The server decides and hands DealCard a boolean.
export function stageShowsSignals({ board, stage }) {
  return SIGNAL_SLUGS.has(stage?.slug)
    || (board?.board_type != null && isLiveFunnelRole(stageRoleOf(stage)))
}
