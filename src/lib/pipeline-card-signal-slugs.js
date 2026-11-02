// HATCHCARD.1 — the columns where a un1t.online board's card carries signals:
// the live funnel of both Hatch boards. Converted and the off-funnel piles do
// not (they have bought, or left). Dependency-free on purpose: DealCard (a
// client component) imports it, and pipeline-card-signals.js re-exports it, so
// the server read and the card can never disagree about the columns.
export const SIGNAL_SLUGS = new Set([
  'new_lead', 'first_class', 'second_class', 'trial_done',
  'paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done',
])
