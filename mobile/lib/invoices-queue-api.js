// INV-M.1 — mobile bookkeeper-queue API. Wraps the SAME
// /api/invoices-inbox routes the web /invoices inbox uses (list +
// the queue-to-be-read call). All calls go through api()
// so Bearer auth, x-active-location, and the x-impersonate-target
// "View as user" header can't drift — do NOT hand-roll headers here.
//
// Server gates (unchanged by this file):
//   • GET list        — invoices_inbox permission at the location.
//   • bulk-queue-analysis — bookkeeper permission
//     (top-level web key; mobile mirrors it via CROSS_PLATFORM_KEYS).

import { api } from './api'
import { PENDING_STATUSES } from './invoices-queue'

/**
 * GET /api/invoices-inbox — the active location's rows still awaiting
 * bookkeeper action (same "Awaiting action" set as the web inbox).
 * @param {object} [opts]
 * @param {string} [opts.locationId] x-active-location override
 */
export function listInvoicesQueue({ locationId } = {}) {
  const params = new URLSearchParams({ status: PENDING_STATUSES.join(',') })
  return api(`/api/invoices-inbox?${params.toString()}`, { locationId })
}

/**
 * POST /api/invoices-inbox/bulk-queue-analysis — queue rows to be read.
 * Instant: the read happens in the background, so the request cannot run
 * into the phone's ~60 s fetch limit. INVMOBILE.1: the only extract call;
 * the synchronous bulk-analyse leg is gone.
 */
export function bulkQueueAnalysis(ids) {
  return api('/api/invoices-inbox/bulk-queue-analysis', { method: 'POST', body: { ids } })
}
