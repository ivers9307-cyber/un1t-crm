// WATPLPUT.1 — which fields PUT /api/whatsapp/templates/[id] may change, and when.
//
// A WhatsApp template has two owners. Meta owns its review state (status,
// rejection reason, quality, its own id) and, once a template has been
// submitted, its name, language, category and content: changing those means a
// new review, which only POST …/[id]/resubmit (REJECTED or PAUSED) or a new
// template does. We own the picker grouping (display_group).
//
// One exception: the header image of an APPROVED template. A media header's
// file is supplied at SEND time (buildTemplateComponents / headerComponentFor
// in src/lib/whatsapp.js attach header_media_url as a link on every send), so
// replacing it needs no Meta review. It can be replaced, never removed: a
// media-header template sent with no media is refused by Meta.
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

// The header media columns: the review sample's handle, the file sends attach,
// and its storage path.
export const HEADER_MEDIA_FIELDS = Object.freeze(['header_media_handle', 'header_media_url', 'header_media_path'])

// Editable while the template has never been sent to Meta (a draft); the
// header media also once it is APPROVED (isHeaderMediaEditable).
export const CONTENT_FIELDS = Object.freeze([
  'name', 'category', 'components', 'example_values',
  ...HEADER_MEDIA_FIELDS,
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

// A submitted template whose header image may still be replaced: APPROVED
// only. PENDING is in review; REJECTED/PAUSED change through resubmit.
export function isHeaderMediaEditable(row) {
  return row?.status === 'APPROVED'
}

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj || {}, k)

// The CONTENT_FIELDS an update carries that the template's state forbids.
// [] = allowed. Order follows CONTENT_FIELDS, so the refusal reads the same
// whatever order the body used.
export function lockedFieldsIn(updates, row) {
  if (!isTemplateSubmitted(row)) return []
  const present = CONTENT_FIELDS.filter((k) => has(updates, k))
  if (!isHeaderMediaEditable(row)) return present
  // APPROVED: a new header file is fine; clearing the URL sends would attach is not.
  return present.filter((k) => !HEADER_MEDIA_FIELDS.includes(k) || (k === 'header_media_url' && !updates[k]))
}
