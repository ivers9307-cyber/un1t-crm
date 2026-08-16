// COMMSFIX.C.5 — status chip presentation for the unified sends list.
//
// Pulled out of page.js as a plain module for two reasons: 'failed' now needs a
// style AND a reason (campaigns.last_error, mig 509), which makes it a decision
// rather than a lookup; and page.js holds JSX in a .js file, so the repo's
// node-environment vitest cannot import it to test the rendering directly.
//
// Chip recipe follows the repo convention — a light-surface chip needs the -700
// text ramp (CLAUDE.md; check:guardrails no-low-contrast-chip).

const STATUS_STYLE = {
  draft: 'bg-un1t-border/40 text-un1t-subtle',
  scheduled: 'bg-blue-500/15 text-blue-700',
  queued: 'bg-amber-500/15 text-amber-700',
  sending: 'bg-amber-500/15 text-amber-700',
  sent: 'bg-emerald-500/15 text-emerald-700',
  cancelled: 'bg-rose-500/15 text-rose-700',
  // Was missing entirely, so a dead campaign rendered in the grey 'draft'
  // style — indistinguishable from one nobody has sent yet.
  failed: 'bg-rose-500/15 text-rose-700',
}

/**
 * @param {{ status?: string, last_error?: string|null }} row
 * @returns {{ className: string, title: string|undefined }}
 */
export function sendStatusChip(row) {
  return {
    className: STATUS_STYLE[row?.status] || STATUS_STYLE.draft,
    // Shown on hover for ANY status that carries an error — a campaign is
    // still 'queued' while it retries inside the grace window, and that is
    // exactly when an operator most wants to know something is wrong.
    title: row?.last_error || undefined,
  }
}
