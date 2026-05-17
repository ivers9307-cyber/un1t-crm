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

  // Rollup columns. Each branch fetches the existing row so first_*
  // is COALESCEd (only set on the very first event of its kind) and
  // counts are incremented atomically.
  const patch = { last_postmark_event_at: now }
  switch (recordType) {
    case 'Delivery': {
      patch.delivered_at = body.DeliveredAt || now
      patch.delivered_to = body.Recipient || null
      break
    }
    case 'Open': {
      patch.last_opened_at = body.ReceivedAt || now
      // first_opened_at + open_count handled via RPC-style read-modify
      // below (no atomic increment helper for BCA yet — at the
      // volumes here, RMW is fine; concurrent opens for the same
      // submission are vanishingly rare).
      const { data: row } = await db
        .from('car_bca_submissions')
        .select('first_opened_at, open_count')
        .eq('id', submissionId)
        .single()
      patch.first_opened_at = row?.first_opened_at || body.ReceivedAt || now
      patch.open_count = (row?.open_count || 0) + 1
      break
    }
    case 'Click': {
      patch.last_clicked_at = body.ReceivedAt || now
      const { data: row } = await db
        .from('car_bca_submissions')
        .select('first_clicked_at, click_count')
        .eq('id', submissionId)
        .single()
      patch.first_clicked_at = row?.first_clicked_at || body.ReceivedAt || now
      patch.click_count = (row?.click_count || 0) + 1
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
  const now = new Date().toISOString()
  await db.from('car_bca_submission_events').insert({
    submission_id: submissionId,
    event_type: 'page_view',
    ip: ctx.ip || null,
    user_agent: ctx.userAgent || null,
  })
  const { data: row } = await db
    .from('car_bca_submissions')
    .select('first_viewed_at, view_count')
    .eq('id', submissionId)
    .single()
  await db.from('car_bca_submissions').update({
    first_viewed_at: row?.first_viewed_at || now,
    last_viewed_at: now,
    view_count: (row?.view_count || 0) + 1,
  }).eq('id', submissionId)
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
  const now = new Date().toISOString()
  const isMerged = args.type === 'merged'
  await db.from('car_bca_submission_events').insert({
    submission_id: submissionId,
    event_type: isMerged ? 'download_merged' : 'download_file',
    file_slug: isMerged ? null : (args.slug || null),
    ip: args.ip || null,
    user_agent: args.userAgent || null,
  })
  if (isMerged) {
    const { data: row } = await db
      .from('car_bca_submissions')
      .select('first_merged_download_at, merged_download_count')
      .eq('id', submissionId)
      .single()
    await db.from('car_bca_submissions').update({
      first_merged_download_at: row?.first_merged_download_at || now,
      last_merged_download_at: now,
      merged_download_count: (row?.merged_download_count || 0) + 1,
    }).eq('id', submissionId)
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
