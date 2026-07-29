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
    id, title, stage_id, created_at, stage_entered_at,
    contacts ( ${pipelineContactFields(view)} )
  `
}

// PIPE-AGE.1 — card-footer age labels, derived SERVER-SIDE (both the
// page and the load-more route run toBoardDeal on the server) so the
// client renders fixed strings and can't hydration-mismatch on "now".
//
// Deals created before this date are the May-2026 Glofox import; their
// created_at is the import date, not a real pipeline entry, so the
// total renders as "since May '26" instead of a fake duration.
export const PIPELINE_BACKFILL_CUTOFF = '2026-06-01'

const DAY_MS = 86400000
// Footer tone thresholds on the actionable number (days in stage, or
// in pipeline when no stage stamp exists yet): quiet < 7d, warm < 21d,
// stale beyond.
const WARM_DAYS = 7
const STALE_DAYS = 21

// Whole days between an ISO timestamp and nowMs; null on bad input.
export function ageDays(iso, nowMs) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS))
}

// 0 → 'today', 3 → '3d', 17 → '2w', 70 → '2mo'.
export function formatAge(days) {
  if (days == null) return null
  if (days < 1) return 'today'
  if (days < 7) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 30)}mo`
}

// Build the footer view-model: { stage, total, backfilled, tone }.
// stage is null until the deal's first stage move after mig 458
// stamped it; total is null only on bad data. tone drives the colour
// class in DealCard.
export function dealAge(deal, nowMs) {
  const stageDays = ageDays(deal.stage_entered_at, nowMs)
  const pipelineDays = ageDays(deal.created_at, nowMs)
  const backfilled = typeof deal.created_at === 'string' && deal.created_at < PIPELINE_BACKFILL_CUTOFF
  // The colour keys on days-in-stage when known; otherwise days in
  // pipeline — except backfilled deals, whose import-dated age would
  // false-alarm every card red.
  const toneDays = stageDays != null ? stageDays : (backfilled ? null : pipelineDays)
  const tone = toneDays == null ? 'quiet' : toneDays >= STALE_DAYS ? 'stale' : toneDays >= WARM_DAYS ? 'warm' : 'quiet'
  return {
    stage: formatAge(stageDays),
    total: backfilled ? "since May '26" : formatAge(pipelineDays),
    backfilled,
    tone,
  }
}

// Map a raw deal row to a board deal: derive next_class_at for funnel columns
// and the age footer, strip recent_bookings so the payload stays card-sized.
// Deliberately 1-arg (nowMs pinned inside): callers do `.map(toBoardDeal)`,
// and a second parameter would silently receive the array index. Tests
// inject time via dealAge directly.
export function toBoardDeal(deal) {
  const { recent_bookings, ...contact } = deal.contacts || {}
  return {
    ...deal,
    age: dealAge(deal, Date.now()),
    contacts: {
      ...contact,
      next_class_at: BADGE_SLUGS.has(contact.pipeline_stage_slug)
        ? nextBookedClass(recent_bookings)
        : null,
    },
  }
}
