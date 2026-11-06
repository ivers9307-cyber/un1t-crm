// PIPEBUILD.1b — a WhatsApp step whose template Meta has not approved yet
// WAITS instead of erroring (and auto-pausing the enrolment for good), but
// never sends more than TEMPLATE_WAIT_MAX_MS after it was first due.
//
// The wait record lives on the enrolment: metadata.template_wait =
// { template_id, step_order, since } (since = ISO string). Task 3's
// onTemplateApproved queries it by metadata->template_wait->>template_id.

import { logError } from '@/lib/log'
import { escapeLikePattern } from '@/lib/like-escape'
import { buildResumePatch } from '@/lib/sequences/resume'

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
export async function onTemplateApproved(db, template, now = new Date()) {
  const result = { woken: 0, resumed: 0, leftPaused: 0 }
  try {
    if (!template?.id || !template?.location_id) return result
    const seqRows = await pagedRows(() => db.from('email_sequences')
      .select('id').eq('location_id', template.location_id).order('id', { ascending: true }))
    const seqIds = seqRows.map((r) => r.id)
    if (seqIds.length === 0) return result
    const nowIso = now.toISOString()
    const cutoff = new Date(now.getTime() - TEMPLATE_WAIT_MAX_MS).toISOString()
    const stamp = templateStamp(template.id)

    for (const ids of chunks(seqIds)) {
      // Waiting (active): due now. CAS on status so an exited row is untouched.
      const { data: woke, error: wakeErr } = await db.from('sequence_enrollments')
        .update({ next_step_at: nowIso })
        .eq('status', 'active')
        .eq('metadata->template_wait->>template_id', String(template.id))
        .in('sequence_id', ids)
        .select('id')
      if (wakeErr) throw new Error(wakeErr.message)
      result.woken += (woke || []).length

      const paused = await pagedRows(() => db.from('sequence_enrollments')
        .select('id, last_processed_at')
        .eq('status', 'paused')
        .like('last_error', `${escapeLikePattern(stamp)}%`)
        .in('sequence_id', ids)
        .order('id', { ascending: true }))
      const recent = []
      for (const r of paused) {
        if (r.last_processed_at && r.last_processed_at >= cutoff) recent.push(r.id)
        else result.leftPaused += 1
      }
      for (const idChunk of chunks(recent)) {
        const { data: resumed, error: resumeErr } = await db.from('sequence_enrollments')
          .update(buildResumePatch(now))
          .eq('status', 'paused')
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
