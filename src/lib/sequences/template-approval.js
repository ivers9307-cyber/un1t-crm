// PIPEBUILD.1a — a WhatsApp step may only go live on an APPROVED Meta template.
//
// A sequence published or activated with a PENDING / REJECTED template used to
// go live and then fail or pause at the first send, with nobody watching. This
// is the pure rule plus the one scoped read both gates share.

/**
 * @param {Array<{stepNumber:number, nodeId?:string, templateId:string}>} refs
 * @param {Array<{id:string, name?:string, status?:string}>} templates
 * @returns {Array<{code:'template_not_found'|'template_not_approved', nodeId?:string, message:string}>}
 */
export function whatsappApprovalIssues(refs, templates) {
  const byId = new Map((Array.isArray(templates) ? templates : []).map(t => [t.id, t]))
  const out = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    const withNode = (issue) => (ref.nodeId ? { ...issue, nodeId: ref.nodeId } : issue)
    const template = byId.get(ref.templateId)
    if (!template) {
      out.push(withNode({
        code: 'template_not_found',
        message: `Step ${ref.stepNumber} uses a WhatsApp template that could not be found at this studio. Pick another template.`,
      }))
      continue
    }
    const status = String(template.status || '').toUpperCase()
    if (status !== 'APPROVED') {
      out.push(withNode({
        code: 'template_not_approved',
        message: `Step ${ref.stepNumber} uses the WhatsApp template "${template.name || 'unnamed'}", which is ${status || 'not approved'} at Meta.`,
      }))
    }
  }
  return out
}

/**
 * Read the given templates, scoped to one studio. Never throws.
 * @returns {Promise<{ok:true, rows:Array}|{ok:false, error:object}>}
 */
export async function loadTemplatesForApproval(db, { locationId, templateIds }) {
  try {
    const ids = [...new Set((templateIds || []).filter(Boolean))]
    if (ids.length === 0) return { ok: true, rows: [] }
    if (!locationId) return { ok: true, rows: [] }
    const { data, error } = await db.from('whatsapp_templates')
      .select('id, name, status, components')
      .eq('location_id', locationId)
      .in('id', ids)
    if (error) return { ok: false, error }
    return { ok: true, rows: data || [] }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * PIPEBUILD.2f — the legacy steps API's gate. A LIVE (active) sequence may not
 * have a step pointed at a template that is not approved; a draft is never
 * checked. `templateRefs` are the non-null whatsapp_template_id values the
 * request sets, as { stepNumber, templateId }.
 * @returns {Promise<null|{status:number, error:string, readFailed?:object}>}
 */
export async function liveSequenceTemplateRefusal(db, { sequenceStatus, locationId, templateRefs }) {
  if (sequenceStatus !== 'active') return null
  const refs = (templateRefs || []).filter(r => r.templateId)
  if (refs.length === 0) return null
  const loaded = await loadTemplatesForApproval(db, { locationId, templateIds: refs.map(r => r.templateId) })
  if (!loaded.ok) {
    return {
      status: 503,
      error: 'Could not check the WhatsApp templates just now. The step was not saved.',
      readFailed: loaded.error,
    }
  }
  const [issue] = whatsappApprovalIssues(refs, loaded.rows)
  if (!issue) return null
  return {
    status: 400,
    error: issue.code === 'template_not_approved'
      ? `${issue.message} Use it once the template is approved.`
      : issue.message,
  }
}
