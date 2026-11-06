// PIPEBUILD.1b — a WhatsApp step whose template Meta has not approved yet
// WAITS instead of erroring (and auto-pausing the enrolment for good), but
// never sends more than TEMPLATE_WAIT_MAX_MS after it was first due.
//
// The wait record lives on the enrolment: metadata.template_wait =
// { template_id, step_order, since } (since = ISO string). Task 3's
// onTemplateApproved queries it by metadata->template_wait->>template_id.

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
