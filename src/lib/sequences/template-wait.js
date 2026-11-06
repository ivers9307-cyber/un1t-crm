// PIPEBUILD.1b — a WhatsApp step whose template Meta has not approved yet
// WAITS instead of erroring (and auto-pausing the enrolment for good), but
// never sends more than TEMPLATE_WAIT_MAX_MS after it was first due.
//
// The wait record lives on the enrolment: metadata.template_wait =
// { template_id, step_order, since } (since = ISO string). Task 3's
// onTemplateApproved queries it by metadata->template_wait->>template_id.

import { logError, logWarn } from '@/lib/log'
import { escapeLikePattern } from '@/lib/like-escape'
import { getLocationZone } from '@/lib/location-time'
import { nextAcceptableSend } from '@/lib/send-quiet-hours'
import { buildResumePatch } from '@/lib/sequences/resume'
import { CLAIM_LEASE_MS } from './claim-lease.js'
import { hasSendWindow, readQuietHours } from './send-timing.js'

export const TEMPLATE_WAIT_RETRY_MS = 60 * 60_000
export const TEMPLATE_WAIT_MAX_MS = 48 * 3_600_000
// Statuses that mean "Meta may still approve this": every other
// non-APPROVED status (REJECTED, DISABLED, …) is an operator fault.
export const TEMPLATE_WAIT_STATUSES = ['PENDING', 'IN_APPEAL', 'PAUSED']

export class TemplateNotApprovedDeferral extends Error {
  constructor({ templateId, templateName, status, stepOrder = null }) {
    super(`WhatsApp template "${templateName}" is ${status}, not APPROVED yet; waiting.`)
    this.name = 'TemplateNotApprovedDeferral'
    this.templateId = templateId
    this.templateName = templateName
    this.status = status
    this.stepOrder = stepOrder
  }
}

export function templateStamp(templateId) {
  return `[wa_tpl:${templateId}] `
}

export function templateWaitDecision({ metadata, stepOrder, templateId, now }) {
  const base = metadata && typeof metadata === 'object' ? metadata : {}
  const stored = base.template_wait
  const sameWait = stored
    && stored.template_id === templateId
    && stored.step_order === stepOrder
    && Number.isFinite(Date.parse(stored.since))
  const since = sameWait ? stored.since : now.toISOString()
  if (sameWait && now.getTime() - Date.parse(since) >= TEMPLATE_WAIT_MAX_MS) {
    return { action: 'exit' }
  }
  return {
    action: 'defer',
    nextAt: new Date(now.getTime() + TEMPLATE_WAIT_RETRY_MS).toISOString(),
    metadata: { ...base, template_wait: { template_id: templateId, step_order: stepOrder, since } },
  }
}

export function withoutTemplateWait(metadata) {
  if (!metadata || typeof metadata !== 'object' || !('template_wait' in metadata)) return null
  const { template_wait: _drop, ...rest } = metadata
  return rest
}

const PAGE = 1000
const IN_CHUNK = 200

async function pagedRows(build) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

function chunks(list) {
  const out = []
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK))
  return out
}

// Meta approved a template: wake enrolments waiting on it and resume recently
// paused ones, ONLY in sequences of the template's own studio. Never throws.
//
// PIPEBUILD.1g — WHEN they wake. The step sends on the tick that picks the row
// up, so "due now" at 22:30 would message every waiting contact at ~22:35.
// The wake instant is therefore the studio's next acceptable send time
// (nextAcceptableSend on its zone + company_settings quiet hours, the
// scheduler's SEQ-QUIET.1 fallback): now in the day, the end of quiet hours at
// night. If either read fails we wake and resume NOTHING (logWarn): the
// waiting rows keep their clamped hourly retry, which sends once the template
// reads APPROVED, and the paused ones stay paused for staff to resume.
//
// Sequences with their own send_window are left alone (counted in
// skippedWindowed, a count of SEQUENCES): the window, not quiet hours, is their
// clock, and the scheduler's retry already clamps to it; a resume here would
// put them on an unclamped time.
export async function onTemplateApproved(db, template, now = new Date()) {
  const result = { woken: 0, resumed: 0, leftPaused: 0, skippedWindowed: 0 }
  try {
    if (!template?.id || !template?.location_id) return result
    const seqRows = await pagedRows(() => db.from('email_sequences')
      .select('id, send_window').eq('location_id', template.location_id).order('id', { ascending: true }))
    const seqIds = []
    for (const r of seqRows) {
      if (hasSendWindow(r.send_window)) result.skippedWindowed += 1
      else seqIds.push(r.id)
    }
    if (seqIds.length === 0) return result

    let wakeAt
    try {
      const zone = await getLocationZone(db, template.location_id)
      const quiet = await readQuietHours(db, template.location_id)
      wakeAt = nextAcceptableSend(now, quiet, zone)
    } catch (err) {
      logWarn('template-wait', 'studio clock unreadable; nothing woken or resumed (waits keep their hourly retry)', {
        templateId: template.id, locationId: template.location_id, err: err?.message,
      })
      return result
    }
    if (!Number.isFinite(wakeAt?.getTime?.())) {
      logWarn('template-wait', 'no acceptable wake time; nothing woken or resumed', {
        templateId: template.id, locationId: template.location_id,
      })
      return result
    }
    const wakeIso = wakeAt.toISOString()
    // A row whose next_step_at is inside the claim lease has just been claimed
    // by a tick (or is about to fire): never touch it, or a second tick could
    // claim it mid-send. Every other waiting row moves to wakeIso, even one due
    // a little before it: the quiet window is contiguous and ends at wakeAt, so
    // anything between now and wakeAt is itself inside quiet hours.
    const leaseEndIso = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()
    const cutoff = new Date(now.getTime() - TEMPLATE_WAIT_MAX_MS).toISOString()
    const stamp = escapeLikePattern(templateStamp(template.id))

    for (const ids of chunks(seqIds)) {
      // Waiting (active). CAS on status so an exited row is untouched.
      const { data: woke, error: wakeErr } = await db.from('sequence_enrollments')
        .update({ next_step_at: wakeIso })
        .eq('status', 'active')
        .eq('metadata->template_wait->>template_id', String(template.id))
        .in('sequence_id', ids)
        .gt('next_step_at', leaseEndIso)
        .select('id')
      if (wakeErr) throw new Error(wakeErr.message)
      result.woken += (woke || []).length

      const paused = await pagedRows(() => db.from('sequence_enrollments')
        .select('id, last_processed_at')
        .eq('status', 'paused')
        .like('last_error', `${stamp}%`)
        .in('sequence_id', ids)
        .order('id', { ascending: true }))
      const recent = []
      for (const r of paused) {
        if (r.last_processed_at && r.last_processed_at >= cutoff) recent.push(r.id)
        else result.leftPaused += 1
      }
      for (const idChunk of chunks(recent)) {
        // CAS on status AND the stamp: a row staff resumed or re-paused for
        // another reason since the read is not this template's to resume.
        const { data: resumed, error: resumeErr } = await db.from('sequence_enrollments')
          .update(buildResumePatch(wakeAt))
          .eq('status', 'paused')
          .like('last_error', `${stamp}%`)
          .in('id', idChunk)
          .select('id')
        if (resumeErr) throw new Error(resumeErr.message)
        result.resumed += (resumed || []).length
      }
    }
  } catch (err) {
    logError('template-wait', 'onTemplateApproved failed', { templateId: template?.id, err: err?.message })
  }
  return result
}
