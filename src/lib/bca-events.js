// BCA submission event helpers — used by:
//   - postmark-webhook-processor.js (Tag='bca-submit' webhook events
//     update email-side metric columns)
//   - /api/public/bca/[token]/* routes (link-side events: page_view,
//     download_merged, download_file)
//
// Each helper does two things:
//   1. INSERT a row in car_bca_submission_events with full audit data
//   2. UPDATE the rollup columns on car_bca_submissions (counts +
//      first/last timestamps) so the BcaSubmitCard render doesn't
//      need to scan the events table
//
// All writes go through the service-role client (db arg). Errors are
// surfaced via the return value rather than thrown — callers stash
// the error in their own logs if needed.

// ============================================================
// Postmark-side (email metrics)
// ============================================================

/**
 * Look up the BCA submission row by Postmark message ID. Returns
 * null when no row matches — used as the "is this a BCA event?"
 * gate in the webhook processor.
 *
 * @param {SupabaseClient} db
 * @param {string} messageId
 */
export async function findBcaSubmissionByMessageId(db, messageId) {
  if (!messageId) return null
  const { data } = await db
    .from('car_bca_submissions')
    .select('id')
    .eq('postmark_message_id', messageId)
    .maybeSingle()
  return data || null
}

/**
 * Apply a single Postmark webhook payload (already tagged
 * 'bca-submit' or otherwise matched to a BCA submission) to the
 * submission's metric columns + log the event.
 *
 * @param {SupabaseClient} db
 * @param {string} submissionId
 * @param {object} body - the raw Postmark webhook JSON
 */
export async function recordBcaPostmarkEvent(db, submissionId, body) {
  const now = new Date().toISOString()
  const recordType = body?.RecordType
  const eventTypeMap = {
    Delivery: 'delivered',
    Open: 'opened',
    Click: 'clicked',
    Bounce: 'bounced',
    SpamComplaint: 'complained',
  }
  const eventType = eventTypeMap[recordType]
  if (!eventType) return { ok: false, error: `unknown_record_type:${recordType}` }

  // Insert per-event audit row first so we capture the raw payload
  // even if the rollup update partially fails.
  await db.from('car_bca_submission_events').insert({
    submission_id: submissionId,
    event_type: eventType,
    raw_payload: body,
  })

  // Rollup columns. Open/Click counters go via record_bca_event RPC
  // (atomic increment + COALESCE). Other fields are safe direct patch.
  const patch = { last_postmark_event_at: now }
  switch (recordType) {
    case 'Delivery': {
      patch.delivered_at = body.DeliveredAt || now
      patch.delivered_to = body.Recipient || null
      break
    }
    case 'Open': {
      break
    }
    case 'Click': {
      break
    }
    case 'Bounce': {
      patch.bounced_at = body.BouncedAt || now
      patch.bounce_type = body.Type || null
      patch.bounce_description = body.Description || null
      break
    }
    case 'SpamComplaint': {
      patch.complaint_at = body.BouncedAt || now
      break
    }
  }

  const { error } = await db
    .from('car_bca_submissions')
    .update(patch)
    .eq('id', submissionId)
  if (error) return { ok: false, error: error.message }

  if (recordType === 'Open' || recordType === 'Click') {
    const p_event = recordType === 'Open' ? 'open' : 'click'
    await db.rpc('record_bca_event', { p_submission_id: submissionId, p_event, p_at: body.ReceivedAt || now })
  }

  return { ok: true, eventType }
}

// ============================================================
// Link-side (public page metrics)
// ============================================================

/**
 * Record a page-view on the public /bca/<token> route.
 *
 * @param {SupabaseClient} db
 * @param {string} submissionId
 * @param {{ip?: string|null, userAgent?: string|null}} ctx
 */
export async function recordBcaPageView(db, submissionId, ctx = {}) {
  await db.from('car_bca_submission_events').insert({
    submission_id: submissionId,
    event_type: 'page_view',
    ip: ctx.ip || null,
    user_agent: ctx.userAgent || null,
  })
  await db.rpc('record_bca_event', { p_submission_id: submissionId, p_event: 'view' })
}

/**
 * Record a download — either the merged PDF or one of the individual
 * source files.
 *
 * @param {SupabaseClient} db
 * @param {string} submissionId
 * @param {{type: 'merged'|'file', slug?: string|null, ip?: string|null, userAgent?: string|null}} args
 */
export async function recordBcaDownload(db, submissionId, args = {}) {
  const isMerged = args.type === 'merged'
  await db.from('car_bca_submission_events').insert({
    submission_id: submissionId,
    event_type: isMerged ? 'download_merged' : 'download_file',
    file_slug: isMerged ? null : (args.slug || null),
    ip: args.ip || null,
    user_agent: args.userAgent || null,
  })
  if (isMerged) {
    await db.rpc('record_bca_event', { p_submission_id: submissionId, p_event: 'download_merged' })
  }
  // For individual-file downloads we don't roll up onto the submission
  // row (would add 1 column per slug); per-file counts come from a
  // GROUP BY on the events table when the operator clicks into the
  // submission. Phase 5 keeps the BcaSubmitCard rendering only the
  // aggregate; per-file drill-in is a Phase 5.x follow-up if asked.
}

/**
 * Returns per-file download counts for a submission, computed from
 * the events table. Map of slug → count. Used by the submission-row
 * renderer to label each source doc with "(downloaded Nx)".
 *
 * @param {SupabaseClient} db
 * @param {string} submissionId
 */
export async function getBcaFileDownloadCounts(db, submissionId) {
  const { data } = await db
    .from('car_bca_submission_events')
    .select('file_slug')
    .eq('submission_id', submissionId)
    .eq('event_type', 'download_file')
  const counts = {}
  for (const r of data || []) {
    if (!r.file_slug) continue
    counts[r.file_slug] = (counts[r.file_slug] || 0) + 1
  }
  return counts
}

/**
 * Extracts the client IP from a Next.js request — prefers the
 * x-forwarded-for header (Vercel sets it) and strips proxy hops.
 * Returns null when no header is present (local dev / scripts).
 */
export function getClientIp(request) {
  if (!request?.headers) return null
  const xff = request.headers.get?.('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return request.headers.get?.('x-real-ip') || null
}
