// BCA submit — per-location config helpers + template renderer.
//
// Two reads:
//   - getBcaConfig(location): merges defaults with the stored config,
//     returns null when the feature flag is off. Used everywhere the
//     UI / API needs to know "what slots, what email, what templates"
//     for this location.
//   - isBcaSubmitEnabled(location): boolean shortcut.
//
// One write helper:
//   - validateBcaConfig(input): normalises + validates an incoming
//     config payload (settings PUT). Returns { ok: true, value } or
//     { ok: false, errors: {field: msg, ...} }.
//
// Plus renderTemplate(tmpl, car) which substitutes the documented
// merge vars used in subject + body templates. Phase 2 calls this
// when building the Postmark email; Phase 1 only needs it for the
// settings page preview.
//
// IMPORTANT: feature flag pattern
//   locations.features.bca_submit (boolean) — on/off switch.
//   locations.bca_config (jsonb)            — labels + emails + templates.
//
// Kept split because the existing per-location feature gate UI
// (LocationFeatures + AdminFeatureMatrix) only knows how to render
// boolean toggles, and we don't want to teach it about nested config
// objects just for one feature. The dedicated /settings/locations/[id]/bca
// page is where the full config is edited.

export const DEFAULT_BCA_DOCUMENTS = Object.freeze([
  { slug: 'doc_01', label: 'Document 1 (placeholder)' },
  { slug: 'doc_02', label: 'Document 2 (placeholder)' },
  { slug: 'doc_03', label: 'Document 3 (placeholder)' },
  { slug: 'doc_04', label: 'Document 4 (placeholder)' },
  { slug: 'doc_05', label: 'Document 5 (placeholder)' },
  { slug: 'doc_06', label: 'Document 6 (placeholder)' },
  { slug: 'doc_07', label: 'Document 7 (placeholder)' },
  { slug: 'doc_08', label: 'Document 8 (placeholder)' },
  { slug: 'doc_09', label: 'Document 9 (placeholder)' },
  { slug: 'doc_10', label: 'Document 10 (placeholder)' },
])

export const DEFAULT_BCA_CONFIG = Object.freeze({
  send_from: '',
  send_to: '',
  subject_template: 'BCA VAT claim — {{uk_reg}} ({{vin}})',
  body_template:
    'Please find attached the 10-document pack for the UK VAT claim on {{uk_reg}}, {{make}} {{model}} {{vehicle_year}}.\n\n' +
    'Buyer: {{buyer_name}}\nXero invoice: {{xero_invoice_number}}\n\n' +
    'Thanks,\nCCF Autos',
  documents: DEFAULT_BCA_DOCUMENTS,
})

// Merge tags supported in subject_template + body_template. Anything
// not on this list passes through unchanged. Add to this list when
// extending; UI shows it as a chip list of available tags.
export const BCA_MERGE_TAGS = Object.freeze([
  'uk_reg', 'irish_reg', 'vin',
  'make', 'model', 'vehicle_year',
  'buyer_name', 'buyer_email',
  'xero_invoice_number',
])

/**
 * True iff features.bca_submit is explicitly true at the location.
 * Defensive default: missing key OR explicit false → false. (Different
 * from isFeatureEnabledAtLocation in shared/permissions.js which
 * defaults to true for absent keys — that's right for permissions
 * but wrong here. BCA is opt-in per location, not opt-out.)
 *
 * @param {{features?: object|null} | null | undefined} location
 */
export function isBcaSubmitEnabled(location) {
  return location?.features?.bca_submit === true
}

/**
 * Returns the merged BCA config for this location, or null when the
 * feature is off. Stored partial configs (e.g. operator only set the
 * emails, never edited labels) are filled in from DEFAULT_BCA_CONFIG.
 *
 * @param {{features?: object|null, bca_config?: object|null} | null} location
 * @returns {null | {send_from, send_to, subject_template, body_template, documents: Array<{slug,label}>}}
 */
export function getBcaConfig(location) {
  if (!isBcaSubmitEnabled(location)) return null
  const stored = location?.bca_config || {}
  return {
    send_from: typeof stored.send_from === 'string' ? stored.send_from : DEFAULT_BCA_CONFIG.send_from,
    send_to: typeof stored.send_to === 'string' ? stored.send_to : DEFAULT_BCA_CONFIG.send_to,
    subject_template: typeof stored.subject_template === 'string'
      ? stored.subject_template
      : DEFAULT_BCA_CONFIG.subject_template,
    body_template: typeof stored.body_template === 'string'
      ? stored.body_template
      : DEFAULT_BCA_CONFIG.body_template,
    documents: Array.isArray(stored.documents) && stored.documents.length === 10
      ? stored.documents.map((d, i) => ({
          slug: typeof d?.slug === 'string' && /^doc_\d{2}$/.test(d.slug) ? d.slug : `doc_${String(i + 1).padStart(2, '0')}`,
          label: typeof d?.label === 'string' && d.label.trim() ? d.label : DEFAULT_BCA_DOCUMENTS[i].label,
        }))
      : DEFAULT_BCA_DOCUMENTS.map(d => ({ ...d })),
  }
}

// Loose email regex — we just want a sanity check; Postmark does the
// real validation when we try to send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validates + normalises a PUT payload from the settings page.
 *
 * Required:
 *   - send_from, send_to: must look like emails
 *   - subject_template: 1..200 chars, no newlines
 *   - body_template: 1..5000 chars
 *   - documents: exactly 10 entries; each slug must match /^doc_\d{2}$/
 *     and be unique; label is required and trimmed to 1..80 chars
 *
 * @param {object} input
 * @returns {{ok: true, value: object} | {ok: false, errors: Record<string,string>}}
 */
export function validateBcaConfig(input) {
  const errors = {}
  const value = {}

  // send_from
  const sf = typeof input?.send_from === 'string' ? input.send_from.trim() : ''
  if (!sf) errors.send_from = 'Send-from address is required.'
  else if (!EMAIL_RE.test(sf)) errors.send_from = "That doesn't look like a valid email address."
  else value.send_from = sf

  // send_to
  const st = typeof input?.send_to === 'string' ? input.send_to.trim() : ''
  if (!st) errors.send_to = 'BCA recipient address is required.'
  else if (!EMAIL_RE.test(st)) errors.send_to = "That doesn't look like a valid email address."
  else value.send_to = st

  // subject_template
  const sub = typeof input?.subject_template === 'string' ? input.subject_template.trim() : ''
  if (!sub) errors.subject_template = 'Subject is required.'
  else if (sub.length > 200) errors.subject_template = 'Subject is too long (max 200 chars).'
  else if (/[\n\r]/.test(sub)) errors.subject_template = 'Subject cannot contain newlines.'
  else value.subject_template = sub

  // body_template
  const body = typeof input?.body_template === 'string' ? input.body_template : ''
  const bodyTrimmed = body.trim()
  if (!bodyTrimmed) errors.body_template = 'Body is required.'
  else if (bodyTrimmed.length > 5000) errors.body_template = 'Body is too long (max 5000 chars).'
  else value.body_template = body  // keep operator's whitespace + newlines

  // documents
  const docs = Array.isArray(input?.documents) ? input.documents : []
  if (docs.length !== 10) {
    errors.documents = 'Must have exactly 10 documents.'
  } else {
    const seenSlugs = new Set()
    const out = []
    let docError = null
    for (let i = 0; i < 10; i++) {
      const d = docs[i] || {}
      const slug = typeof d.slug === 'string' ? d.slug.trim() : ''
      const label = typeof d.label === 'string' ? d.label.trim() : ''
      if (!/^doc_\d{2}$/.test(slug)) {
        docError = `Slot ${i + 1}: invalid slug "${slug}". Slugs are managed by the system — don't edit them.`
        break
      }
      if (seenSlugs.has(slug)) {
        docError = `Slot ${i + 1}: duplicate slug "${slug}".`
        break
      }
      seenSlugs.add(slug)
      if (!label) { docError = `Slot ${i + 1}: label is required.`; break }
      if (label.length > 80) { docError = `Slot ${i + 1}: label is too long (max 80 chars).`; break }
      out.push({ slug, label })
    }
    if (docError) errors.documents = docError
    else value.documents = out
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value }
}

/**
 * Substitute {{var}} placeholders in a template with values from a
 * car-shaped object. Missing values render as empty string. Used by
 * the settings page preview and (in Phase 2) the submit endpoint.
 *
 * @param {string} tmpl
 * @param {object} car
 */
export function renderBcaTemplate(tmpl, car) {
  if (typeof tmpl !== 'string') return ''
  if (!car) return tmpl
  return tmpl.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!BCA_MERGE_TAGS.includes(key)) return match  // leave unknown tags as-is
    const v = car[key]
    return v == null ? '' : String(v)
  })
}

/**
 * Storage path conventions. Centralised so the settings page, the
 * staging endpoints, and (Phase 2) the submit endpoint all agree.
 */
export const BCA_STORAGE = Object.freeze({
  bucket: 'bca-documents',
  staging: (locationId, carId, slug, ext) => `${locationId}/${carId}/_staging/${slug}.${ext}`,
  submission: (locationId, carId, submissionId, slug, ext) => `${locationId}/${carId}/${submissionId}/${slug}.${ext}`,
  mergedPdf: (locationId, carId, submissionId) => `${locationId}/${carId}/${submissionId}/merged.pdf`,
})
