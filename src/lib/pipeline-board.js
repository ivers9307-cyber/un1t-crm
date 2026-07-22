// Pipeline board data helpers (FEAT-PIPELINE-LAZY.1).
//
// Shared between the server page (src/app/pipeline/page.js) and the lazy
// per-column endpoint (/api/pipeline/deals) so the initial page and every
// "Load more" page produce identical board-shaped deals: the funnel badge is
// derived server-side and the heavy recent_bookings jsonb is stripped before
// the payload leaves the server (PERF.2 discipline).

import { nextBookedClass } from '@/lib/pipeline-classifier'

// Per-column page size — the server ships this many cards per column initially
// and each "Load more" fetches another page. Replaces the old approach of
// shipping ALL open deals (≤10k) to the client.
export const PIPELINE_PAGE_SIZE = 50

// Only funnel columns 1–4 carry the next-class badge (DealCard has a matching
// set). Others get null so the board's badge-first sort never re-orders a
// column by a criterion the card doesn't render.
const BADGE_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])

// Off-funnel view keeps the lean field list (no badge, thousands of rows);
// the funnel view also needs recent_bookings to derive next_class_at.
export function pipelineContactFields(view) {
  return view === 'dormant'
    ? 'id, name, lead_source, pipeline_stage_slug, trial_credits_remaining'
    : 'id, name, lead_source, pipeline_stage_slug, trial_credits_remaining, recent_bookings'
}

export function pipelineDealSelect(view) {
  return `
    id, title, stage_id, created_at,
    contacts ( ${pipelineContactFields(view)} )
  `
}

// Map a raw deal row to a board deal: derive next_class_at for funnel columns,
// strip recent_bookings so the payload stays card-sized.
export function toBoardDeal(deal) {
  const { recent_bookings, ...contact } = deal.contacts || {}
  return {
    ...deal,
    contacts: {
      ...contact,
      next_class_at: BADGE_SLUGS.has(contact.pipeline_stage_slug)
        ? nextBookedClass(recent_bookings)
        : null,
    },
  }
}
