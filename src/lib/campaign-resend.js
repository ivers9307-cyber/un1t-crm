// CAMPAIGN-RESEND (mig 506) — auto-resend a marketing campaign to
// recipients who didn't open it.
//
// The operator opts in at compose time (resend_enabled +
// resend_wait_hours + optional resend_subject on the parent). Once the
// parent reaches status='sent' and the wait elapses, spawnDueResends
// (called from /api/cron/run-campaigns) inserts a CHILD campaigns row —
// content cloned, parent_campaign_id set, status='queued' — and clears
// the parent's flag. The child then rides the normal send state machine;
// its populate step (campaign-sender.js) resolves the parent's
// non-openers at the last moment, re-intersected with
// contact_location_audience so consent, suppression and bounces since
// the original send are honoured.
//
// Concurrency: the partial unique index campaigns_one_resend_per_parent
// is the race guard. Two overlapping cron ticks can both find the same
// due parent; exactly one child insert wins, the loser sees 23505 and
// just clears the flag too (idempotent).
//
// Marketing (broadcast) stream only — outbound has open tracking off by
// design (GDPR call 2026-08-07), so there is no non-opener set to resolve.

import { getEmailCapStatus } from './usage-caps.js'

export const RESEND_MIN_WAIT_HOURS = 1
export const RESEND_MAX_WAIT_HOURS = 168

// A "non-opener" got the email (or at least Postmark accepted it) and
// never triggered an Open. bounced/complained/failed/cancelled rows are
// not resend material; opened/clicked obviously aren't either.
export const NON_OPENER_STATUSES = ['sent', 'delivered']

const PARENT_PAGE_SIZE = 1000 // repo-wide 1k-row cap on PostgREST reads

/**
 * The subject the resend child sends with: the operator's explicit
 * resend_subject wins; otherwise the parent's EFFECTIVE subject — for
 * an A/B-tested parent that's the winning variant, not blindly subject A.
 */
export function resolveResendSubject(parent) {
  if (parent.resend_subject) return parent.resend_subject
  if (parent.ab_subject_b && parent.ab_winner === 'b') return parent.ab_subject_b
  return parent.subject
}

/**
 * True when a parent campaign is due to spawn its resend child.
 */
export function isResendDue(parent, now = new Date()) {
  if (!parent.resend_enabled) return false
  if (parent.status !== 'sent') return false
  if (parent.parent_campaign_id) return false          // no resend-of-resend chains
  if (parent.postmark_stream === 'outbound') return false // utility: no open tracking
  if (!parent.sent_at || !parent.resend_wait_hours) return false
  const dueAt = new Date(parent.sent_at).getTime() + parent.resend_wait_hours * 3_600_000
  return dueAt <= now.getTime()
}

/**
 * The child campaigns row cloned from a due parent (no insert here).
 * A/B columns are deliberately NOT cloned — a resend is a single-subject
 * send — and the resend_* flags stay off so children can't chain.
 */
export function buildResendChildRow(parent) {
  return {
    location_id: parent.location_id,
    name: `${parent.name} (resend)`,
    subject: resolveResendSubject(parent),
    preview_text: parent.preview_text,
    from_name: parent.from_name,
    from_email: parent.from_email,
    reply_to: parent.reply_to,
    html_content: parent.html_content,
    design_json: parent.design_json,
    template_id: parent.template_id,
    postmark_stream: parent.postmark_stream,
    // Informational only — the populate branch for children reads the
    // parent's non-openers, not this filter.
    audience_filter: parent.audience_filter,
    parent_campaign_id: parent.id,
    status: 'queued',
    created_by: parent.created_by,
  }
}

/**
 * Paged load of the parent's non-opener contact ids.
 * @returns {Promise<string[]>}
 */
export async function loadNonOpenerContactIds(db, parentCampaignId) {
  const ids = []
  for (let from = 0; ; from += PARENT_PAGE_SIZE) {
    const { data, error } = await db
      .from('campaign_recipients')
      .select('contact_id')
      .eq('campaign_id', parentCampaignId)
      .is('opened_at', null)
      .in('status', NON_OPENER_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PARENT_PAGE_SIZE - 1)
    if (error) throw new Error(`non-opener load failed: ${error.message}`)
    if (!data || data.length === 0) break
    ids.push(...data.map(r => r.contact_id))
    if (data.length < PARENT_PAGE_SIZE) break
  }
  return ids
}

/**
 * One pass of the resend spawner — called per run-campaigns tick,
 * before the send ticks.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {object} [opts]
 * @param {Function} [opts.getCapStatus] — injectable for tests; defaults
 *   to the org email hard-cap check (parity with the promote step: a
 *   capped org's resend is DEFERRED, not dropped).
 * @param {Date} [opts.now]
 * @returns {Promise<{ scanned: number, spawned: number, errors: Array }>}
 */
export async function spawnDueResends(db, { getCapStatus = getEmailCapStatus, now = new Date() } = {}) {
  const summary = { scanned: 0, spawned: 0, errors: [] }

  // Flagged, finished parents (idx_campaigns_resend_pending). The wait
  // arithmetic is done in JS — hours-interval comparisons are awkward in
  // PostgREST — over a bounded page: 100 simultaneously-pending resends
  // per org would already be extraordinary.
  const { data: candidates, error: scanErr } = await db
    .from('campaigns')
    .select('*')
    .eq('resend_enabled', true)
    .eq('status', 'sent')
    .is('parent_campaign_id', null)
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: true })
    .limit(100)
  if (scanErr) {
    summary.errors.push({ phase: 'scan', error: scanErr.message })
    return summary
  }

  const capByLocation = new Map()

  for (const parent of candidates || []) {
    summary.scanned++
    if (!isResendDue(parent, now)) continue

    try {
      // Org email hard cap — same deferral the scheduled-promote step
      // applies: stay flagged, retry after the cap clears. Fails open
      // inside the helper.
      if (!capByLocation.has(parent.location_id)) {
        capByLocation.set(parent.location_id, await getCapStatus({ locationId: parent.location_id }, { db }))
      }
      if (capByLocation.get(parent.location_id).capped) {
        console.warn(`[campaign-resend] parent ${parent.id} held at email hard cap (stays flagged)`)
        continue
      }

      // Nobody left to chase → consume the flag without a child.
      const { count } = await db
        .from('campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', parent.id)
        .is('opened_at', null)
        .in('status', NON_OPENER_STATUSES)
      if ((count || 0) === 0) {
        await db.from('campaigns').update({ resend_enabled: false }).eq('id', parent.id)
        continue
      }

      const { error: insertErr } = await db
        .from('campaigns')
        .insert(buildResendChildRow(parent))
        .select('id')
      if (insertErr) {
        if (insertErr.code === '23505') {
          // Another tick already spawned the child — just consume the flag.
          await db.from('campaigns').update({ resend_enabled: false }).eq('id', parent.id)
        } else {
          // Leave the flag set so the next tick retries.
          summary.errors.push({ parent_id: parent.id, error: insertErr.message })
        }
        continue
      }

      await db.from('campaigns').update({ resend_enabled: false }).eq('id', parent.id)
      summary.spawned++
    } catch (err) {
      summary.errors.push({ parent_id: parent.id, error: err?.message || String(err) })
    }
  }

  return summary
}
