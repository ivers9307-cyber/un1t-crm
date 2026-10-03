// WATPLPUT.1 — which fields PUT /api/whatsapp/templates/[id] may change, and when.
//
// A WhatsApp template has two owners. Meta owns its review state (status,
// rejection reason, quality, its own id) and, once a template has been
// submitted, its name, language, category and content: changing those means a
// new review, which only POST …/[id]/resubmit (REJECTED or PAUSED) or a new
// template does. We own the picker grouping (display_group).
//
// The header media counts as content: every send attaches header_media_url
// (buildTemplateComponents in src/lib/whatsapp.js), so swapping it on a
// submitted template would silently change what every automation sends.
//
// Who writes Meta's fields: the template webhook (applyTemplateEvent in
// src/lib/whatsapp-template-events.js), GET /api/whatsapp/templates?sync=true
// and POST …/resubmit, all on the service-role client. Never the PUT: before
// WATPLPUT.1 it took `status`, so a manager could mark a REJECTED template
// APPROVED locally; every picker then offered it and every send failed at Meta.
//
// Pure (no IO, no Next imports) so the editor can ask the same question.

// Never through the PUT, in any state. The schema refuses them (400).
export const META_OWNED_FIELDS = Object.freeze(['status', 'rejection_reason', 'quality_rating', 'meta_template_id'])

// Editable only while the template has never been sent to Meta (a draft).
export const CONTENT_FIELDS = Object.freeze([
  'name', 'category', 'components', 'example_values',
  'header_media_handle', 'header_media_url', 'header_media_path',
])

// Editable in every state.
export const LOCAL_FIELDS = Object.freeze(['display_group'])

// Submitted = Meta has (or had) it: it carries Meta's id, or any status other
// than the local default 'draft'. Same reading as the editor's lock, plus the id.
export function isTemplateSubmitted(row) {
  if (!row) return false
  if (row.meta_template_id) return true
  return row.status != null && row.status !== 'draft'
}

// The CONTENT_FIELDS an update carries that the template's state forbids.
// [] = allowed. Order follows CONTENT_FIELDS, so the refusal reads the same
// whatever order the body used.
export function lockedFieldsIn(updates, row) {
  if (!isTemplateSubmitted(row)) return []
  return CONTENT_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(updates || {}, k))
}
